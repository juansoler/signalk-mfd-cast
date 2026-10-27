"use strict";

/**
 * Option normalisation for signalk-mfd-cast.
 *
 * Deliberately free of Signal K, child processes and sockets so it can be
 * unit tested with plain Node.
 */

const DEFAULTS = Object.freeze({
  mfdAddress: "",
  rtspPort: 554,
  rtspPath: "/screenmirror",
  controlPort: 6633,
  controlEnabled: true,
  clientMac: "",
  transcodePolicy: "hardware-only",
  maxWidth: 1280,
  go2rtcPath: "",
  go2rtcPort: 1984,
  webrtcPort: 8555,
  manageGo2rtc: true,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  cpuNice: 10,
  extraSourceOptions: "",
  demoMode: false,
});

const TRANSCODE_POLICIES = ["off", "hardware-only", "allow-software"];

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const result = String(value).trim();
  return result === "" ? fallback : result;
}

function port(value, fallback) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) return fallback;
  return result;
}

function integer(value, min, max, fallback) {
  const result = Number(value);
  if (!Number.isInteger(result)) return fallback;
  return Math.min(max, Math.max(min, result));
}

function oneOf(value, allowed, fallback) {
  const result = String(value || "").trim().toLowerCase();
  return allowed.includes(result) ? result : fallback;
}

function isIPv4(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

/** Accepts IPv4 addresses and plain hostnames (an MFD could resolve by name). */
function isHost(value) {
  const host = text(value);
  if (!host) return false;
  if (isIPv4(host)) return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

function rtspPath(value) {
  const path = text(value, DEFAULTS.rtspPath);
  return path.startsWith("/") ? path : `/${path}`;
}

/** Normalises "aabbccddeeff", "aa:bb:cc:dd:ee:ff" or "AA-BB-..." to colon form. */
function macAddress(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return "";
  return hex
    .toUpperCase()
    .match(/.{2}/g)
    .join(":");
}

/** Extra go2rtc source options; always starts with "#" when present. */
function sourceOptions(value) {
  const options = String(value || "").trim();
  if (!options) return "";
  return options.startsWith("#") ? options : `#${options}`;
}

function normalizeConfig(raw) {
  const options = raw && typeof raw === "object" ? raw : {};
  return {
    mfdAddress: text(options.mfdAddress),
    rtspPort: port(options.rtspPort, DEFAULTS.rtspPort),
    rtspPath: rtspPath(options.rtspPath),
    controlPort: port(options.controlPort, DEFAULTS.controlPort),
    controlEnabled: options.controlEnabled !== false,
    clientMac: macAddress(options.clientMac),
    transcodePolicy: oneOf(
      options.transcodePolicy,
      TRANSCODE_POLICIES,
      DEFAULTS.transcodePolicy
    ),
    maxWidth: integer(options.maxWidth, 320, 3840, DEFAULTS.maxWidth),
    go2rtcPath: text(options.go2rtcPath),
    go2rtcPort: port(options.go2rtcPort, DEFAULTS.go2rtcPort),
    webrtcPort: port(options.webrtcPort, DEFAULTS.webrtcPort),
    manageGo2rtc: options.manageGo2rtc !== false,
    ffmpegPath: text(options.ffmpegPath, DEFAULTS.ffmpegPath),
    ffprobePath: text(options.ffprobePath, DEFAULTS.ffprobePath),
    cpuNice: integer(options.cpuNice, 0, 19, DEFAULTS.cpuNice),
    extraSourceOptions: sourceOptions(options.extraSourceOptions),
    demoMode: options.demoMode === true,
  };
}

module.exports = {
  DEFAULTS,
  TRANSCODE_POLICIES,
  isHost,
  isIPv4,
  macAddress,
  normalizeConfig,
};
