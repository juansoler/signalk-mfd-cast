#!/usr/bin/env bash
#
# Downloads the go2rtc binary for this machine into the plugin data directory.
#
# Usage:
#   ./scripts/install-go2rtc.sh            # ~/.signalk/plugin-config-data/signalk-mfd-cast/bin
#   ./scripts/install-go2rtc.sh /custom/dir
#
set -euo pipefail

DATA_DIR="${1:-${SIGNALK_NODE_CONFIG_DIR:-$HOME/.signalk}/plugin-config-data/signalk-mfd-cast}"

case "$(uname -m)" in
  aarch64 | arm64) ASSET="go2rtc_linux_arm64" ;;
  armv7l | armv7) ASSET="go2rtc_linux_arm" ;;
  armv6l) ASSET="go2rtc_linux_armv6" ;;
  x86_64 | amd64) ASSET="go2rtc_linux_amd64" ;;
  i386 | i686) ASSET="go2rtc_linux_i386" ;;
  *)
    echo "Arquitectura no soportada: $(uname -m)" >&2
    exit 1
    ;;
esac

URL="https://github.com/AlexxIT/go2rtc/releases/latest/download/${ASSET}"
TARGET="${DATA_DIR}/bin/go2rtc"

mkdir -p "${DATA_DIR}/bin"

echo "Descargando ${ASSET}..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --progress-bar -o "${TARGET}.tmp" "${URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${TARGET}.tmp" "${URL}"
else
  echo "Hace falta curl o wget" >&2
  exit 1
fi

mv "${TARGET}.tmp" "${TARGET}"
chmod +x "${TARGET}"

echo
echo "go2rtc instalado en: ${TARGET}"
ls -lh "${TARGET}"
echo
echo "Reinicia Signal K para que el plugin lo encuentre:"
echo "  sudo systemctl restart signalk"
