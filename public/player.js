import { createController } from "./control.js";

const API = "/plugins/signalk-mfd-cast";

const els = {
  frame: document.getElementById("frame"),
  stage: document.getElementById("stage"),
  video: document.getElementById("video"),
  touch: document.getElementById("touch"),
  keys: document.getElementById("keys"),
  dot: document.getElementById("dot"),
  stateLabel: document.getElementById("state-label"),
  telemetry: document.getElementById("telemetry"),
  mode: document.getElementById("mode"),
  banner: document.getElementById("banner"),
  lock: document.getElementById("lock"),
  message: document.getElementById("message"),
  messageTitle: document.getElementById("message-title"),
  messageText: document.getElementById("message-text"),
  messageActions: document.getElementById("message-actions"),
  controlButton: document.getElementById("control"),
  fullscreen: document.getElementById("fullscreen"),
  settingsButton: document.getElementById("settings-button"),
  settings: document.getElementById("settings"),
  settingsForm: document.getElementById("settings-form"),
  settingsError: document.getElementById("settings-error"),
  addressInput: document.getElementById("address-input"),
  settingsCancel: document.getElementById("settings-cancel"),
  vlc: document.getElementById("vlc"),
  toast: document.getElementById("toast"),
};

const state = {
  status: null,
  ws: null,
  pc: null,
  starting: false,
  retry: 0,
  retryTimer: null,
  owner: false,
  busy: false,
  canTouch: false,
  streamAddress: null,
  fps: 0,
  latencyMs: null,
  frameLoopStarted: false,
  errorText: null,
  toastTimer: null,
  aspectRatio: 16 / 10,
};

const controller = createController({
  layer: els.touch,
  keys: els.keys,
  canInteract: () => state.owner && state.canTouch,
  onTouch: (event) => send({ type: "touch", ...event }),
  onKey: (event) => send({ type: "key", ...event }),
  onBlocked: () => {
    if (!state.owner) toast("Pulsa «Tomar control» para interactuar con el plotter");
    else toast("El MFD no acepta toques en este momento");
  },
});

els.vlc.href = `${API}/playlist.m3u`;

/* ------------------------------------------------------------------ status */

async function fetchStatus() {
  const response = await fetch(`${API}/status`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function labelFor(status) {
  if (status.state === "ready") {
    return status.mfd.name || status.mfd.address || "MFD";
  }
  if (status.state === "needs-address") return "Sin MFD configurado";
  if (status.state === "probing") return "Detectando el MFD…";
  if (status.state === "unsupported") return "Stream no compatible";
  if (status.state === "error") return "Error";
  return status.statusMessage || "Iniciando…";
}

function setDot(kind) {
  els.dot.className = `dot${kind ? ` ${kind}` : ""}`;
}

/**
 * Sizes the video rectangle to the largest box with the stream's aspect ratio
 * that fits the stage. Keeping the box equal to the video is what makes touch
 * coordinates exact (no letterboxing inside the overlay).
 */
function layoutFrame() {
  const stage = els.stage;
  if (!stage) return;
  const maxWidth = Math.max(1, stage.clientWidth - 20);
  const maxHeight = Math.max(1, stage.clientHeight - 20);
  const ratio = state.aspectRatio || 16 / 10;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  els.frame.style.width = `${Math.floor(width)}px`;
  els.frame.style.height = `${Math.floor(height)}px`;
}

window.addEventListener("resize", layoutFrame);

function render(status) {
  const previous = state.status;
  state.status = status;

  const control = status.control || {};
  const probe = status.probe || {};
  const width = probe.width || control.width;
  const height = probe.height || control.height;
  if (width && height) {
    state.aspectRatio = width / height;
    els.frame.style.aspectRatio = `${width} / ${height}`;
  }
  layoutFrame();

  els.stateLabel.textContent = labelFor(status);
  els.mode.textContent = status.pipeline
    ? `${status.pipeline.mode} · ${status.pipeline.codecLabel}`
    : "";
  controller.setKeys(status.pipeline && status.pipeline.streamable ? control.keys : []);

  els.lock.classList.toggle("hidden", !control.locked);

  const warning =
    status.pipeline && status.pipeline.warning
      ? status.pipeline.warning
      : status.state === "error"
        ? status.error
        : null;
  els.banner.textContent = warning || "";
  els.banner.classList.toggle("hidden", !warning);
  els.banner.style.background =
    status.pipeline && status.pipeline.mode && status.pipeline.mode !== "copy"
      ? "rgba(240, 166, 58, 0.92)"
      : "rgba(229, 83, 75, 0.92)";

  if (state.owner || state.busy) {
    // keep ownership flags; they are authoritative in control messages
  } else {
    state.busy = Boolean(status.controlInUse);
  }
  updateControlButton();
  updateTelemetry();
  syncMessage();

  const addressChanged =
    !previous || previous.mfd.address !== status.mfd.address;
  if (addressChanged) {
    state.streamAddress = status.mfd.address;
    destroyPeer();
  }

  if (status.state === "ready" && status.pipeline && status.pipeline.streamable) {
    if (addressChanged || (!state.pc && !state.starting)) startVideo();
  } else if (status.state === "error" || status.state === "needs-address") {
    destroyPeer();
  }
}

function updateControlButton() {
  const control = (state.status && state.status.control) || {};
  const enabled = control.enabled !== false && control.state !== "disabled";
  els.controlButton.disabled = !enabled || (state.busy && !state.owner);
  els.controlButton.textContent = state.owner
    ? "Soltar control"
    : state.busy
      ? "Control en uso"
      : "Tomar control";
  els.controlButton.classList.toggle("active", state.owner);
  els.touch.style.cursor = state.owner && state.canTouch ? "crosshair" : "default";
}

function updateTelemetry() {
  const parts = [];
  if (state.fps > 0) parts.push(`${state.fps} fps`);
  if (state.latencyMs !== null) parts.push(`${Math.round(state.latencyMs)} ms`);
  const status = state.status;
  if (status && status.viewers) {
    parts.push(`${status.viewers} ${status.viewers === 1 ? "espectador" : "espectadores"}`);
  }
  if (status && status.control && status.control.enabled && !state.canTouch) {
    parts.push("solo ver");
  }
  els.telemetry.textContent = parts.join(" · ");
}

/* ----------------------------------------------------------------- message */

function clearActions() {
  els.messageActions.textContent = "";
}

function showMessage(title, text, actions = []) {
  els.message.classList.remove("hidden");
  els.messageTitle.textContent = title;
  els.messageText.textContent = text || "";
  clearActions();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.className = action.primary ? "primary" : "ghost";
    button.addEventListener("click", action.onClick);
    els.messageActions.appendChild(button);
  }
}

function hideMessage() {
  els.message.classList.add("hidden");
}

function hasVideo() {
  return els.video.readyState >= 2 && els.video.videoWidth > 0;
}

function syncMessage() {
  const status = state.status;
  if (!status) return;

  if (status.state === "needs-address") {
    showMessage(
      "Configura el MFD",
      "Introduce la dirección del plotter para empezar a emitir.",
      [{ label: "Añadir IP", primary: true, onClick: openSettings }]
    );
    return;
  }

  if (status.state === "error") {
    showMessage("Sin conexión con el MFD", status.error || "Error desconocido", [
      { label: "Reintentar", primary: true, onClick: reconnectPlugin },
      { label: "Configurar IP", onClick: openSettings },
    ]);
    return;
  }

  if (status.pipeline && !status.pipeline.streamable) {
    showMessage("No se puede emitir el vídeo", status.pipeline.reason, [
      {
        label: "Abrir en VLC",
        primary: true,
        onClick: () => {
          window.location.href = els.vlc.href;
        },
      },
      { label: "Reintentar", onClick: reconnectPlugin },
      { label: "Configurar IP", onClick: openSettings },
    ]);
    return;
  }

  if (status.state === "probing") {
    showMessage("Detectando el MFD…", "Comprobando el stream y el códec.");
    return;
  }

  if (hasVideo()) {
    hideMessage();
    return;
  }

  if (state.errorText) {
    showMessage("Sin vídeo", state.errorText, [
      { label: "Reintentar", primary: true, onClick: reconnectPlugin },
    ]);
    return;
  }

  if (state.starting) {
    showMessage("Conectando con el MFD…", "Vídeo reenviado sin recodificar.");
    return;
  }

  showMessage("Esperando al MFD…", "La pantalla aparecerá en cuanto el vídeo esté listo.");
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}

/* ----------------------------------------------------------------- WebRTC */

function waitForIce(pc, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function destroyPeer() {
  if (state.pc) {
    try {
      state.pc.close();
    } catch (_error) {
      // already closed
    }
    state.pc = null;
  }
  els.video.srcObject = null;
}

async function startVideo() {
  if (state.starting) return;
  const status = state.status;
  if (!status || !status.pipeline || !status.pipeline.streamable) return;
  if (state.pc) return;

  state.starting = true;
  state.errorText = null;
  setDot("warn");
  syncMessage();

  const pc = new RTCPeerConnection({ iceServers: [] });
  state.pc = pc;

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    els.video.srcObject = stream;
    if (event.receiver && "playoutDelayHint" in event.receiver) {
      try {
        event.receiver.playoutDelayHint = 0;
      } catch (_error) {
        // not supported
      }
    }
    els.video.play().catch(() => {
      // autoplay policies; the video is muted so this should not happen
    });
  };
  pc.onconnectionstatechange = () => {
    if (pc !== state.pc) return;
    if (pc.connectionState === "connected") {
      state.retry = 0;
      setDot("ok");
    }
    if (pc.connectionState === "failed") {
      scheduleRetry("No se pudo establecer la conexión WebRTC");
    }
    if (pc.connectionState === "disconnected") {
      setTimeout(() => {
        if (pc === state.pc && pc.connectionState === "disconnected") {
          scheduleRetry("Se perdió la conexión WebRTC");
        }
      }, 3000);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const response = await fetch(`${API}/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (!payload.sdp) throw new Error("el servidor devolvió un SDP vacío");

    await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
  } catch (error) {
    scheduleRetry(error.message);
  } finally {
    state.starting = false;
  }
}

function scheduleRetry(reason) {
  if (state.retryTimer) return;
  state.errorText = reason || "Error de vídeo";
  state.retry += 1;
  destroyPeer();
  setDot("error");
  syncMessage();

  const delay = Math.min(15000, 1000 * Math.pow(2, Math.max(0, state.retry - 1)));
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    refreshStatus().catch(() => {});
    startVideo();
  }, delay);
}

async function refreshStatus() {
  try {
    render(await fetchStatus());
  } catch (_error) {
    // the WebSocket is the primary channel
  }
}

async function reconnectPlugin() {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  destroyPeer();
  state.retry = 0;
  state.errorText = null;
  showMessage("Reconectando…", "Reiniciando el stream y el control.");
  try {
    const response = await fetch(`${API}/reconnect`, {
      method: "POST",
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    render(payload);
  } catch (error) {
    toast(error.message);
  }
}

/* --------------------------------------------------------------------- WS */

function send(message) {
  if (!state.ws || state.ws.readyState !== 1) return false;
  state.ws.send(JSON.stringify(message));
  return true;
}

function connectWs() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}${API}/control`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    send({ type: "hello" });
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_error) {
      return;
    }
    onWsMessage(message);
  });

  ws.addEventListener("close", () => {
    setDot("warn");
    setTimeout(connectWs, 2000);
  });
}

function onWsMessage(message) {
  if (message.type === "status" && message.data) {
    render(message.data);
    return;
  }

  if (message.type === "control") {
    state.owner = Boolean(message.owner);
    state.busy = Boolean(message.busy);
    state.canTouch = Boolean(message.canTouch);
    updateControlButton();
    updateTelemetry();
    return;
  }

  if (message.type === "lock") {
    els.lock.classList.toggle("hidden", !message.locked);
    if (message.locked) toast("El MFD ha bloqueado la pantalla");
    return;
  }

  if (message.type === "viewers") {
    if (state.status) state.status.viewers = message.count;
    updateTelemetry();
    return;
  }

  if (message.type === "pong") {
    if (typeof message.t === "number") {
      state.latencyMs = Math.max(0, performance.now() - message.t);
      updateTelemetry();
    }
    return;
  }

  if (message.type === "error") {
    toast(message.message || "Operación no disponible");
  }
}

/* ------------------------------------------------------------------- chrome */

function openSettings() {
  const status = state.status;
  els.settingsError.classList.add("hidden");
  els.addressInput.value = (status && status.mfd.address) || "";
  if (typeof els.settings.showModal === "function") els.settings.showModal();
}

els.settingsButton.addEventListener("click", openSettings);
els.settingsCancel.addEventListener("click", () => els.settings.close());

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = els.addressInput.value.trim();
  els.settingsError.classList.add("hidden");
  try {
    const response = await fetch(`${API}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ address }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    els.settings.close();
    destroyPeer();
    render(payload);
  } catch (error) {
    els.settingsError.textContent = error.message;
    els.settingsError.classList.remove("hidden");
  }
});

els.controlButton.addEventListener("click", () => {
  const message = state.owner
    ? { type: "control", action: "release" }
    : { type: "control", action: "acquire" };
  if (!send(message)) {
    toast("Sin conexión con el servidor; reintentando…");
  }
});

els.fullscreen.addEventListener("click", () => {
  const target = document.getElementById("app");
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (target.requestFullscreen) {
    target.requestFullscreen().catch(() => {});
  } else if (els.video.webkitEnterFullscreen) {
    els.video.webkitEnterFullscreen();
  }
});

els.video.addEventListener("playing", () => {
  state.errorText = null;
  setDot("ok");
  hideMessage();
  startFrameLoop();
});

els.video.addEventListener("error", () => {
  state.errorText = "El navegador no pudo reproducir el stream";
  setDot("error");
  syncMessage();
});

/* ---------------------------------------------------------------- counters */

function startFrameLoop() {
  if (state.frameLoopStarted) return;
  state.frameLoopStarted = true;
  let frames = 0;
  let since = performance.now();

  const onFrame = () => {
    frames += 1;
    const now = performance.now();
    if (now - since >= 1000) {
      state.fps = Math.round((frames * 1000) / (now - since));
      frames = 0;
      since = now;
      updateTelemetry();
    }
    if (typeof els.video.requestVideoFrameCallback === "function") {
      els.video.requestVideoFrameCallback(onFrame);
    }
  };

  if (typeof els.video.requestVideoFrameCallback === "function") {
    els.video.requestVideoFrameCallback(onFrame);
  }
}

setInterval(() => {
  if (state.ws && state.ws.readyState === 1) {
    send({ type: "ping", t: performance.now() });
  }
}, 2000);

/* -------------------------------------------------------------------- boot */

async function boot() {
  showMessage("Conectando…", "Leyendo el estado del plugin.");
  try {
    render(await fetchStatus());
  } catch (error) {
    showMessage("El plugin no responde", error.message, [
      { label: "Reintentar", primary: true, onClick: () => window.location.reload() },
    ]);
    return;
  }
  connectWs();
}

boot();
