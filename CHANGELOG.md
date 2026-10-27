# Changelog

## 0.1.1

- Documentation cleanup. No functional changes.

## 0.1.0

First public release.

- WebRTC screen mirror for Navico/B&G/Simrad/Lowrance MFDs, with `go2rtc` managed
  by the plugin and the SDP exchange proxied through Signal K.
- Copy-first pipeline: the stream is remuxed, never re-encoded, unless the codec
  cannot travel over WebRTC and a transcode is explicitly allowed.
- Codec probe (`ffprobe`) and pipeline decision: H.264 copy, V4L2 M2M hardware
  transcode on Raspberry Pi, or a clear refusal with a VLC link.
- Navico remote protocol client: PING/PONG, AUTHENTICATE/SESSION, TOUCH, KEY and
  LOCK, with exclusive control ownership and a view-only default.
- Signal K webapp viewer with touch overlay, key bar, lock overlay, latency and
  viewer counters, and a VLC playlist link.
- Demo mode (generated test pattern) and `scripts/diagnose.sh` to validate an
  installation without an MFD.
- `/status`, `/stats` and `/diagnostics` endpoints.
- 78 unit tests, plus validation against a real `go2rtc` binary and a headless
  browser.
