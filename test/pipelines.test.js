"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MODES, buildSource, choosePipeline, isCopy, isStreamable } = require("../plugin/pipelines");

const URL = "rtsp://192.168.0.10:554/screenmirror";
const HARDWARE_OK = { available: true, detail: "ok" };
const HARDWARE_NONE = { available: false, detail: "no" };

test("H.264 is always copied, regardless of policy", () => {
  for (const policy of ["off", "hardware-only", "allow-software"]) {
    const pipeline = choosePipeline({ codec: "h264", hardware: HARDWARE_NONE, policy, rtspUrl: URL });
    assert.equal(pipeline.mode, MODES.COPY);
    assert.equal(pipeline.warning, null);
    assert.equal(pipeline.source, URL);
    assert.equal(isCopy(pipeline), true);
    assert.equal(isStreamable(pipeline), true);
  }
});

test("a non-H.264 codec without hardware and policy off is refused", () => {
  const pipeline = choosePipeline({
    codec: "mpeg2",
    hardware: HARDWARE_NONE,
    policy: "off",
    rtspUrl: URL,
  });
  assert.equal(pipeline.mode, MODES.UNSUPPORTED);
  assert.equal(pipeline.source, null);
  assert.equal(isStreamable(pipeline), false);
  assert.match(pipeline.reason, /transcodePolicy=off/);
});

test("a non-H.264 codec uses the hardware encoder when present", () => {
  const pipeline = choosePipeline({
    codec: "mpeg4",
    hardware: HARDWARE_OK,
    policy: "hardware-only",
    rtspUrl: URL,
    maxWidth: 1280,
  });
  assert.equal(pipeline.mode, MODES.TRANSCODE_HARDWARE);
  assert.equal(pipeline.source, `ffmpeg:${URL}#video=h264#hardware#width=1280`);
  assert.ok(pipeline.warning);
  assert.equal(isCopy(pipeline), false);
  assert.equal(isStreamable(pipeline), true);
});

test("software transcoding only happens when explicitly allowed", () => {
  const refused = choosePipeline({
    codec: "mpeg2",
    hardware: HARDWARE_NONE,
    policy: "hardware-only",
    rtspUrl: URL,
  });
  assert.equal(refused.mode, MODES.UNSUPPORTED);

  const allowed = choosePipeline({
    codec: "mpeg2",
    hardware: HARDWARE_NONE,
    policy: "allow-software",
    rtspUrl: URL,
    maxWidth: 960,
  });
  assert.equal(allowed.mode, MODES.TRANSCODE_SOFTWARE);
  assert.equal(allowed.source, `ffmpeg:${URL}#video=h264#width=960`);
  assert.match(allowed.warning, /alto de CPU/);
});

test("unknown codecs cannot be streamed safely", () => {
  const pipeline = choosePipeline({ codec: "unknown", hardware: HARDWARE_OK, policy: "hardware-only" });
  assert.equal(pipeline.mode, MODES.UNKNOWN);
  assert.equal(pipeline.source, null);
});

test("extra source options are appended to every streamable mode", () => {
  assert.equal(
    buildSource({ mode: MODES.COPY, rtspUrl: URL, extraSourceOptions: "#timeout=10" }),
    `${URL}#timeout=10`
  );
  assert.equal(
    buildSource({
      mode: MODES.TRANSCODE_HARDWARE,
      rtspUrl: URL,
      maxWidth: 1280,
      extraSourceOptions: "#timeout=10",
    }),
    `ffmpeg:${URL}#video=h264#hardware#width=1280#timeout=10`
  );
});

test("codec labels are human readable", () => {
  const pipeline = choosePipeline({
    codec: "mpeg2",
    hardware: HARDWARE_OK,
    policy: "hardware-only",
    rtspUrl: URL,
  });
  assert.equal(pipeline.codecLabel, "MPEG-2");
});
