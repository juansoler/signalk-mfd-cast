"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ipToInt, macForAddress, macToBytes, rtspUrl, usableMac } = require("../plugin/mfd");

test("RTSP URL matches what the Android app builds", () => {
  assert.equal(
    rtspUrl({ address: "192.168.0.10", port: 554, path: "/screenmirror" }),
    "rtsp://192.168.0.10:554/screenmirror"
  );
  assert.equal(
    rtspUrl({ address: "10.0.0.2" }),
    "rtsp://10.0.0.2:554/screenmirror"
  );
  assert.equal(
    rtspUrl({ address: "10.0.0.2", port: 8554, path: "custom" }),
    "rtsp://10.0.0.2:8554/custom"
  );
});

test("an empty address cannot produce a URL", () => {
  assert.throws(() => rtspUrl({ address: "" }), /mfdAddress/);
});

test("ipToInt handles valid and invalid input", () => {
  assert.equal(ipToInt("192.168.1.1"), 0xc0a80101);
  assert.equal(ipToInt("300.1.1.1"), null);
  assert.equal(ipToInt("1.2.3"), null);
});

test("macToBytes produces six bytes", () => {
  const bytes = macToBytes("AA:BB:CC:DD:EE:FF");
  assert.equal(bytes.length, 6);
  assert.deepEqual(Array.from(bytes), [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  assert.equal(macToBytes("nope"), null);
});

test("usableMac rejects the all-zero MAC", () => {
  assert.equal(usableMac("00:00:00:00:00:00"), null);
  assert.equal(usableMac("aa:bb:cc:dd:ee:ff"), "aa:bb:cc:dd:ee:ff");
});

test("macForAddress prefers the interface on the MFD subnet", () => {
  const interfaces = {
    eth0: [
      {
        family: "IPv4",
        address: "192.168.1.50",
        netmask: "255.255.255.0",
        mac: "aa:aa:aa:aa:aa:aa",
        internal: false,
      },
    ],
    wlan0: [
      {
        family: "IPv4",
        address: "192.168.0.20",
        netmask: "255.255.255.0",
        mac: "bb:bb:bb:bb:bb:bb",
        internal: false,
      },
    ],
  };
  assert.equal(macForAddress("192.168.0.10", interfaces), "bb:bb:bb:bb:bb:bb");
  assert.equal(macForAddress("10.9.9.9", interfaces), "aa:aa:aa:aa:aa:aa");
});

test("macForAddress ignores loopback and internal interfaces", () => {
  const interfaces = {
    lo: [
      {
        family: "IPv4",
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        mac: "00:00:00:00:00:00",
        internal: true,
      },
    ],
  };
  assert.equal(macForAddress("192.168.0.10", interfaces), null);
});

test("macForAddress accepts the numeric family used by older Node", () => {
  const interfaces = {
    wlan0: [
      {
        family: 4,
        address: "192.168.0.20",
        netmask: "255.255.255.0",
        mac: "bb:bb:bb:bb:bb:bb",
        internal: false,
      },
    ],
  };
  assert.equal(macForAddress("192.168.0.10", interfaces), "bb:bb:bb:bb:bb:bb");
});
