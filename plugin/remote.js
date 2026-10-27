"use strict";

/**
 * Navico MFD remote protocol client (TCP 6633).
 *
 * Frame layout (big endian):
 *
 *   +--------+--------+--------+--------+------------------+
 *   | len hi | len lo | cmd hi | cmd lo | payload (len-2)  |
 *   +--------+--------+--------+--------+------------------+
 *
 * `len` counts the command field plus the payload. The constants below are
 * data, not instructions.
 */

const { EventEmitter } = require("events");
const net = require("net");

const COMMANDS = Object.freeze({
  PING: 0x0001,
  PONG: 0x0002,
  AUTHENTICATE: 0x0003,
  SESSION: 0x0004,
  LOCK: 0x0006,
  TOUCH: 0x1001,
  KEY: 0x1003,
});

const TOUCH_TYPES = Object.freeze({
  PRESS: 0,
  MOVE: 1,
  RELEASE: 2,
  CANCEL: 4,
});

const TOUCH_PHASES = Object.freeze({
  press: TOUCH_TYPES.PRESS,
  move: TOUCH_TYPES.MOVE,
  release: TOUCH_TYPES.RELEASE,
  cancel: TOUCH_TYPES.CANCEL,
});

const KEY_LABELS = Object.freeze({
  1: "Pages",
  2: "Menu",
  3: "Zoom +",
  4: "Zoom -",
  5: "Power",
  6: "Waypoint",
  7: "Enter",
  8: "Cancel",
  9: "MOB",
  10: "Go To",
  11: "Mark",
});

const MODELS = Object.freeze({
  PING: "PING",
  PONG: "PONG",
  AUTHENTICATE: "AUTHENTICATE",
  SESSION: "SESSION",
  LOCK: "LOCK",
  TOUCH: "TOUCH",
  KEY: "KEY",
});

function commandName(cmd) {
  return MODELS[Object.keys(COMMANDS).find((key) => COMMANDS[key] === cmd)] || `0x${cmd.toString(16)}`;
}

function encodeFrame(cmd, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 510) throw new Error("payload too large for one frame");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt16BE(2 + body.length, 0);
  frame.writeUInt16BE(cmd & 0xffff, 2);
  body.copy(frame, 4);
  return frame;
}

/**
 * Incremental frame parser.
 *
 * A corrupt length byte is recovered by dropping one byte at a time; the 1000 ms
 * reset rule of the original client is left to TCP + reconnect instead.
 */
function createParser(onFrame, { maxFrame = 4096 } = {}) {
  let buffer = Buffer.alloc(0);

  return function push(chunk) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const length = buffer.readUInt16BE(0);
      if (length < 2 || length > maxFrame) {
        buffer = buffer.subarray(1);
        continue;
      }
      if (buffer.length < 2 + length) break;
      const cmd = buffer.readUInt16BE(2);
      const payload = buffer.subarray(4, 2 + length);
      buffer = buffer.subarray(2 + length);
      onFrame(cmd, payload);
    }

    if (buffer.length > maxFrame) buffer = Buffer.alloc(0);
  };
}

function paddedString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  const end = nul >= 0 ? nul : slice.length;
  return slice.subarray(0, end).toString("utf8").trim();
}

function parsePong(payload) {
  if (!payload || payload.length < 101) return null;
  const pingId = payload.readUInt32BE(0);
  const version = payload.readUInt8(4);
  const model = paddedString(payload, 5, 32);
  const name = paddedString(payload, 37, 32);
  const firmware = paddedString(payload, 69, 16);
  const capabilities = payload.readUInt32BE(85);
  const keyCount = payload.readUInt32BE(89);

  const tail = 93 + keyCount * 8;
  if (keyCount > 64 || payload.length < tail + 8) return null;

  const keys = [];
  for (let index = 0; index < keyCount; index++) {
    const offset = 93 + index * 8;
    keys.push({
      code: payload.readUInt32BE(offset),
      translation: payload.readUInt32BE(offset + 4),
    });
  }

  return {
    pingId,
    version,
    model,
    name,
    firmware,
    capabilities,
    keys,
    width: payload.readUInt16BE(tail),
    height: payload.readUInt16BE(tail + 2),
    widthMm: payload.readUInt16BE(tail + 4),
    heightMm: payload.readUInt16BE(tail + 6),
    noAuth: (capabilities & 0x01) !== 0,
    noTouch: (capabilities & 0x10) !== 0,
  };
}

function parseSession(payload) {
  if (!payload || payload.length < 7) return null;
  const mac = Array.from(payload.subarray(0, 6))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
  return { mac, authed: payload[6] === 1 };
}

function parseLock(payload) {
  if (!payload || payload.length < 9) return null;
  const locked = payload[0] === 1;
  const count = payload.readUInt32BE(1);
  if (count > 64 || payload.length < 5 + count * 4) return null;
  const allowedKeys = [];
  for (let index = 0; index < count; index++) {
    allowedKeys.push(payload.readUInt32BE(5 + index * 4));
  }
  return { locked, allowedKeys };
}

function modelBytes(model) {
  const buffer = Buffer.alloc(32);
  Buffer.from(String(model || ""), "utf8").copy(buffer, 0, 0, 32);
  return buffer;
}

function buildPing(id) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(id >>> 0, 0);
  return encodeFrame(COMMANDS.PING, payload);
}

function buildAuthenticate({ mac, model } = {}) {
  const macBytes = macToBytes(mac);
  if (!macBytes) throw new Error("a valid 6-byte client MAC is required");
  return encodeFrame(COMMANDS.AUTHENTICATE, Buffer.concat([macBytes, modelBytes(model)]));
}

function buildTouch({ ms = 0, x = 0, y = 0, type = TOUCH_TYPES.PRESS, taps = 1 } = {}) {
  const payload = Buffer.alloc(10);
  payload.writeUInt32BE(ms >>> 0, 0);
  payload.writeUInt16BE(x & 0xffff, 4);
  payload.writeUInt16BE(y & 0xffff, 6);
  payload.writeUInt8(type & 0xff, 8);
  payload.writeUInt8(taps & 0xff, 9);
  return encodeFrame(COMMANDS.TOUCH, payload);
}

function buildKey({ code = 0, state = 1 } = {}) {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(code >>> 0, 0);
  payload.writeUInt32BE(state ? 1 : 0, 4);
  return encodeFrame(COMMANDS.KEY, payload);
}

function macToBytes(mac) {
  const hex = String(mac || "").replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return null;
  return Buffer.from(hex, "hex");
}

/** Normalised browser coordinates (0..1) -> MFD pixels, clamped. */
function scaleTouch({ x, y }, { width, height }) {
  const safeWidth = Number(width) > 0 ? Number(width) : 1280;
  const safeHeight = Number(height) > 0 ? Number(height) : 800;
  const clamp = (value, max) => Math.min(max - 1, Math.max(0, Math.round(value)));
  return {
    x: clamp(Number(x) * safeWidth, safeWidth),
    y: clamp(Number(y) * safeHeight, safeHeight),
  };
}

function keyLabel(code) {
  return KEY_LABELS[code] || `Key ${code}`;
}

function randomId() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function reconnectDelay(attempt) {
  return Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempt - 1)));
}

/**
 * Long-lived remote-control connection with handshake, keep-alive and
 * automatic reconnection.
 */
class RemoteClient extends EventEmitter {
  constructor({
    host,
    port = 6633,
    clientMac,
    log = () => {},
    netModule = net,
    now = Date.now,
    uptime = () => process.uptime(),
    handshakeTimeoutMs = 4000,
    keepAliveMs = 10000,
    autoReconnect = true,
  } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || 6633;
    this.clientMac = clientMac || null;
    this.log = log;
    this.net = netModule;
    this.now = now;
    this.uptime = uptime;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.keepAliveMs = keepAliveMs;
    this.autoReconnect = autoReconnect;

    this.socket = null;
    this.state = "idle";
    this.info = null;
    this.session = null;
    this.locked = false;
    this.allowedKeys = [];
    this.authed = false;
    this.stopped = false;
    this.attempt = 0;
    this.warning = null;
    this.lastError = null;

    this.timer = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;

    this.parser = createParser((cmd, payload) => this.onFrame(cmd, payload));
  }

  get canTouch() {
    if (!this.info) return false;
    if (this.info.noTouch) return false;
    if (this.locked) return false;
    return this.authed || this.info.noAuth;
  }

  get connected() {
    return Boolean(this.socket) && !this.socket.destroyed;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  connect() {
    if (this.stopped || this.socket) return;
    this.setState("connecting");
    this.log(`remote: conectando a ${this.host}:${this.port}`);

    const socket = this.net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("connect", () => {
      this.log("remote: TCP conectado");
      this.attempt = 0;
      this.sendPing(true);
    });
    socket.on("data", (chunk) => this.parser(chunk));
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.log(`remote: ${error.message}`);
      this.emit("error", error);
    });
    socket.on("close", () => {
      this.clearTimers();
      this.socket = null;
      this.authed = false;
      this.setState("offline");
      if (!this.stopped && this.autoReconnect) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    this.attempt += 1;
    const delay = reconnectDelay(this.attempt);
    this.log(`remote: reintento ${this.attempt} en ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearTimers() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  armHandshakeTimer(label) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.warning = `${label} sin respuesta del MFD`;
      this.log(`remote: ${this.warning}`);
      this.emit("warning", this.warning);
      if (label === "PONG") {
        try {
          this.socket.destroy();
        } catch (_error) {
          // already gone
        }
      } else {
        this.setState("view-only");
      }
    }, this.handshakeTimeoutMs);
  }

  sendPing(expectPong = false) {
    if (!this.connected) return;
    try {
      this.socket.write(buildPing(randomId()));
      if (expectPong) this.armHandshakeTimer("PONG");
    } catch (error) {
      this.log(`remote: no se pudo enviar PING: ${error.message}`);
    }
  }

  onFrame(cmd, payload) {
    if (cmd === COMMANDS.PONG) {
      const info = parsePong(payload);
      if (!info) {
        this.log("remote: PONG con formato inesperado");
        return;
      }
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.info = info;
      this.warning = null;
      this.emit("info", info);
      this.log(
        `remote: ${info.model || "MFD"} ${info.width}x${info.height} ` +
          `caps=0x${info.capabilities.toString(16)} keys=${info.keys.length}`
      );
      this.startKeepAlive();
      this.decideAuth();
      return;
    }

    if (cmd === COMMANDS.SESSION) {
      const session = parseSession(payload);
      if (!session) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.session = session;
      this.authed = session.authed;
      if (session.authed) {
        this.warning = null;
        this.setState("ready");
        this.emit("session", session);
      } else {
        this.warning = "El MFD rechazó la autenticación; control en modo solo ver";
        this.log(`remote: ${this.warning}`);
        this.emit("warning", this.warning);
        this.setState("view-only");
      }
      return;
    }

    if (cmd === COMMANDS.LOCK) {
      const lock = parseLock(payload);
      if (!lock) return;
      this.locked = lock.locked;
      this.allowedKeys = lock.allowedKeys;
      this.emit("lock", lock);
      return;
    }

    this.log(`remote: comando desconocido ${commandName(cmd)}`);
  }

  decideAuth() {
    if (!this.info) return;
    // A keep-alive PONG must not restart the handshake.
    if (this.state === "ready" || this.state === "view-only" || this.state === "authenticating") {
      return;
    }
    if (this.info.noAuth) {
      this.setState("ready");
      return;
    }
    if (!this.clientMac) {
      this.warning =
        "El MFD requiere autenticación y no hay MAC de cliente; control en modo solo ver";
      this.log(`remote: ${this.warning}`);
      this.emit("warning", this.warning);
      this.setState("view-only");
      return;
    }

    this.setState("authenticating");
    try {
      this.socket.write(buildAuthenticate({ mac: this.clientMac, model: this.info.model }));
      this.armHandshakeTimer("SESSION");
    } catch (error) {
      this.lastError = error.message;
      this.setState("view-only");
    }
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.state === "ready" || this.state === "view-only") this.sendPing(false);
    }, this.keepAliveMs);
  }

  /** Sends a touch event; returns false when control is not available. */
  touch({ phase, x, y, taps = 1 } = {}) {
    if (!this.canTouch || !this.connected) return false;
    const type = TOUCH_PHASES[phase];
    if (type === undefined) return false;
    const point = scaleTouch({ x, y }, this.info);
    const ms = Math.floor(this.uptime() * 1000) >>> 0;
    this.socket.write(buildTouch({ ms, x: point.x, y: point.y, type, taps }));
    return true;
  }

  translationForIndex(index) {
    if (!this.info || !Array.isArray(this.info.keys)) return null;
    const entry = this.info.keys[Number(index)];
    if (!entry) return null;
    // While locked only the keys announced by the MFD are allowed; an empty
    // allow-list means no key at all.
    if (this.locked && !this.allowedKeys.includes(entry.translation)) return null;
    return entry.translation;
  }

  keyByIndex(index, state) {
    const translation = this.translationForIndex(index);
    if (translation === null || !this.connected) return false;
    this.socket.write(buildKey({ code: translation, state: state ? 1 : 0 }));
    return true;
  }

  keys() {
    if (!this.info) return [];
    return this.info.keys.map((entry, index) => ({
      index,
      code: entry.code,
      translation: entry.translation,
      label: keyLabel(entry.code),
    }));
  }

  status() {
    return {
      enabled: true,
      state: this.state,
      connected: this.connected,
      model: this.info ? this.info.model : null,
      name: this.info ? this.info.name : null,
      firmware: this.info ? this.info.firmware : null,
      width: this.info ? this.info.width : null,
      height: this.info ? this.info.height : null,
      version: this.info ? this.info.version : null,
      noAuth: this.info ? this.info.noAuth : null,
      noTouch: this.info ? this.info.noTouch : null,
      authed: this.authed,
      locked: this.locked,
      allowedKeys: this.allowedKeys,
      canTouch: this.canTouch,
      keys: this.keys(),
      warning: this.warning,
      error: this.lastError,
    };
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.destroy();
      } catch (_error) {
        // already gone
      }
    }
    this.setState("stopped");
    this.removeAllListeners();
  }
}

module.exports = {
  COMMANDS,
  KEY_LABELS,
  RemoteClient,
  TOUCH_PHASES,
  TOUCH_TYPES,
  buildAuthenticate,
  buildKey,
  buildPing,
  buildTouch,
  commandName,
  createParser,
  encodeFrame,
  keyLabel,
  macToBytes,
  parseLock,
  parsePong,
  parseSession,
  scaleTouch,
};
