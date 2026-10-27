"use strict";

/**
 * MFD addressing helpers: RTSP URL construction and local client identity.
 *
 * The Navico remote protocol authenticates with the MAC address of the client
 * that opens the TCP connection, so the MAC must belong to the interface that
 * can reach the display.
 */

const os = require("os");

function ipToInt(address) {
  const parts = String(address || "").split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isIPv4(info) {
  return Boolean(info) && (info.family === "IPv4" || info.family === 4);
}

/** rtsp://<address>:<port><path> (no credentials, the MFD stream is open). */
function rtspUrl({ address, port = 554, path = "/screenmirror" } = {}) {
  const clean = String(address || "").trim();
  if (!clean) throw new Error("mfdAddress is required");
  const safePath = path && path.startsWith("/") ? path : `/${path || "screenmirror"}`;
  return `rtsp://${clean}:${Number(port) || 554}${safePath}`;
}

function usableMac(value) {
  const mac = String(value || "").toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  if (mac === "00:00:00:00:00:00") return null;
  return mac;
}

/**
 * Picks the MAC of the local interface that shares a subnet with `target`.
 *
 * Falls back to the first non-internal IPv4 interface when nothing matches,
 * which is what a single-NIC Raspberry Pi will hit anyway.
 */
function macForAddress(target, interfaces = os.networkInterfaces()) {
  const targetInt = ipToInt(target);
  const fallback = [];

  for (const entries of Object.values(interfaces || {})) {
    for (const info of entries || []) {
      if (!isIPv4(info) || info.internal) continue;
      const mac = usableMac(info.mac);
      if (!mac) continue;
      if (fallback.length === 0) fallback.push(mac);

      const host = ipToInt(info.address);
      const mask = ipToInt(info.netmask);
      if (targetInt === null || host === null || mask === null) continue;
      if ((host & mask) === (targetInt & mask)) return mac;
    }
  }

  return fallback.length > 0 ? fallback[0] : null;
}

/** "aa:bb:cc:dd:ee:ff" -> Buffer(6), or null. */
function macToBytes(value) {
  const mac = usableMac(value);
  if (!mac) return null;
  return Buffer.from(mac.split(":").map((part) => parseInt(part, 16)));
}

module.exports = {
  ipToInt,
  macForAddress,
  macToBytes,
  rtspUrl,
  usableMac,
};
