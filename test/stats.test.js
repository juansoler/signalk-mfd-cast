"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTemperatureReader,
  parseProcStat,
  parseStatus,
  processStats,
} = require("../plugin/stats");

function statLine({ utime, stime, rss }) {
  const fields = [
    "S",
    "1",
    "4242",
    "4242",
    "0",
    "-1",
    "4194560",
    "100",
    "0",
    "0",
    "0",
    String(utime),
    String(stime),
    "0",
    "0",
    "20",
    "0",
    "2",
    "0",
    "1000",
    "1000000",
    String(rss),
  ];
  return `4242 (go2rtc) ${fields.join(" ")}`;
}

test("process stat parsing uses the fields after the command name", () => {
  const parsed = parseProcStat(statLine({ utime: 10, stime: 5, rss: 500 }));
  assert.equal(parsed.utime, 10);
  assert.equal(parsed.stime, 5);
  assert.equal(parsed.rssPages, 500);
  assert.equal(parseProcStat("garbage"), null);
});

test("VmRSS is converted from kB to bytes", () => {
  assert.equal(parseStatus("Name:\tgo2rtc\nVmRSS:\t  20480 kB\n"), 20480 * 1024);
  assert.equal(parseStatus("nope"), null);
});

test("CPU usage is measured relative to one core", async () => {
  let statReads = 0;
  const fsImpl = {
    readFileSync(file) {
      if (file.endsWith("/stat")) {
        statReads += 1;
        return statReads === 1
          ? statLine({ utime: 10, stime: 5, rss: 500 })
          : statLine({ utime: 20, stime: 10, rss: 500 });
      }
      return "VmRSS:\t  20480 kB\n";
    },
  };

  let clock = 1000;
  const result = await processStats(4242, {
    fsImpl,
    platform: "linux",
    sampleMs: 500,
    sleepImpl: async () => {},
    now: () => {
      const value = clock;
      clock += 500;
      return value;
    },
  });

  // 15 ticks in 0.5 s at 100 Hz = 30% of one core.
  assert.equal(result.cpuPercent, 30);
  assert.equal(result.rssBytes, 20480 * 1024);
});

test("statistics are null off Linux or for a missing process", async () => {
  assert.equal(await processStats(4242, { platform: "win32" }), null);

  const fsImpl = {
    readFileSync() {
      throw new Error("ENOENT");
    },
  };
  assert.equal(await processStats(4242, { fsImpl, platform: "linux" }), null);
});

test("temperature is cached and degrades to null", async () => {
  let calls = 0;
  let clock = 0;
  const execFileImpl = (file, args, options, callback) => {
    calls += 1;
    callback(null, "temp=48.3'C\n", "");
  };

  const reader = createTemperatureReader({
    execFileImpl,
    platform: "linux",
    ttlMs: 10000,
    now: () => clock,
  });

  assert.equal(await reader(), 48.3);
  assert.equal(await reader(), 48.3);
  assert.equal(calls, 1);

  clock = 20000;
  await reader();
  assert.equal(calls, 2);

  const failing = createTemperatureReader({
    execFileImpl: (file, args, options, callback) => callback(new Error("no vcgencmd")),
    platform: "linux",
  });
  assert.equal(await failing(), null);

  const windows = createTemperatureReader({ platform: "win32" });
  assert.equal(await windows(), null);
});
