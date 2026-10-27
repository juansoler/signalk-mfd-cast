"use strict";

/**
 * Stream probing and hardware-encoder detection.
 *
 * Exactly one ffprobe runs per pipeline decision. Its result is what keeps the
 * plugin honest: if the stream is not H.264 the plugin refuses to burn a core
 * unless the hardware encoder is proven available.
 */

const { execFile } = require("child_process");
const fs = require("fs");

const CODEC_ALIASES = {
  h264: "h264",
  avc: "h264",
  hevc: "hevc",
  h265: "hevc",
  mjpeg: "mjpeg",
  mpeg2video: "mpeg2",
  mpeg4: "mpeg4",
  vp8: "vp8",
  vp9: "vp9",
};

function run(file, args, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const timeout = options.timeout || 15000;
  return new Promise((resolve, reject) => {
    execFileImpl(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = String(stdout || "");
          error.stderr = String(stderr || "");
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

/** Maps an ffprobe codec_name to the small vocabulary used by the pipelines. */
function classifyCodec(codecName) {
  const name = String(codecName || "").trim().toLowerCase();
  if (!name) return "unknown";
  return CODEC_ALIASES[name] || name;
}

/** Parses `ffprobe -print_format json -show_streams` output for the video stream. */
function parseProbeJson(text) {
  let document;
  try {
    document = JSON.parse(String(text || ""));
  } catch (error) {
    return null;
  }
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") || streams[0];
  if (!video || !video.codec_name) return null;

  const [num, den] = String(video.avg_frame_rate || "0/1")
    .split("/")
    .map((part) => Number(part));
  const fps = den > 0 ? Math.round((num / den) * 100) / 100 : null;

  return {
    codec: classifyCodec(video.codec_name),
    codecName: String(video.codec_name),
    profile: video.profile || null,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    fps,
    bitRate: Number(video.bit_rate) || null,
    pixelFormat: video.pix_fmt || null,
    raw: video,
  };
}

/**
 * Runs ffprobe against the RTSP stream.
 *
 * Returns `{ ok, probe, error }`; a missing MFD is a normal situation, not an
 * exception, so callers can render a useful message.
 */
async function probeStream({ url, ffprobePath = "ffprobe", timeoutMs = 15000, execFileImpl } = {}) {
  if (!url) return { ok: false, probe: null, error: "missing stream URL" };
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-rtsp_transport",
    "tcp",
    url,
  ];
  try {
    const { stdout } = await run(ffprobePath, args, { timeout: timeoutMs, execFileImpl });
    const probe = parseProbeJson(stdout);
    if (!probe) {
      return { ok: false, probe: null, error: "ffprobe returned no video stream" };
    }
    return { ok: true, probe, error: null };
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    return { ok: false, probe: null, error: detail || "ffprobe failed" };
  }
}

/**
 * Detects the Raspberry Pi V4L2 M2M H.264 encoder.
 *
 * `available` requires both the ffmpeg encoder and the codec device: reporting
 * a hardware path that cannot encode would break the "never crash the Pi"
 * promise of the plugin.
 */
async function detectHardware({
  ffmpegPath = "ffmpeg",
  execFileImpl,
  platform = process.platform,
  exists = fs.existsSync,
  timeoutMs = 10000,
} = {}) {
  const result = {
    v4l2m2m: false,
    device: platform === "linux" ? exists("/dev/video11") : false,
    available: false,
    detail: "",
  };

  try {
    const { stdout } = await run(ffmpegPath, ["-hide_banner", "-encoders"], {
      timeout: timeoutMs,
      execFileImpl,
    });
    result.v4l2m2m = /h264_v4l2m2m/.test(stdout);
  } catch (error) {
    result.detail = `ffmpeg not usable: ${String(error.message || error).trim()}`;
    return result;
  }

  if (platform !== "linux") {
    result.detail = "h264_v4l2m2m is Linux-only";
    return result;
  }
  if (!result.v4l2m2m) {
    result.detail = "ffmpeg has no h264_v4l2m2m encoder";
    return result;
  }
  if (!result.device) {
    result.detail = "/dev/video11 not present (bcm2835-codec not loaded)";
    return result;
  }

  result.available = true;
  result.detail = "h264_v4l2m2m encoder and /dev/video11 available";
  return result;
}

module.exports = {
  classifyCodec,
  detectHardware,
  parseProbeJson,
  probeStream,
};
