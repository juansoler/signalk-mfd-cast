"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createPlugin = require("../plugin/index");

const H264_PROBE = {
  ok: true,
  probe: {
    codec: "h264",
    codecName: "h264",
    profile: "Main",
    width: 1280,
    height: 800,
    fps: 30,
    bitRate: 4000000,
  },
  error: null,
};

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

class FakeRemote extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.stopped = false;
    this.info = { model: "NSS12 evo2", name: "Helm", width: 1280, height: 800 };
  }

  get canTouch() {
    return true;
  }

  connect() {
    this.emit("state", "ready");
  }

  stop() {
    this.stopped = true;
  }

  status() {
    return {
      enabled: true,
      state: "ready",
      connected: true,
      model: "NSS12 evo2",
      name: "Helm",
      firmware: "1.0",
      width: 1280,
      height: 800,
      canTouch: true,
      authed: true,
      locked: false,
      allowedKeys: [],
      keys: [{ index: 0, code: 1, translation: 1, label: "Pages" }],
      warning: null,
      error: null,
    };
  }

  touch() {
    return true;
  }

  keyByIndex() {
    return true;
  }

  translationForIndex() {
    return 1;
  }
}

function fakeGo2rtc(instances) {
  return class FakeGo2rtc {
    constructor(options) {
      this.options = options;
      this.binary = options.binary;
      this.apiPort = options.apiPort;
      this.webrtcPort = options.webrtcPort;
      this.endpoint = `http://127.0.0.1:${options.apiPort}`;
      this.streams = {};
      this.configStreams = {};
      this.running = false;
      this.pid = 4242;
      this.stopped = false;
      instances.push(this);
    }

    setConfigStreams(streams) {
      this.configStreams = { ...streams };
    }

    async start() {
      this.running = true;
      return this;
    }

    async stop() {
      this.running = false;
      this.stopped = true;
    }

    async setStream(name, source) {
      this.streams[name] = source;
    }

    async deleteStream(name) {
      delete this.streams[name];
    }

    async webrtc(name, sdp) {
      this.lastOffer = sdp;
      return "v=0\r\nanswer";
    }

    logTail() {
      return ["[out] ready"];
    }
  };
}

function createApp(dataDir) {
  const app = {
    statusMessages: [],
    errors: [],
    wsServers: [],
    debug() {},
    error(message) {
      app.errors.push(String(message));
    },
    setPluginStatus(message) {
      app.statusMessages.push(String(message));
    },
    setPluginError(message) {
      app.errors.push(String(message));
    },
    getDataDirPath() {
      return dataDir;
    },
    registerWebSocket(pathname) {
      const wss = new EventEmitter();
      wss.clients = new Set();
      wss.pathname = pathname;
      app.wsServers.push(wss);
      return wss;
    },
  };
  return app;
}

function createRouter() {
  const routes = { get: {}, post: {} };
  const register = (method) => (pathname, handler) => {
    routes[method][pathname] = handler;
  };
  const router = {
    get: register("get"),
    post: register("post"),
    access() {
      return router;
    },
  };
  return { router, routes };
}

function request(handler, { body } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      body,
      setEncoding() {},
      on() {},
      destroy() {},
    };
    const res = {
      statusCode: 200,
      payload: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.payload = data;
        resolve(this);
        return this;
      },
      send(data) {
        this.payload = data;
        resolve(this);
        return this;
      },
      type() {
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for plugin state");
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfdcast-plugin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, { probe = H264_PROBE, hardware = { available: false, detail: "no" }, ...options } = {}) {
  const dir = tempDir(t);
  const app = createApp(dir);
  const instances = [];
  const plugin = createPlugin(app, {
    probeStream: async () => probe,
    detectHardware: async () => hardware,
    Go2rtc: fakeGo2rtc(instances),
    RemoteClient: FakeRemote,
    processStats: async () => ({ pid: 4242, cpuPercent: 3.2, rssBytes: 20 * 1024 * 1024 }),
    createTemperatureReader: () => async () => 47.5,
    macForAddress: () => "aa:bb:cc:dd:ee:ff",
  });
  const { router, routes } = createRouter();
  plugin.registerWithRouter(router);
  t.after(() => plugin.stop());
  return { app, plugin, instances, routes, options };
}

const getStatus = async (routes) => (await request(routes.get["/status"])).payload;

test("the schema describes the options the plugin actually reads", (t) => {
  const { plugin } = setup(t);
  const schema = plugin.schema();
  assert.equal(plugin.id, "signalk-mfd-cast");
  assert.equal(schema.type, "object");
  for (const key of [
    "mfdAddress",
    "rtspPort",
    "rtspPath",
    "controlPort",
    "controlEnabled",
    "clientMac",
    "transcodePolicy",
    "go2rtcPath",
    "go2rtcPort",
    "webrtcPort",
    "manageGo2rtc",
    "ffmpegPath",
    "ffprobePath",
    "cpuNice",
    "maxWidth",
    "demoMode",
  ]) {
    assert.ok(schema.properties[key], `missing schema property ${key}`);
  }
  assert.ok(plugin.uiSchema());
});

test("routes answer 503 before the plugin is started", async (t) => {
  const { routes } = setup(t);
  const response = await request(routes.get["/status"]);
  assert.equal(response.statusCode, 503);
});

test("without an MFD address the plugin waits instead of spawning processes", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ mfdAddress: "" });

  await waitFor(async () => (await getStatus(routes)).state === "needs-address");
  const status = await getStatus(routes);
  assert.equal(status.mfd.address, null);
  assert.equal(status.pipeline, null);
  assert.equal(status.control.enabled, false);
  assert.equal(instances.length, 0);
});

test("an H.264 stream is forwarded without transcoding", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });

  await waitFor(async () => (await getStatus(routes)).state === "ready");
  const status = await getStatus(routes);

  assert.equal(status.pipeline.mode, "copy");
  assert.equal(status.pipeline.copying, true);
  assert.equal(status.pipeline.streamable, true);
  assert.equal(status.probe.codec, "h264");
  assert.equal(status.mfd.rtspUrl, "rtsp://192.168.0.10:554/screenmirror");
  assert.equal(instances.length, 1);
  assert.equal(instances[0].streams.mfd, "rtsp://192.168.0.10:554/screenmirror");
  assert.equal(instances[0].running, true);
});

test("demo mode streams a test pattern without an MFD", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ demoMode: true, go2rtcPath: "go2rtc" });

  await waitFor(async () => (await getStatus(routes)).state === "ready");
  const status = await getStatus(routes);

  assert.equal(status.pipeline.codec, "demo");
  assert.equal(status.pipeline.streamable, true);
  assert.equal(status.mfd.name, "Demo (testsrc)");
  assert.equal(status.control.enabled, false);
  assert.match(instances[0].configStreams.mfd, /^exec:ffmpeg /);
  assert.match(instances[0].configStreams.mfd, /testsrc2=size=1280x800/);
});

test("select leaves demo mode and targets the real MFD", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ demoMode: true, go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const response = await request(routes.post["/select"], { body: { address: "192.168.0.10" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.mfd.address, "192.168.0.10");
  assert.equal(instances[0].streams.mfd, "rtsp://192.168.0.10:554/screenmirror");
});

test("a failed probe still attempts a zero-cost copy", async (t) => {
  const { plugin, instances, routes } = setup(t, {
    probe: { ok: false, probe: null, error: "timeout" },
  });
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });

  await waitFor(async () => (await getStatus(routes)).state === "ready");
  const status = await getStatus(routes);
  assert.equal(status.pipeline.mode, "copy");
  assert.equal(status.pipeline.codec, "unknown");
  assert.match(status.pipeline.warning, /no verificado/i);
  assert.equal(instances[0].streams.mfd, "rtsp://192.168.0.10:554/screenmirror");
});

test("a non-H.264 stream without hardware support is refused", async (t) => {
  const { plugin, instances, routes } = setup(t, {
    probe: {
      ok: true,
      probe: { codec: "mpeg2", codecName: "mpeg2video", width: 1280, height: 800 },
      error: null,
    },
  });
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });

  await waitFor(async () => (await getStatus(routes)).state === "unsupported");
  const status = await getStatus(routes);
  assert.equal(status.pipeline.mode, "unsupported");
  assert.equal(status.pipeline.streamable, false);
  assert.equal(instances[0].streams.mfd, undefined);
});

test("a non-H.264 stream uses the hardware encoder when available", async (t) => {
  const { plugin, instances, routes } = setup(t, {
    probe: {
      ok: true,
      probe: { codec: "mpeg2", codecName: "mpeg2video", width: 1280, height: 800 },
      error: null,
    },
    hardware: { available: true, detail: "ok" },
  });
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc", maxWidth: 960 });

  await waitFor(async () => (await getStatus(routes)).state === "ready");
  const status = await getStatus(routes);
  assert.equal(status.pipeline.mode, "transcode-hardware");
  assert.match(instances[0].streams.mfd, /^ffmpeg:rtsp:\/\/192\.168\.0\.10/);
  assert.match(instances[0].streams.mfd, /#video=h264#hardware#width=960$/);
});

test("the WebRTC route proxies the SDP exchange to go2rtc", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const response = await request(routes.post["/webrtc"], {
    body: { type: "offer", sdp: "v=0\r\noffer" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.type, "answer");
  assert.equal(response.payload.sdp, "v=0\r\nanswer");
  assert.equal(instances[0].lastOffer, "v=0\r\noffer");
});

test("select validates the address and re-targets the stream", async (t) => {
  const { plugin, instances, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const invalid = await request(routes.post["/select"], { body: { address: "not an ip" } });
  assert.equal(invalid.statusCode, 400);

  const valid = await request(routes.post["/select"], { body: { address: "192.168.0.99" } });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.payload.mfd.address, "192.168.0.99");
  assert.equal(instances[0].streams.mfd, "rtsp://192.168.0.99:554/screenmirror");
});

test("the playlist exposes the raw RTSP URL for VLC", async (t) => {
  const { plugin, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const response = await request(routes.get["/playlist.m3u"]);
  assert.match(String(response.payload), /#EXTM3U/);
  assert.match(String(response.payload), /rtsp:\/\/192\.168\.0\.10:554\/screenmirror/);
});

test("stats reports the go2rtc process and whether video is being copied", async (t) => {
  const { plugin, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const response = await request(routes.get["/stats"]);
  assert.equal(response.payload.go2rtc.cpuPercent, 3.2);
  assert.equal(response.payload.temperatureC, 47.5);
  assert.equal(response.payload.copying, true);
});

test("diagnostics never exposes the client MAC", async (t) => {
  const { plugin, routes } = setup(t);
  plugin.start({
    mfdAddress: "192.168.0.10",
    clientMac: "aa:bb:cc:dd:ee:ff",
    go2rtcPath: "go2rtc",
  });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const response = await request(routes.get["/diagnostics"]);
  assert.equal(response.payload.config.clientMac, "set");
  assert.equal(response.payload.pipeline.mode, "copy");
  assert.ok(Array.isArray(response.payload.go2rtc.log));
});

test("the WebSocket carries status, latency probes and exclusive control", async (t) => {
  const { plugin, app, routes } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const wss = app.wsServers[0];
  assert.equal(wss.pathname, "/control");

  const ws1 = new FakeWs();
  const ws2 = new FakeWs();
  wss.emit("connection", ws1);
  wss.emit("connection", ws2);

  assert.equal(ws1.sent[0].type, "status");
  assert.equal(ws1.sent[0].data.pipeline.mode, "copy");

  ws1.emit("message", JSON.stringify({ type: "ping", t: 42 }));
  assert.deepEqual(ws1.sent.at(-1), { type: "pong", t: 42 });

  ws1.emit("message", JSON.stringify({ type: "control", action: "acquire" }));
  assert.equal(ws1.sent.filter((m) => m.type === "control").at(-1).owner, true);

  ws2.emit("message", JSON.stringify({ type: "control", action: "acquire" }));
  assert.equal(ws2.sent.filter((m) => m.type === "control").at(-1).busy, true);

  ws2.emit("message", JSON.stringify({ type: "touch", phase: "press", x: 0.5, y: 0.5 }));
  assert.equal(ws2.sent.at(-1).code, "not-owner");

  ws1.emit("message", JSON.stringify({ type: "touch", phase: "press", x: 0.5, y: 0.5 }));
  assert.ok(!ws1.sent.some((m) => m.type === "error"));
});

test("stop tears everything down and the routes go back to 503", async (t) => {
  const { plugin, instances, routes, app } = setup(t);
  plugin.start({ mfdAddress: "192.168.0.10", go2rtcPath: "go2rtc" });
  await waitFor(async () => (await getStatus(routes)).state === "ready");

  const ws = new FakeWs();
  app.wsServers[0].emit("connection", ws);
  plugin.stop();

  assert.equal(ws.readyState, 3);
  assert.equal(instances[0].stopped, true);
  const response = await request(routes.get["/status"]);
  assert.equal(response.statusCode, 503);
});

test("registerWithRouter works on servers without access()", (t) => {
  const { plugin } = setup(t);
  const paths = [];
  plugin.registerWithRouter({
    get: (pathname) => paths.push(pathname),
    post: (pathname) => paths.push(pathname),
  });
  assert.ok(paths.includes("/status"));
  assert.ok(paths.includes("/webrtc"));
});
