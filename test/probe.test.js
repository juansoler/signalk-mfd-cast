"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCodec,
  detectHardware,
  parseProbeJson,
  probeStream,
} = require("../plugin/probe");

function probeDocument(stream = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        profile: "Main",
        width: 1280,
        height: 800,
        avg_frame_rate: "30000/1001",
        bit_rate: "4000000",
        pix_fmt: "yuv420p",
        ...stream,
      },
    ],
  });
}

test("codec names are normalised", () => {
  assert.equal(classifyCodec("h264"), "h264");
  assert.equal(classifyCodec("H264"), "h264");
  assert.equal(classifyCodec("hevc"), "hevc");
  assert.equal(classifyCodec("h265"), "hevc");
  assert.equal(classifyCodec("mpeg2video"), "mpeg2");
  assert.equal(classifyCodec("mpeg4"), "mpeg4");
  assert.equal(classifyCodec(""), "unknown");
  assert.equal(classifyCodec("weird"), "weird");
});

test("probe JSON is parsed into the pipeline vocabulary", () => {
  const probe = parseProbeJson(probeDocument());
  assert.equal(probe.codec, "h264");
  assert.equal(probe.codecName, "h264");
  assert.equal(probe.width, 1280);
  assert.equal(probe.height, 800);
  assert.equal(probe.fps, 29.97);
  assert.equal(probe.bitRate, 4000000);
});

test("garbage probe output returns null instead of throwing", () => {
  assert.equal(parseProbeJson("not json"), null);
  assert.equal(parseProbeJson(""), null);
  assert.equal(parseProbeJson(JSON.stringify({ streams: [] })), null);
});

test("probeStream passes the TCP transport and parses the output", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, probeDocument(), "");
  };

  const result = await probeStream({
    url: "rtsp://192.168.0.10:554/screenmirror",
    ffprobePath: "/usr/bin/ffprobe",
    execFileImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.probe.codec, "h264");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/ffprobe");
  assert.ok(calls[0].args.includes("-rtsp_transport"));
  assert.ok(calls[0].args.includes("tcp"));
  assert.equal(calls[0].args.at(-1), "rtsp://192.168.0.10:554/screenmirror");
});

test("probeStream reports ffprobe failures as data, not exceptions", async () => {
  const execFileImpl = (file, args, options, callback) => {
    const error = new Error("Command failed");
    error.stderr = "Connection refused";
    callback(error, "", "Connection refused");
  };

  const result = await probeStream({
    url: "rtsp://192.168.0.10/screenmirror",
    execFileImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.probe, null);
  assert.match(result.error, /Connection refused/);
});

test("detectHardware requires both the encoder and the device", async () => {
  const withEncoder = (stdout) => (file, args, options, callback) => callback(null, stdout, "");
  const linux = { platform: "linux", exists: () => true };

  const available = await detectHardware({
    execFileImpl: withEncoder(" V..... h264_v4l2m2m  V4L2 mem2mem H.264 encoder"),
    ...linux,
  });
  assert.equal(available.v4l2m2m, true);
  assert.equal(available.available, true);

  const missingDevice = await detectHardware({
    execFileImpl: withEncoder("h264_v4l2m2m"),
    platform: "linux",
    exists: () => false,
  });
  assert.equal(missingDevice.available, false);
  assert.match(missingDevice.detail, /video11/);

  const missingEncoder = await detectHardware({
    execFileImpl: withEncoder("libx264"),
    ...linux,
  });
  assert.equal(missingEncoder.available, false);
});

test("detectHardware degrades cleanly when ffmpeg is missing", async () => {
  const execFileImpl = (file, args, options, callback) => {
    const error = new Error("spawn ffmpeg ENOENT");
    callback(error, "", "");
  };
  const result = await detectHardware({ execFileImpl, platform: "linux", exists: () => true });
  assert.equal(result.available, false);
  assert.match(result.detail, /not usable/);
});

test("non-Linux platforms never claim the v4l2m2m encoder", async () => {
  const execFileImpl = (file, args, options, callback) =>
    callback(null, "h264_v4l2m2m", "");
  const result = await detectHardware({
    execFileImpl,
    platform: "win32",
    exists: () => true,
  });
  assert.equal(result.available, false);
});
