"use strict";

/**
 * Pipeline selection: decide how the MFD stream reaches the browser.
 *
 * The rule is "copy first". A transcode is only selected when the source codec
 * cannot travel over WebRTC and the platform can do it in hardware (or the
 * operator explicitly allowed software transcoding).
 */

const MODES = Object.freeze({
  COPY: "copy",
  TRANSCODE_HARDWARE: "transcode-hardware",
  TRANSCODE_SOFTWARE: "transcode-software",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown",
});

const CODEC_LABELS = Object.freeze({
  h264: "H.264",
  hevc: "H.265/HEVC",
  mjpeg: "MJPEG",
  mpeg2: "MPEG-2",
  mpeg4: "MPEG-4 Part 2",
  vp8: "VP8",
  vp9: "VP9",
});

function codecLabel(codec) {
  return CODEC_LABELS[codec] || String(codec || "desconocido").toUpperCase();
}

/**
 * Builds the go2rtc source string for a mode.
 *
 * `extraSourceOptions` is appended as a go2rtc fragment (e.g. "#timeout=10").
 */
function buildSource({ mode, rtspUrl, maxWidth, extraSourceOptions = "" }) {
  if (!rtspUrl) return null;
  const extra = extraSourceOptions || "";

  if (mode === MODES.COPY) return `${rtspUrl}${extra}`;

  const width = Number(maxWidth) > 0 ? `#width=${Number(maxWidth)}` : "";
  if (mode === MODES.TRANSCODE_HARDWARE) {
    return `ffmpeg:${rtspUrl}#video=h264#hardware${width}${extra}`;
  }
  if (mode === MODES.TRANSCODE_SOFTWARE) {
    return `ffmpeg:${rtspUrl}#video=h264${width}${extra}`;
  }
  return null;
}

/**
 * Chooses the cheapest pipeline that can actually work.
 *
 * Inputs are plain data so the decision is unit-testable without hardware.
 */
function choosePipeline({ codec, hardware, policy = "hardware-only", rtspUrl, maxWidth, extraSourceOptions } = {}) {
  const normalized = String(codec || "unknown").toLowerCase();
  const base = { codec: normalized, codecLabel: codecLabel(normalized) };

  if (normalized === "h264") {
    return {
      ...base,
      mode: MODES.COPY,
      reason: "H.264: se reenvía sin recodificar, el navegador lo decodifica por hardware",
      warning: null,
      source: buildSource({ mode: MODES.COPY, rtspUrl, maxWidth, extraSourceOptions }),
    };
  }

  if (normalized === "unknown") {
    return {
      ...base,
      mode: MODES.UNKNOWN,
      reason: "No se pudo determinar el códec del stream",
      warning: null,
      source: null,
    };
  }

  if (policy === "off") {
    return {
      ...base,
      mode: MODES.UNSUPPORTED,
      reason: `${codecLabel(normalized)} no se puede enviar por WebRTC sin recodificar y transcodePolicy=off`,
      warning: null,
      source: null,
    };
  }

  if (hardware && hardware.available) {
    return {
      ...base,
      mode: MODES.TRANSCODE_HARDWARE,
      reason: `${codecLabel(normalized)}: recodificado a H.264 con el encoder hardware (v4l2m2m)`,
      warning: "Recodificando con hardware: consumo moderado y latencia algo mayor",
      source: buildSource({
        mode: MODES.TRANSCODE_HARDWARE,
        rtspUrl,
        maxWidth,
        extraSourceOptions,
      }),
    };
  }

  if (policy === "allow-software") {
    return {
      ...base,
      mode: MODES.TRANSCODE_SOFTWARE,
      reason: `${codecLabel(normalized)}: recodificado a H.264 por software (libx264)`,
      warning: "Recodificando por software: consumo alto de CPU, el Pi puede calentarse",
      source: buildSource({
        mode: MODES.TRANSCODE_SOFTWARE,
        rtspUrl,
        maxWidth,
        extraSourceOptions,
      }),
    };
  }

  return {
    ...base,
    mode: MODES.UNSUPPORTED,
    reason:
      `${codecLabel(normalized)} no se puede enviar por WebRTC sin recodificar y no hay ` +
      "encoder hardware disponible. Abre el RTSP en VLC o pon transcodePolicy=allow-software.",
    warning: null,
    source: null,
  };
}

function isCopy(pipeline) {
  return Boolean(pipeline) && pipeline.mode === MODES.COPY;
}

function isStreamable(pipeline) {
  return Boolean(pipeline) && Boolean(pipeline.source);
}

module.exports = {
  MODES,
  buildSource,
  choosePipeline,
  codecLabel,
  isCopy,
  isStreamable,
};
