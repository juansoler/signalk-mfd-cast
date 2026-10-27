"use strict";

/**
 * signalk-mfd-cast
 *
 * Mirrors a Navico/B&G/Simrad/Lowrance MFD screen into a browser.
 *
 * Video path:  MFD --RTSP--> go2rtc --WebRTC--> browser
 * Control:     browser --WS--> plugin --TCP 6633--> MFD
 *
 * The plugin never touches pixels. It probes the codec once, asks go2rtc to
 * forward the stream (copy) when that is possible, and refuses to transcode on
 * the CPU unless the operator explicitly allows it.
 */

const os = require("os");
const path = require("path");
const { isHost, normalizeConfig } = require("./config");
const { macForAddress, rtspUrl } = require("./mfd");
const { detectHardware, probeStream } = require("./probe");
const { MODES, choosePipeline, isCopy, isStreamable } = require("./pipelines");
const { Go2rtc, resolveBinary } = require("./go2rtc");
const { RemoteClient } = require("./remote");
const { createTemperatureReader, processStats } = require("./stats");

const PLUGIN_ID = "signalk-mfd-cast";
const STREAM_NAME = "mfd";
const WS_PATH = "/control";
const BASE_PATH = `/plugins/${PLUGIN_ID}`;
const VIEWER_PATH = `/${PLUGIN_ID}/`;

/** Test pattern used by demo mode; requires go2rtc's exec source + ffmpeg. */
const DEMO_SOURCE =
  "exec:ffmpeg -re -f lavfi -i testsrc2=size=1280x800:rate=15 " +
  "-c:v libx264 -preset ultrafast -tune zerolatency -g 15 -f mpegts -";

/** Reads the package version without failing when the file is unavailable. */
function readVersion() {
  try {
    return require("../package.json").version;
  } catch (_error) {
    return "0.0.0";
  }
}

function buildSchema() {
  return {
    type: "object",
    title: "MFD Cast",
    description:
      "Mirror a Navico MFD screen in the browser. Video is forwarded without " +
      "re-encoding when the stream is H.264; touch and key control use the MFD's " +
      "own remote protocol.",
    properties: {
      mfdAddress: {
        type: "string",
        title: "MFD IP address",
        description: "Address of the display on the boat network, e.g. 192.168.0.10",
        default: "192.168.0.10",
      },
      rtspPort: {
        type: "integer",
        title: "RTSP port",
        default: 554,
      },
      rtspPath: {
        type: "string",
        title: "RTSP path",
        default: "/screenmirror",
      },
      controlEnabled: {
        type: "boolean",
        title: "Enable touch and key control",
        description:
          "The viewer always starts in view-only mode; control must be taken explicitly.",
        default: true,
      },
      controlPort: {
        type: "integer",
        title: "Remote-control TCP port",
        default: 6633,
      },
      clientMac: {
        type: "string",
        title: "Client MAC for authentication (optional)",
        description:
          "Leave empty to use the MAC of the interface that reaches the MFD. " +
          "Format aa:bb:cc:dd:ee:ff.",
        default: "",
      },
      transcodePolicy: {
        type: "string",
        title: "Transcoding policy",
        enum: ["off", "hardware-only", "allow-software"],
        default: "hardware-only",
        description:
          "Only used when the stream is not H.264. hardware-only refuses to burn " +
          "CPU; allow-software accepts a high CPU cost.",
      },
      maxWidth: {
        type: "integer",
        title: "Maximum width when transcoding",
        description: "Only applied when a transcode is unavoidable.",
        default: 1280,
      },
      go2rtcPath: {
        type: "string",
        title: "go2rtc binary (optional)",
        description:
          "Absolute path. Empty uses <plugin data>/bin/go2rtc or the PATH.",
        default: "",
      },
      go2rtcPort: {
        type: "integer",
        title: "go2rtc API port (loopback only)",
        default: 1984,
      },
      webrtcPort: {
        type: "integer",
        title: "WebRTC media port",
        description: "UDP/TCP port used by go2rtc to send video to the browser.",
        default: 8555,
      },
      manageGo2rtc: {
        type: "boolean",
        title: "Start and stop go2rtc with the plugin",
        description:
          "Disable if you already run go2rtc as a system service on go2rtcPort.",
        default: true,
      },
      ffmpegPath: {
        type: "string",
        title: "ffmpeg path",
        default: "ffmpeg",
      },
      ffprobePath: {
        type: "string",
        title: "ffprobe path",
        default: "ffprobe",
      },
      cpuNice: {
        type: "integer",
        title: "nice priority for go2rtc (Linux)",
        default: 10,
      },
      extraSourceOptions: {
        type: "string",
        title: "Extra go2rtc source options",
        description: 'Appended to the source, e.g. "#timeout=10".',
        default: "",
      },
      demoMode: {
        type: "boolean",
        title: "Demo mode (test pattern, no MFD)",
        description:
          "Streams a generated test pattern so the installation can be checked " +
          "without a plotter. Disable it to use the real MFD.",
        default: false,
      },
    },
  };
}

function buildUiSchema() {
  return {
    mfdAddress: {
      "ui:help": "The address the GoFree Wi-Fi/Ethernet network gives the plotter.",
    },
    controlEnabled: {
      "ui:widget": "checkbox",
    },
    clientMac: {
      "ui:placeholder": "aa:bb:cc:dd:ee:ff",
    },
    transcodePolicy: {
      "ui:help":
        "leave hardware-only: it is the setting that protects the Raspberry Pi.",
    },
  };
}

function dataDir(app) {
  try {
    if (typeof app.getDataDirPath === "function") return app.getDataDirPath();
  } catch (_error) {
    // fall through
  }
  return path.join(os.homedir(), ".signalk", "plugin-config-data", PLUGIN_ID);
}

function send(ws, message) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (_error) {
    // client vanished between the check and the send
  }
}

function broadcast(state, message) {
  for (const ws of state.clients) send(ws, message);
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch (_error) {
    return null;
  }
}

function mfdDisplayName(state) {
  if (state.config.demoMode) return "Demo (testsrc)";
  const remote = state.remote && state.remote.info;
  if (remote && (remote.name || remote.model)) return remote.name || remote.model;
  return state.config.mfdAddress || "MFD";
}

module.exports = function createPlugin(app, deps = {}) {
  const probeStreamImpl = deps.probeStream || probeStream;
  const detectHardwareImpl = deps.detectHardware || detectHardware;
  const Go2rtcImpl = deps.Go2rtc || Go2rtc;
  const RemoteClientImpl = deps.RemoteClient || RemoteClient;
  const processStatsImpl = deps.processStats || processStats;
  const macResolver = deps.macForAddress || macForAddress;
  const temperature = (deps.createTemperatureReader || createTemperatureReader)();
  const version = readVersion();

  let runtime = null;

  const plugin = {
    id: PLUGIN_ID,
    name: "MFD Cast",
    description: "Mirror a Navico MFD screen in the browser (WebRTC, no transcoding)",
  };

  plugin.schema = () => buildSchema();
  plugin.uiSchema = () => buildUiSchema();

  function setStatus(state, message) {
    state.statusMessage = message;
    try {
      if (typeof app.setPluginStatus === "function") app.setPluginStatus(message);
    } catch (_error) {
      // older servers
    }
    if (typeof app.debug === "function") app.debug(message);
  }

  function setFailure(state, message) {
    state.state = "error";
    state.error = message;
    setStatus(state, message);
    try {
      if (typeof app.setPluginError === "function") app.setPluginError(message);
    } catch (_error) {
      // older servers
    }
    broadcastStatus(state);
  }

  function pipelineSummary(state) {
    const pipeline = state.pipeline;
    if (!pipeline) return null;
    return {
      mode: pipeline.mode,
      codec: pipeline.codec,
      codecLabel: pipeline.codecLabel,
      reason: pipeline.reason,
      warning: pipeline.warning || null,
      copying: isCopy(pipeline),
      streamable: isStreamable(pipeline),
    };
  }

  function currentUrl(state) {
    const config = state.config;
    if (!config.mfdAddress) return null;
    return rtspUrl({
      address: config.mfdAddress,
      port: config.rtspPort,
      path: config.rtspPath,
    });
  }

  function statusPayload(state) {
    const config = state.config;
    const url = currentUrl(state);
    const go2rtcPid = state.go2rtc ? state.go2rtc.pid : null;
    return {
      plugin: PLUGIN_ID,
      version,
      state: state.state,
      statusMessage: state.statusMessage || null,
      error: state.error || null,
      mfd: {
        address: config.mfdAddress || null,
        name: mfdDisplayName(state),
        rtspUrl: url,
      },
      pipeline: pipelineSummary(state),
      probe: state.probe
        ? {
            codec: state.probe.codec,
            codecName: state.probe.codecName,
            profile: state.probe.profile,
            width: state.probe.width,
            height: state.probe.height,
            fps: state.probe.fps,
            bitRate: state.probe.bitRate,
          }
        : null,
      hardware: state.hardware
        ? { available: state.hardware.available, detail: state.hardware.detail }
        : null,
      control: state.remote
        ? state.remote.status()
        : {
            enabled: false,
            state: "disabled",
            canTouch: false,
            keys: [],
            locked: false,
            allowedKeys: [],
          },
      viewers: state.clients.size,
      controlInUse: Boolean(state.owner),
      go2rtc: {
        managed: config.manageGo2rtc,
        running: Boolean(state.go2rtc && state.go2rtc.running),
        pid: go2rtcPid,
      },
      urls: {
        viewer: VIEWER_PATH,
        playlist: `${BASE_PATH}/playlist.m3u`,
        status: `${BASE_PATH}/status`,
      },
    };
  }

  function broadcastStatus(state) {
    broadcast(state, { type: "status", data: statusPayload(state) });
  }

  function broadcastControl(state) {
    for (const ws of state.clients) {
      send(ws, {
        type: "control",
        owner: state.owner === ws,
        busy: Boolean(state.owner && state.owner !== ws),
        canTouch: state.remote ? state.remote.canTouch : false,
      });
    }
  }

  function refreshStatus(state) {
    if (state.state === "error") return;
    if (state.state === "needs-address") {
      setStatus(state, "Esperando la dirección del MFD");
      return;
    }
    if (state.state === "ready" && state.pipeline) {
      const probe = state.probe;
      const size = probe ? ` · ${probe.width}x${probe.height}` : "";
      const name = state.config.demoMode ? "demo" : state.config.mfdAddress;
      setStatus(
        state,
        `${name} · ${state.pipeline.mode} ${state.pipeline.codecLabel}${size}`
      );
      return;
    }
    if (state.state === "unsupported" && state.pipeline) {
      setStatus(state, state.pipeline.reason);
    }
  }

  async function waitForExternal(go2rtc) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await go2rtc.request("/api/streams", { timeoutMs: 1500 });
        if (response.ok) return;
      } catch (_error) {
        // keep waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `go2rtc externo no responde en 127.0.0.1:${go2rtc.apiPort} ` +
        "(manageGo2rtc=false)"
    );
  }

  function buildRemote(state) {
    const config = state.config;
    const mac = config.clientMac || macResolver(config.mfdAddress) || null;
    const client = new RemoteClientImpl({
      host: config.mfdAddress,
      port: config.controlPort,
      clientMac: mac,
      log: (message) => {
        if (typeof app.debug === "function") app.debug(message);
      },
    });

    client.on("state", () => broadcastStatus(state));
    client.on("info", () => {
      broadcastStatus(state);
      refreshStatus(state);
    });
    client.on("session", () => broadcastStatus(state));
    client.on("lock", (lock) => {
      broadcast(state, { type: "lock", locked: lock.locked, allowedKeys: lock.allowedKeys });
      broadcastControl(state);
      broadcastStatus(state);
    });
    client.on("warning", (message) => {
      if (typeof app.debug === "function") app.debug(`remote: ${message}`);
      broadcastStatus(state);
    });
    client.on("error", () => broadcastStatus(state));

    return client;
  }

  async function init(state) {
    const config = state.config;
    state.error = null;

    if (!config.demoMode && !config.mfdAddress) {
      state.state = "needs-address";
      state.pipeline = null;
      refreshStatus(state);
      broadcastStatus(state);
      return;
    }

    if (!config.demoMode && !isHost(config.mfdAddress)) {
      throw new Error(`Dirección de MFD no válida: ${config.mfdAddress}`);
    }

    state.state = "probing";
    setStatus(
      state,
      config.demoMode
        ? "Preparando el patrón de prueba…"
        : `Detectando el MFD ${config.mfdAddress}…`
    );

    const directory = dataDir(app);
    const binary = resolveBinary({
      configured: config.go2rtcPath,
      dataDir: directory,
    });
    if (!binary) {
      throw new Error(
        "No se encontró go2rtc. Ejecuta scripts/install-go2rtc.sh o indica " +
          "la ruta en la configuración."
      );
    }

    if (config.demoMode && !config.manageGo2rtc) {
      throw new Error(
        "El modo demo necesita manageGo2rtc=true: go2rtc solo acepta fuentes " +
          "exec desde su propio fichero de configuración."
      );
    }

    if (!state.go2rtc) {
      state.go2rtc = new Go2rtcImpl({
        binary,
        dataDir: directory,
        apiPort: config.go2rtcPort,
        webrtcPort: config.webrtcPort,
        nice: config.cpuNice,
        log: (message) => {
          if (typeof app.debug === "function") app.debug(message);
        },
      });
    }

    if (typeof state.go2rtc.setConfigStreams === "function") {
      state.go2rtc.setConfigStreams(
        config.demoMode ? { [STREAM_NAME]: DEMO_SOURCE } : {}
      );
    }

    if (config.manageGo2rtc) {
      await state.go2rtc.start();
    } else {
      await waitForExternal(state.go2rtc);
    }

    if (config.demoMode) {
      state.probe = null;
      state.probeError = null;
      state.hardware = null;
      state.pipeline = {
        codec: "demo",
        codecLabel: "demo",
        mode: MODES.COPY,
        reason: "Modo demo: patrón de prueba generado localmente por ffmpeg",
        warning: "Modo demo activo: esto no es la pantalla del MFD",
        source: DEMO_SOURCE,
      };
      // The demo stream lives in go2rtc.yaml: the API refuses exec sources.
      state.state = "ready";
      refreshStatus(state);
      broadcastStatus(state);
      return;
    }

    const url = currentUrl(state);
    const probe = await probeStreamImpl({
      url,
      ffprobePath: config.ffprobePath,
      timeoutMs: 15000,
    });
    state.probe = probe.probe;
    state.probeError = probe.error;

    state.hardware = await detectHardwareImpl({ ffmpegPath: config.ffmpegPath });

    let pipeline;
    if (probe.ok) {
      pipeline = choosePipeline({
        codec: probe.probe.codec,
        hardware: state.hardware,
        policy: config.transcodePolicy,
        rtspUrl: url,
        maxWidth: config.maxWidth,
        extraSourceOptions: config.extraSourceOptions,
      });
    } else {
      // A failed probe must not block a zero-cost attempt: copying can never
      // overheat the Pi. If the codec is incompatible the UI will say so.
      pipeline = {
        codec: "unknown",
        codecLabel: "desconocido",
        mode: MODES.COPY,
        reason: `No se pudo verificar el códec (${probe.error}); se intenta copiar sin recodificar`,
        warning: "Códec no verificado. Si no se ve vídeo, revisa el diagnóstico.",
        source: `${url}${config.extraSourceOptions || ""}`,
      };
    }
    state.pipeline = pipeline;

    if (isStreamable(pipeline)) {
      await state.go2rtc.setStream(STREAM_NAME, pipeline.source);
      state.state = "ready";
    } else {
      await state.go2rtc.deleteStream(STREAM_NAME);
      state.state = "unsupported";
    }

    if (config.controlEnabled) {
      state.remote = buildRemote(state);
      state.remote.connect();
    }

    refreshStatus(state);
    broadcastControl(state);
    broadcastStatus(state);
  }

  async function reinit(state) {
    if (state.remote) {
      state.remote.stop();
      state.remote = null;
    }
    if (state.go2rtc && !state.config.demoMode) {
      await state.go2rtc.deleteStream(STREAM_NAME);
    }
    state.pipeline = null;
    state.probe = null;
    state.hardware = null;
    state.error = null;
    state.owner = null;
    await init(state);
  }

  function onMessage(state, ws, raw) {
    const message = parseJson(raw);
    if (!message || typeof message !== "object") return;

    if (message.type === "hello") {
      send(ws, { type: "status", data: statusPayload(state) });
      send(ws, {
        type: "control",
        owner: state.owner === ws,
        busy: Boolean(state.owner && state.owner !== ws),
        canTouch: state.remote ? state.remote.canTouch : false,
      });
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong", t: message.t });
      return;
    }

    if (message.type === "control") {
      if (message.action === "acquire") {
        if (state.owner && state.owner !== ws) {
          send(ws, { type: "control", owner: false, busy: true, canTouch: false });
          return;
        }
        state.owner = ws;
        broadcastControl(state);
        refreshStatus(state);
        return;
      }
      if (message.action === "release") {
        if (state.owner === ws) state.owner = null;
        broadcastControl(state);
        return;
      }
      return;
    }

    if (message.type === "touch" || message.type === "key") {
      if (state.owner !== ws) {
        send(ws, { type: "error", code: "not-owner", message: "No tienes el control" });
        return;
      }
      if (!state.remote) {
        send(ws, { type: "error", code: "control-disabled", message: "Control desactivado" });
        return;
      }

      if (message.type === "touch") {
        const sent = state.remote.touch({
          phase: message.phase,
          x: Number(message.x),
          y: Number(message.y),
          taps: Number(message.taps) || 1,
        });
        if (!sent) {
          send(ws, {
            type: "error",
            code: "touch-unavailable",
            message: state.remote.warning || "El MFD no acepta toques ahora mismo",
          });
        }
        return;
      }

      const index = Number(message.index);
      const down = state.remote.keyByIndex(index, message.state !== 0);
      if (!down) {
        send(ws, {
          type: "error",
          code: "key-unavailable",
          message: "Tecla no disponible (pantalla bloqueada o control no autenticado)",
        });
      }
    }
  }

  function onConnection(state, ws) {
    state.clients.add(ws);
    send(ws, { type: "status", data: statusPayload(state) });
    send(ws, {
      type: "control",
      owner: false,
      busy: Boolean(state.owner),
      canTouch: state.remote ? state.remote.canTouch : false,
    });
    broadcast(state, { type: "viewers", count: state.clients.size });

    ws.on("message", (raw) => onMessage(state, ws, raw));
    ws.on("close", () => {
      state.clients.delete(ws);
      if (state.owner === ws) {
        state.owner = null;
        broadcastControl(state);
      }
      broadcast(state, { type: "viewers", count: state.clients.size });
    });
    ws.on("error", () => {
      // the close handler does the cleanup
    });
  }

  function requireRuntime(res) {
    if (runtime) return runtime;
    res.status(503).json({ error: "plugin is not running" });
    return null;
  }

  plugin.registerWithRouter = (router) => {
    const readonly = typeof router.access === "function" ? router.access("readonly") : router;

    readonly.get("/status", (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      res.json(statusPayload(state));
    });

    readonly.get("/stats", async (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      const pid = state.go2rtc ? state.go2rtc.pid : null;
      const [go2rtcStats, temperatureC] = await Promise.all([
        processStatsImpl(pid),
        temperature(),
      ]);
      res.json({
        go2rtc: go2rtcStats,
        temperatureC,
        device: {
          arch: process.arch,
          platform: process.platform,
          cpus: os.cpus().length,
          loadAverage: os.loadavg(),
          node: process.version,
        },
        viewers: state.clients.size,
        copying: isCopy(state.pipeline),
      });
    });

    readonly.post("/webrtc", async (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      if (!state.go2rtc) {
        res.status(503).json({ error: "go2rtc is not running" });
        return;
      }
      if (!state.pipeline || !isStreamable(state.pipeline)) {
        res.status(409).json({
          error: state.pipeline ? state.pipeline.reason : "stream is not ready",
        });
        return;
      }

      try {
        const offer =
          req.body && typeof req.body === "object" && req.body.sdp
            ? String(req.body.sdp)
            : await readBody(req);
        if (!offer) {
          res.status(400).json({ error: "missing SDP offer" });
          return;
        }
        const answer = await state.go2rtc.webrtc(STREAM_NAME, offer);
        res.json({ type: "answer", sdp: answer });
      } catch (error) {
        if (typeof app.error === "function") app.error(`WebRTC: ${error.message}`);
        res.status(502).json({ error: error.message });
      }
    });

    readonly.post("/reconnect", async (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      try {
        await reinit(state);
        res.json(statusPayload(state));
      } catch (error) {
        setFailure(state, error.message);
        res.status(502).json({ error: error.message });
      }
    });

    readonly.get("/playlist.m3u", (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      const url = currentUrl(state);
      if (!url) {
        res.status(404).send("no MFD configured");
        return;
      }
      const name = `MFD ${state.config.mfdAddress}`;
      res
        .type("audio/x-mpegurl")
        .send(`#EXTM3U\n#EXTINF:-1,${name}\n${url}\n`);
    });

    router.post("/select", async (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      const address = String((req.body && req.body.address) || "").trim();
      if (!isHost(address)) {
        res.status(400).json({ error: "invalid MFD address" });
        return;
      }
      state.config = { ...state.config, mfdAddress: address, demoMode: false };
      try {
        await reinit(state);
        res.json(statusPayload(state));
      } catch (error) {
        setFailure(state, error.message);
        res.status(502).json({ error: error.message });
      }
    });

    router.get("/diagnostics", async (req, res) => {
      const state = requireRuntime(res);
      if (!state) return;
      res.json({
        plugin: { id: PLUGIN_ID, version },
        platform: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cpus: os.cpus().length,
        },
        config: {
          ...state.config,
          clientMac: state.config.clientMac ? "set" : null,
        },
        probe: state.probe,
        probeError: state.probeError || null,
        hardware: state.hardware,
        pipeline: pipelineSummary(state),
        go2rtc: state.go2rtc
          ? {
              binary: state.go2rtc.binary,
              running: state.go2rtc.running,
              pid: state.go2rtc.pid,
              endpoint: state.go2rtc.endpoint,
              webrtcPort: state.go2rtc.webrtcPort,
              log: state.go2rtc.logTail(30),
            }
          : null,
        remote: state.remote ? state.remote.status() : null,
      });
    });
  };

  function readBody(req) {
    if (typeof req.body === "string" && req.body) return Promise.resolve(req.body);
    return new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1024 * 1024) {
          reject(new Error("SDP offer too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  plugin.start = function (options) {
    const config = normalizeConfig(options);
    if (runtime) {
      // Safety net: the server normally calls stop() before start().
      plugin.stop();
    }

    const state = {
      config,
      state: "starting",
      statusMessage: null,
      error: null,
      probe: null,
      probeError: null,
      hardware: null,
      pipeline: null,
      go2rtc: null,
      remote: null,
      wss: null,
      clients: new Set(),
      owner: null,
      startedAt: Date.now(),
    };
    runtime = state;

    if (typeof app.debug === "function") app.debug("starting MFD Cast");

    if (typeof app.registerWebSocket === "function") {
      try {
        const wss = app.registerWebSocket(WS_PATH);
        state.wss = wss;
        wss.on("connection", (ws) => onConnection(state, ws));
        wss.on("error", (error) => {
          if (typeof app.error === "function") app.error(`WebSocket: ${error.message}`);
        });
      } catch (error) {
        if (typeof app.error === "function") {
          app.error(`No se pudo registrar el WebSocket: ${error.message}`);
        }
      }
    } else if (typeof app.error === "function") {
      app.error(
        "Este Signal K no soporta app.registerWebSocket(); el control táctil no " +
          "estará disponible. Actualiza signalk-server."
      );
    }

    init(state).catch((error) => {
      if (state.state === "stopped") return;
      setFailure(state, error.message);
      if (state.go2rtc) state.go2rtc.stop();
    });
  };

  plugin.stop = function () {
    const state = runtime;
    runtime = null;
    if (!state) return undefined;

    state.state = "stopped";
    if (typeof app.debug === "function") app.debug("stopping MFD Cast");

    for (const ws of state.clients) {
      try {
        ws.close();
      } catch (_error) {
        // already closed
      }
    }
    state.clients.clear();

    if (state.remote) state.remote.stop();

    const go2rtc = state.go2rtc;
    state.go2rtc = null;
    return go2rtc ? go2rtc.stop() : undefined;
  };

  return plugin;
};
