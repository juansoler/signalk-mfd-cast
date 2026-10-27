"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, isHost, isIPv4, macAddress, normalizeConfig } = require("../plugin/config");

test("defaults are safe for a loaded Raspberry Pi", () => {
  const config = normalizeConfig({});
  assert.equal(config.mfdAddress, "");
  assert.equal(config.rtspPort, 554);
  assert.equal(config.rtspPath, "/screenmirror");
  assert.equal(config.controlPort, 6633);
  assert.equal(config.transcodePolicy, "hardware-only");
  assert.equal(config.manageGo2rtc, true);
  assert.equal(config.cpuNice, 10);
  assert.equal(config.maxWidth, 1280);
});

test("undefined and null options fall back to defaults", () => {
  assert.deepEqual(normalizeConfig(undefined), normalizeConfig({}));
  assert.deepEqual(normalizeConfig(null), normalizeConfig({}));
});

test("IP addresses and hostnames are accepted, junk is not", () => {
  assert.equal(isIPv4("192.168.0.10"), true);
  assert.equal(isIPv4("192.168.0.256"), false);
  assert.equal(isIPv4("192.168.0"), false);
  assert.equal(isHost("192.168.0.10"), true);
  assert.equal(isHost("mfd.local"), true);
  assert.equal(isHost("bad host"), false);
  assert.equal(isHost(""), false);
});

test("MAC addresses are normalised to colon form", () => {
  assert.equal(macAddress("aabbccddeeff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(macAddress("aa:bb:cc:dd:ee:ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(macAddress("AA-BB-CC-DD-EE-FF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(macAddress("nope"), "");
});

test("ports are validated and clamped", () => {
  assert.equal(normalizeConfig({ rtspPort: 8554 }).rtspPort, 8554);
  assert.equal(normalizeConfig({ rtspPort: 0 }).rtspPort, 554);
  assert.equal(normalizeConfig({ rtspPort: 70000 }).rtspPort, 554);
  assert.equal(normalizeConfig({ rtspPort: "abc" }).rtspPort, 554);
  assert.equal(normalizeConfig({ go2rtcPort: 2000 }).go2rtcPort, 2000);
});

test("transcode policy only accepts known values", () => {
  assert.equal(normalizeConfig({ transcodePolicy: "off" }).transcodePolicy, "off");
  assert.equal(
    normalizeConfig({ transcodePolicy: "allow-software" }).transcodePolicy,
    "allow-software"
  );
  assert.equal(
    normalizeConfig({ transcodePolicy: "please-burn-cpu" }).transcodePolicy,
    DEFAULTS.transcodePolicy
  );
});

test("RTSP path always starts with a slash", () => {
  assert.equal(normalizeConfig({ rtspPath: "screenmirror" }).rtspPath, "/screenmirror");
  assert.equal(normalizeConfig({ rtspPath: "/custom" }).rtspPath, "/custom");
  assert.equal(normalizeConfig({ rtspPath: "" }).rtspPath, "/screenmirror");
});

test("width is clamped to a sane range", () => {
  assert.equal(normalizeConfig({ maxWidth: 100 }).maxWidth, 320);
  assert.equal(normalizeConfig({ maxWidth: 99999 }).maxWidth, 3840);
  assert.equal(normalizeConfig({ maxWidth: 960 }).maxWidth, 960);
});

test("extra go2rtc options always start with #", () => {
  assert.equal(normalizeConfig({ extraSourceOptions: "timeout=10" }).extraSourceOptions, "#timeout=10");
  assert.equal(normalizeConfig({ extraSourceOptions: "#timeout=10" }).extraSourceOptions, "#timeout=10");
  assert.equal(normalizeConfig({ extraSourceOptions: "  " }).extraSourceOptions, "");
});

test("control can be disabled without touching the rest", () => {
  assert.equal(normalizeConfig({ controlEnabled: false }).controlEnabled, false);
  assert.equal(normalizeConfig({ controlEnabled: "false" }).controlEnabled, true);
});

test("demo mode is opt-in and strictly boolean", () => {
  assert.equal(normalizeConfig({}).demoMode, false);
  assert.equal(normalizeConfig({ demoMode: true }).demoMode, true);
  assert.equal(normalizeConfig({ demoMode: "true" }).demoMode, false);
});
