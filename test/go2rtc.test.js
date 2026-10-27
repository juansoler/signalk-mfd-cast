"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { Go2rtc, buildConfigYaml, resolveBinary } = require("../plugin/go2rtc");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    setImmediate(() => this.emit("exit", 0, signal));
    return true;
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfdcast-go2rtc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

test("the generated config keeps the API and RTSP on loopback", () => {
  const yaml = buildConfigYaml({ apiPort: 1984, webrtcPort: 8555 });
  assert.match(yaml, /127\.0\.0\.1:1984/);
  assert.match(yaml, /127\.0\.0\.1:8554/);
  assert.match(yaml, /:8555/);
  assert.match(yaml, /webrtc:/);
});

test("config-defined streams are written as trusted YAML entries", () => {
  const yaml = buildConfigYaml({
    streams: { mfd: 'exec:ffmpeg -re -f lavfi -i "testsrc2=size=1280x800"' },
  });
  assert.match(yaml, /^streams:$/m);
  assert.match(yaml, /^  mfd: "exec:ffmpeg/m);
});

test("resolveBinary prefers the explicit path, then the plugin data dir, then PATH", () => {
  const bundled = path.join("/data", "bin", "go2rtc");
  const existing = new Set(["/opt/go2rtc", bundled]);
  const exists = (file) => existing.has(file);

  assert.equal(
    resolveBinary({ configured: "/opt/go2rtc", dataDir: "/data", exists }),
    "/opt/go2rtc"
  );
  assert.equal(
    resolveBinary({ configured: "/missing/go2rtc", dataDir: "/data", exists, platform: "linux" }),
    bundled
  );
  assert.equal(
    resolveBinary({ configured: "go2rtc", dataDir: "/data", exists }),
    "go2rtc"
  );
  assert.equal(
    resolveBinary({ configured: "", dataDir: "/empty", exists, platform: "linux" }),
    null
  );
});

test("start writes the config, launches the process and waits for the API", async (t) => {
  const dir = tempDir(t);
  const spawned = [];
  const requests = [];

  const spawnImpl = (command, args, options) => {
    const child = new FakeChild();
    spawned.push({ command, args, options, child });
    return child;
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({});
  };

  const rt = new Go2rtc({
    binary: "/opt/go2rtc",
    dataDir: dir,
    apiPort: 1984,
    webrtcPort: 8555,
    nice: 10,
    platform: "linux",
    spawnImpl,
    fetchImpl,
    sleepImpl: async () => {},
  });

  await rt.start();

  assert.equal(rt.running, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "nice");
  assert.deepEqual(spawned[0].args.slice(0, 2), ["-n", "10"]);
  assert.ok(spawned[0].args.includes("-config"));

  const yaml = fs.readFileSync(path.join(dir, "go2rtc.yaml"), "utf8");
  assert.match(yaml, /127\.0\.0\.1:1984/);
  assert.match(yaml, /:8555/);

  await rt.setStream("mfd", "rtsp://192.168.0.10:554/screenmirror");
  const put = requests.at(-1);
  assert.equal(put.options.method, "PUT");
  assert.match(put.url, /\/api\/streams\?name=mfd/);
  assert.match(put.url, /src=rtsp%3A%2F%2F192\.168\.0\.10/);

  await rt.stop();
  assert.equal(rt.running, false);
  assert.ok(spawned[0].child.signals.includes("SIGTERM"));
});

test("WebRTC answers are parsed from JSON and from raw SDP", async (t) => {
  const dir = tempDir(t);
  const spawnImpl = () => new FakeChild();
  const responses = [
    jsonResponse({ type: "answer", sdp: "v=0\r\njson-answer" }),
    {
      ok: true,
      status: 200,
      text: async () => "v=0\r\nraw-answer",
    },
  ];
  const fetchImpl = async (url) => {
    // The first request is the readiness probe from start().
    if (url.endsWith("/api/streams")) return jsonResponse({});
    return responses.shift();
  };

  const rt = new Go2rtc({
    binary: "/opt/go2rtc",
    dataDir: dir,
    platform: "linux",
    spawnImpl,
    fetchImpl,
    sleepImpl: async () => {},
  });
  await rt.start();

  assert.equal(await rt.webrtc("mfd", "v=0\r\noffer"), "v=0\r\njson-answer");
  assert.equal(await rt.webrtc("mfd", "v=0\r\noffer"), "v=0\r\nraw-answer");

  await rt.stop();
});

test("start fails with a useful error when the API never answers", async (t) => {
  const dir = tempDir(t);
  let clock = 1000;

  const rt = new Go2rtc({
    binary: "/opt/go2rtc",
    dataDir: dir,
    platform: "linux",
    spawnImpl: () => new FakeChild(),
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    sleepImpl: async () => {},
    now: () => {
      clock += 1000;
      return clock;
    },
  });

  await assert.rejects(() => rt.start(), /no respondió/);
});
