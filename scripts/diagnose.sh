#!/usr/bin/env bash
#
# One-shot diagnostics for signalk-mfd-cast.
#
# Usage:
#   ./scripts/diagnose.sh 192.168.0.10
#   ./scripts/diagnose.sh 192.168.0.10 554 /screenmirror
#
# The output is safe to paste into a message: it contains no credentials.
#
set -u

IP="${1:-}"
PORT="${2:-554}"
STREAM_PATH="${3:-/screenmirror}"
URL="rtsp://${IP}:${PORT}${STREAM_PATH}"

line() { printf '\n=== %s ===\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

line "Sistema"
date
uname -a
uname -m
if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "OS: ${PRETTY_NAME:-desconocido}"
fi
if have node; then echo "node: $(node -v)"; fi
if have free; then free -m | head -2; fi
if have vcgencmd; then echo "temperatura: $(vcgencmd measure_temp 2>/dev/null)"; fi

line "ffmpeg / ffprobe"
if have ffmpeg; then
  ffmpeg -hide_banner -version | head -1
  echo "encoders v4l2m2m:"
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -i v4l2m2m || echo "  (ninguno)"
else
  echo "ffmpeg NO instalado  ->  sudo apt install ffmpeg"
fi
if have ffprobe; then ffprobe -version | head -1; else echo "ffprobe NO instalado"; fi

line "Codificador hardware (Raspberry Pi)"
ls -l /dev/video* 2>/dev/null || echo "  no hay /dev/video*"
if [ -e /dev/video11 ]; then
  echo "  /dev/video11 presente (encoder H.264 bcm2835-codec)"
else
  echo "  /dev/video11 ausente: no habrá transcoding hardware"
fi

line "go2rtc"
GO2RTC="${SIGNALK_NODE_CONFIG_DIR:-$HOME/.signalk}/plugin-config-data/signalk-mfd-cast/bin/go2rtc"
if [ -x "$GO2RTC" ]; then
  echo "  $GO2RTC"
  ls -lh "$GO2RTC"
elif have go2rtc; then
  echo "  go2rtc en PATH: $(command -v go2rtc)"
else
  echo "  go2rtc NO instalado  ->  ./scripts/install-go2rtc.sh"
fi

line "Red"
if have ip; then
  ip -4 addr show scope global 2>/dev/null | grep -E 'inet |^[0-9]+:' || true
elif have ifconfig; then
  ifconfig | grep -E 'inet |^[a-z]' || true
fi

if [ -z "$IP" ]; then
  echo
  echo "Sin IP de MFD: se omite el análisis del stream."
  echo "Uso: $0 <ip-del-mfd> [puerto] [ruta]"
  exit 0
fi

line "Stream RTSP (${URL})"
if ! have ffprobe; then
  echo "ffprobe no disponible; no se puede analizar el stream."
  exit 1
fi

PROBE_OUTPUT="$(timeout 25 ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height,avg_frame_rate,bit_rate,pix_fmt \
  -of default=noprint_wrappers=1 "$URL" 2>&1)"
PROBE_STATUS=$?

if [ $PROBE_STATUS -ne 0 ]; then
  echo "ffprobe falló (código $PROBE_STATUS):"
  echo "$PROBE_OUTPUT"
  echo
  echo "Comprueba que el Pi está en la red del MFD y que la IP es correcta."
  exit 1
fi

echo "$PROBE_OUTPUT"

CODEC="$(printf '%s\n' "$PROBE_OUTPUT" | sed -n 's/^codec_name=//p')"
echo
case "$CODEC" in
  h264)
    echo "VEREDICTO: H.264 -> el plugin puede COPIAR el stream (2-5% CPU, sin recodificar)."
    ;;
  mjpeg)
    echo "VEREDICTO: MJPEG -> no viaja por WebRTC; hará falta recodificar a H.264."
    ;;
  "")
    echo "VEREDICTO: no se pudo leer el códec."
    ;;
  *)
    echo "VEREDICTO: ${CODEC} -> no viaja por WebRTC; hará falta recodificar a H.264."
    if [ -e /dev/video11 ] && have ffmpeg && ffmpeg -hide_banner -encoders 2>/dev/null | grep -qi h264_v4l2m2m; then
      echo "  Hay encoder hardware disponible: el plugin lo usará (8-15% CPU)."
    else
      echo "  Sin encoder hardware: el plugin se negará a recodificar por software."
    fi
    ;;
esac

line "Coste de decodificar (referencia, no es el coste del plugin)"
# 5 segundos de stream a null: utime es el tiempo de CPU empleado en decodificar.
timeout 25 ffmpeg -hide_banner -benchmark -rtsp_transport tcp -i "$URL" \
  -t 5 -an -f null - 2>&1 | grep -E 'bench:|frame=' | tail -3 || true

echo
echo "Copia esta salida completa si necesitas ayuda."
