"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  COMMANDS,
  RemoteClient,
  TOUCH_TYPES,
  buildAuthenticate,
  buildKey,
  buildPing,
  buildTouch,
  createParser,
  encodeFrame,
  parseLock,
  parsePong,
  parseSession,
  scaleTouch,
} = require("../plugin/remote");

function writePadded(buffer, value, offset, length) {
  Buffer.from(String(value), "utf8").copy(buffer, offset, 0, length);
}

function pongPayload({
  id = 7,
  model = "NSS12 evo2",
  name = "Helm",
  firmware = "1.0.0",
  capabilities = 0x01,
  keys = [
    [1, 1],
    [2, 2],
    [7, 7],
  ],
  width = 1280,
  height = 800,
} = {}) {
  const payload = Buffer.alloc(101 + keys.length * 8);
  payload.writeUInt32BE(id, 0);
  payload.writeUInt8(1, 4);
  writePadded(payload, model, 5, 32);
  writePadded(payload, name, 37, 32);
  writePadded(payload, firmware, 69, 16);
  payload.writeUInt32BE(capabilities, 85);
  payload.writeUInt32BE(keys.length, 89);
  keys.forEach(([code, translation], index) => {
    payload.writeUInt32BE(code, 93 + index * 8);
    payload.writeUInt32BE(translation, 97 + index * 8);
  });
  const tail = 93 + keys.length * 8;
  payload.writeUInt16BE(width, tail);
  payload.writeUInt16BE(height, tail + 2);
  payload.writeUInt16BE(300, tail + 4);
  payload.writeUInt16BE(190, tail + 6);
  return payload;
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.written = [];
  }

  setNoDelay() {}

  write(buffer) {
    this.written.push(Buffer.from(buffer));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function fakeNet() {
  const socket = new FakeSocket();
  return { socket, netModule: { createConnection: () => socket } };
}

function frames(written) {
  return written.map((frame) => {
    const length = frame.readUInt16BE(0);
    return {
      cmd: frame.readUInt16BE(2),
      payload: frame.subarray(4, 2 + length),
    };
  });
}

test("PING frames use the documented big-endian framing", () => {
  const frame = buildPing(0x01020304);
  assert.deepEqual(Array.from(frame), [0x00, 0x06, 0x00, 0x01, 0x01, 0x02, 0x03, 0x04]);
});

test("the parser recovers from split and concatenated frames", () => {
  const seen = [];
  const push = createParser((cmd, payload) => seen.push({ cmd, payload }));

  const first = buildPing(1);
  const second = buildPing(2);

  push(first.subarray(0, 3));
  assert.equal(seen.length, 0);
  push(Buffer.concat([first.subarray(3), second]));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].cmd, COMMANDS.PING);
  assert.equal(seen[0].payload.readUInt32BE(0), 1);
  assert.equal(seen[1].payload.readUInt32BE(0), 2);
});

test("the parser drops a corrupt length byte instead of giving up", () => {
  const seen = [];
  const push = createParser((cmd, payload) => seen.push({ cmd, payload }));

  push(Buffer.concat([Buffer.from([0x00, 0x00]), buildPing(9)]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.readUInt32BE(0), 9);
});

test("PONG payloads are decoded with keys and screen size", () => {
  const pong = parsePong(pongPayload());
  assert.equal(pong.model, "NSS12 evo2");
  assert.equal(pong.name, "Helm");
  assert.equal(pong.firmware, "1.0.0");
  assert.equal(pong.width, 1280);
  assert.equal(pong.height, 800);
  assert.equal(pong.keys.length, 3);
  assert.deepEqual(pong.keys[0], { code: 1, translation: 1 });
  assert.equal(pong.noAuth, true);
  assert.equal(pong.noTouch, false);
});

test("capability bits are surfaced", () => {
  const pong = parsePong(pongPayload({ capabilities: 0x10 }));
  assert.equal(pong.noAuth, false);
  assert.equal(pong.noTouch, true);
});

test("truncated PONG payloads are rejected", () => {
  assert.equal(parsePong(Buffer.alloc(50)), null);
  const payload = pongPayload();
  assert.equal(parsePong(payload.subarray(0, payload.length - 4)), null);
});

test("SESSION and LOCK payloads are decoded", () => {
  const session = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 1]);
  assert.deepEqual(parseSession(session), { mac: "aa:bb:cc:dd:ee:ff", authed: true });
  assert.equal(parseSession(Buffer.alloc(3)), null);

  const lock = Buffer.alloc(13);
  lock[0] = 1;
  lock.writeUInt32BE(2, 1);
  lock.writeUInt32BE(2, 5);
  lock.writeUInt32BE(9, 9);
  assert.deepEqual(parseLock(lock), { locked: true, allowedKeys: [2, 9] });
});

test("AUTHENTICATE is six MAC bytes plus a zero padded model", () => {
  const frame = buildAuthenticate({ mac: "aa:bb:cc:dd:ee:ff", model: "NSS12 evo2" });
  const length = frame.readUInt16BE(0);
  const payload = frame.subarray(4, 2 + length);
  assert.equal(frame.readUInt16BE(2), COMMANDS.AUTHENTICATE);
  assert.equal(payload.length, 38);
  assert.deepEqual(Array.from(payload.subarray(0, 6)), [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  assert.equal(payload.subarray(6, 16).toString("utf8"), "NSS12 evo2");
  assert.equal(payload[37], 0);
});

test("TOUCH and KEY payloads match the observed layout", () => {
  const touch = buildTouch({ ms: 1234, x: 640, y: 400, type: TOUCH_TYPES.PRESS, taps: 1 });
  const touchPayload = touch.subarray(4, 2 + touch.readUInt16BE(0));
  assert.equal(touchPayload.length, 10);
  assert.equal(touchPayload.readUInt32BE(0), 1234);
  assert.equal(touchPayload.readUInt16BE(4), 640);
  assert.equal(touchPayload.readUInt16BE(6), 400);
  assert.equal(touchPayload[8], 0);
  assert.equal(touchPayload[9], 1);

  const key = buildKey({ code: 7, state: 1 });
  const keyPayload = key.subarray(4, 2 + key.readUInt16BE(0));
  assert.equal(key.readUInt16BE(2), COMMANDS.KEY);
  assert.equal(keyPayload.readUInt32BE(0), 7);
  assert.equal(keyPayload.readUInt32BE(4), 1);
});

test("normalised touch coordinates are scaled and clamped", () => {
  assert.deepEqual(scaleTouch({ x: 0.5, y: 0.25 }, { width: 1280, height: 800 }), {
    x: 640,
    y: 200,
  });
  assert.deepEqual(scaleTouch({ x: 1.2, y: -1 }, { width: 1280, height: 800 }), {
    x: 1279,
    y: 0,
  });
});

test("a display that needs no authentication is ready after PONG", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({
    host: "192.168.0.10",
    netModule,
    autoReconnect: false,
  });

  client.connect();
  socket.emit("connect");
  assert.equal(frames(socket.written)[0].cmd, COMMANDS.PING);

  socket.emit("data", encodeFrame(COMMANDS.PONG, pongPayload()));
  assert.equal(client.state, "ready");
  assert.equal(client.canTouch, true);
  assert.equal(client.info.model, "NSS12 evo2");

  assert.equal(client.touch({ phase: "press", x: 0.5, y: 0.25 }), true);
  const touch = frames(socket.written).at(-1);
  assert.equal(touch.cmd, COMMANDS.TOUCH);
  assert.equal(touch.payload.readUInt16BE(4), 640);
  assert.equal(touch.payload.readUInt16BE(6), 200);
  assert.equal(touch.payload[8], TOUCH_TYPES.PRESS);

  assert.equal(client.keyByIndex(0, 1), true);
  const key = frames(socket.written).at(-1);
  assert.equal(key.cmd, COMMANDS.KEY);
  assert.equal(key.payload.readUInt32BE(0), 1);

  client.stop();
});

test("authentication is sent when the display requires it", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({
    host: "192.168.0.10",
    clientMac: "aa:bb:cc:dd:ee:ff",
    netModule,
    autoReconnect: false,
  });

  client.connect();
  socket.emit("connect");
  socket.emit(
    "data",
    encodeFrame(COMMANDS.PONG, pongPayload({ capabilities: 0x00 }))
  );
  assert.equal(client.state, "authenticating");

  const auth = frames(socket.written).at(-1);
  assert.equal(auth.cmd, COMMANDS.AUTHENTICATE);
  assert.equal(auth.payload.length, 38);
  assert.equal(client.canTouch, false);

  socket.emit(
    "data",
    encodeFrame(COMMANDS.SESSION, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 1]))
  );
  assert.equal(client.state, "ready");
  assert.equal(client.canTouch, true);

  client.stop();
});

test("a rejected session keeps the client in view-only mode", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({
    host: "192.168.0.10",
    clientMac: "aa:bb:cc:dd:ee:ff",
    netModule,
    autoReconnect: false,
  });

  client.connect();
  socket.emit("connect");
  socket.emit("data", encodeFrame(COMMANDS.PONG, pongPayload({ capabilities: 0x00 })));
  socket.emit("data", encodeFrame(COMMANDS.SESSION, Buffer.from([0, 0, 0, 0, 0, 0, 0])));

  assert.equal(client.state, "view-only");
  assert.equal(client.canTouch, false);
  assert.match(client.warning, /rechazó/);
  client.stop();
});

test("without a client MAC an authenticated display stays view-only", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({ host: "192.168.0.10", netModule, autoReconnect: false });

  client.connect();
  socket.emit("connect");
  socket.emit("data", encodeFrame(COMMANDS.PONG, pongPayload({ capabilities: 0x00 })));

  assert.equal(client.state, "view-only");
  assert.match(client.warning, /MAC/);
  client.stop();
});

test("LOCK disables touches and only allows the announced keys", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({ host: "192.168.0.10", netModule, autoReconnect: false });

  client.connect();
  socket.emit("connect");
  socket.emit("data", encodeFrame(COMMANDS.PONG, pongPayload()));

  const lock = Buffer.alloc(9);
  lock[0] = 1;
  lock.writeUInt32BE(1, 1);
  lock.writeUInt32BE(2, 5);
  socket.emit("data", encodeFrame(COMMANDS.LOCK, lock));

  assert.equal(client.canTouch, false);
  assert.equal(client.touch({ phase: "press", x: 0.1, y: 0.1 }), false);
  assert.equal(client.translationForIndex(0), null); // code 1 is not allowed
  assert.equal(client.translationForIndex(1), 2); // code 2 is allowed
  client.stop();
});

test("status exposes the key list with human labels", () => {
  const { socket, netModule } = fakeNet();
  const client = new RemoteClient({ host: "192.168.0.10", netModule, autoReconnect: false });

  client.connect();
  socket.emit("connect");
  socket.emit("data", encodeFrame(COMMANDS.PONG, pongPayload()));

  const status = client.status();
  assert.equal(status.keys.length, 3);
  assert.equal(status.keys[0].label, "Pages");
  assert.equal(status.keys[2].label, "Enter");
  assert.equal(status.model, "NSS12 evo2");
  client.stop();
});
