#!/usr/bin/env node
"use strict";

/**
 * Simulated Navico MFD for testing the control channel without hardware.
 *
 * Speaks the documented TCP 6633 protocol: answers PING with PONG, accepts
 * AUTHENTICATE, and logs every TOUCH and KEY frame it receives.
 *
 * Usage:
 *   node scripts/mock-mfd.js [--port 6633] [--auth] [--touchless] [--locked]
 */

const net = require("net");

const {
  COMMANDS,
  KEY_LABELS,
  TOUCH_TYPES,
  createParser,
  encodeFrame,
} = require("../plugin/remote");

const args = process.argv.slice(2);

function has(flag) {
  return args.includes(flag);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

if (has("--help") || has("-h")) {
  console.log(`Uso: node scripts/mock-mfd.js [opciones]

  --port <n>     puerto TCP (por defecto 6633)
  --auth         exige AUTHENTICATE antes de aceptar toques
  --touchless    anuncia que el MFD no soporta toques (bit 0x10)
  --locked       envía LOCK a los 5 s con solo algunas teclas permitidas
`);
  process.exit(0);
}

const port = Number(option("--port", 6633));
const requireAuth = has("--auth");
const touchless = has("--touchless");
const locked = has("--locked");

const KEYS = [
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 6],
  [7, 7],
  [8, 8],
  [9, 9],
  [10, 10],
  [11, 11],
];

const TOUCH_NAMES = Object.fromEntries(
  Object.entries(TOUCH_TYPES).map(([name, value]) => [value, name.toLowerCase()])
);

function writePadded(buffer, value, offset, length) {
  Buffer.from(String(value), "utf8").copy(buffer, offset, 0, length);
}

function pongPayload(pingId) {
  const payload = Buffer.alloc(101 + KEYS.length * 8);
  payload.writeUInt32BE(pingId >>> 0, 0);
  payload.writeUInt8(1, 4);
  writePadded(payload, "MOCK NSS12", 5, 32);
  writePadded(payload, "Mock Helm", 37, 32);
  writePadded(payload, "9.9.9", 69, 16);

  let capabilities = 0;
  if (!requireAuth) capabilities |= 0x01;
  if (touchless) capabilities |= 0x10;
  payload.writeUInt32BE(capabilities, 85);

  payload.writeUInt32BE(KEYS.length, 89);
  KEYS.forEach(([code, translation], index) => {
    payload.writeUInt32BE(code, 93 + index * 8);
    payload.writeUInt32BE(translation, 97 + index * 8);
  });

  const tail = 93 + KEYS.length * 8;
  payload.writeUInt16BE(1280, tail);
  payload.writeUInt16BE(800, tail + 2);
  payload.writeUInt16BE(300, tail + 4);
  payload.writeUInt16BE(190, tail + 6);
  return payload;
}

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const mac = "aa:bb:cc:dd:ee:ff";
  let authed = !requireAuth;

  console.log(`[${timestamp()}] conexión de ${peer}`);

  const send = (cmd, payload) => {
    socket.write(encodeFrame(cmd, payload));
  };

  const parser = createParser((cmd, payload) => {
    if (cmd === COMMANDS.PING) {
      const pingId = payload.length >= 4 ? payload.readUInt32BE(0) : 0;
      console.log(`[${timestamp()}] PING ${pingId}`);
      send(COMMANDS.PONG, pongPayload(pingId));
      return;
    }

    if (cmd === COMMANDS.AUTHENTICATE) {
      const clientMac = Array.from(payload.subarray(0, 6))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(":");
      const model = payload.subarray(6, 38).toString("utf8").replace(/\0.*$/, "").trim();
      authed = true;
      console.log(`[${timestamp()}] AUTHENTICATE mac=${clientMac} model="${model}"`);
      const session = Buffer.alloc(7);
      Buffer.from(mac.replace(/:/g, ""), "hex").copy(session, 0);
      session[6] = 1;
      send(COMMANDS.SESSION, session);
      return;
    }

    if (cmd === COMMANDS.TOUCH) {
      if (payload.length < 10) return;
      const ms = payload.readUInt32BE(0);
      const x = payload.readUInt16BE(4);
      const y = payload.readUInt16BE(6);
      const type = TOUCH_NAMES[payload[8]] || `type ${payload[8]}`;
      const taps = payload[9];
      console.log(
        `[${timestamp()}] TOUCH ${type} (${x}, ${y}) taps=${taps} ms=${ms}` +
          (authed ? "" : "  [sin autenticar]")
      );
      return;
    }

    if (cmd === COMMANDS.KEY) {
      if (payload.length < 8) return;
      const code = payload.readUInt32BE(0);
      const state = payload.readUInt32BE(4);
      console.log(
        `[${timestamp()}] KEY ${KEY_LABELS[code] || code} ${state ? "down" : "up"}`
      );
      return;
    }

    console.log(`[${timestamp()}] comando desconocido 0x${cmd.toString(16)}`);
  });

  socket.on("data", (chunk) => parser(chunk));
  socket.on("error", (error) => console.log(`[${timestamp()}] error: ${error.message}`));
  socket.on("close", () => console.log(`[${timestamp()}] desconectado ${peer}`));

  if (locked) {
    setTimeout(() => {
      if (socket.destroyed) return;
      const payload = Buffer.alloc(13);
      payload[0] = 1;
      payload.writeUInt32BE(2, 1);
      payload.writeUInt32BE(2, 5);
      payload.writeUInt32BE(7, 9);
      send(COMMANDS.LOCK, payload);
      console.log(`[${timestamp()}] LOCK enviado (permitidas: Menu, Enter)`);
    }, 5000);
  }
});

server.listen(port, () => {
  console.log(`MFD simulado escuchando en 0.0.0.0:${port}`);
  console.log(
    `  auth=${requireAuth ? "sí" : "no"} touch=${touchless ? "no" : "sí"} lock=${locked ? "sí" : "no"}`
  );
  console.log("Configura el plugin con esta IP y puerto de control para probar.");
});

process.on("SIGINT", () => {
  console.log("\ncerrando…");
  server.close(() => process.exit(0));
});
