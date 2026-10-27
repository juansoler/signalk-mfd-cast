"use strict";

/**
 * Lightweight process statistics for /stats.
 *
 * The plugin promises a quiet Raspberry Pi; these numbers are how the promise
 * is checked instead of guessed. Everything degrades to null off Linux.
 */

const fs = require("fs");
const { execFile } = require("child_process");

const PROC_ROOT = "/proc";
const CLOCK_TICKS = 100; // USER_HZ on Linux

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts utime/stime ticks and RSS pages from /proc/<pid>/stat. */
function parseProcStat(text) {
  const source = String(text || "");
  const close = source.lastIndexOf(")");
  if (close < 0) return null;
  const fields = source.slice(close + 1).trim().split(/\s+/);
  // fields[0] is the process state (field 3 of the file).
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rssPages = Number(fields[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime, rssPages: Number.isFinite(rssPages) ? rssPages : 0 };
}

function parseStatus(text) {
  const match = String(text || "").match(/VmRSS:\s+(\d+)\s+kB/);
  return match ? Number(match[1]) * 1024 : null;
}

async function readOnce(pid, fsImpl) {
  const stat = fsImpl.readFileSync(`${PROC_ROOT}/${pid}/stat`, "utf8");
  let rss = null;
  try {
    rss = parseStatus(fsImpl.readFileSync(`${PROC_ROOT}/${pid}/status`, "utf8"));
  } catch (_error) {
    rss = null;
  }
  const parsed = parseProcStat(stat);
  if (!parsed) throw new Error("cannot parse /proc stat");
  return { ...parsed, rss };
}

/**
 * Samples a process twice and returns CPU usage relative to one core.
 *
 * Returns null when the process does not exist or /proc is unavailable.
 */
async function processStats(
  pid,
  {
    sampleMs = 500,
    fsImpl = fs,
    clockTicks = CLOCK_TICKS,
    sleepImpl = sleep,
    now = Date.now,
    platform = process.platform,
  } = {}
) {
  if (platform !== "linux" || !pid) return null;

  try {
    const first = await readOnce(pid, fsImpl);
    const startedAt = now();
    await sleepImpl(sampleMs);
    const second = await readOnce(pid, fsImpl);
    const elapsed = Math.max(1, now() - startedAt) / 1000;
    const ticks = second.utime + second.stime - (first.utime + first.stime);
    const cpuPercent = Math.round(((ticks / (elapsed * clockTicks)) * 100) * 10) / 10;
    return {
      pid,
      cpuPercent: Math.max(0, cpuPercent),
      rssBytes: second.rss,
    };
  } catch (_error) {
    return null;
  }
}

function createTemperatureReader({
  execFileImpl = execFile,
  platform = process.platform,
  ttlMs = 10000,
  now = Date.now,
} = {}) {
  let cached = { at: null, value: null };

  return function temperature() {
    if (platform !== "linux") return Promise.resolve(null);
    if (cached.at !== null && now() - cached.at < ttlMs) {
      return Promise.resolve(cached.value);
    }

    return new Promise((resolve) => {
      execFileImpl(
        "vcgencmd",
        ["measure_temp"],
        { timeout: 3000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            cached = { at: now(), value: null };
            resolve(null);
            return;
          }
          const match = String(stdout || "").match(/temp=([\d.]+)/);
          const value = match ? Number(match[1]) : null;
          cached = { at: now(), value };
          resolve(value);
        }
      );
    });
  };
}

module.exports = {
  CLOCK_TICKS,
  createTemperatureReader,
  parseProcStat,
  parseStatus,
  processStats,
};
