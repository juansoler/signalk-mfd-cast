#!/usr/bin/env bash
#
# Copies this plugin into a Signal K installation.
#
# Usage:
#   ./scripts/install-local.sh            # copy only
#   ./scripts/install-local.sh --go2rtc   # also download go2rtc
#
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${SIGNALK_NODE_CONFIG_DIR:-$HOME/.signalk}/node_modules/signalk-mfd-cast"

mkdir -p "${DEST}"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules \
    --exclude .git \
    "${SRC}/" "${DEST}/"
else
  cp -R "${SRC}/." "${DEST}/"
  rm -rf "${DEST}/node_modules" "${DEST}/.git"
fi

echo "Plugin copiado a ${DEST}"

if [ "${1:-}" = "--go2rtc" ]; then
  "${SRC}/scripts/install-go2rtc.sh"
else
  echo
  echo "Recuerda instalar go2rtc si no lo has hecho todavía:"
  echo "  ./scripts/install-go2rtc.sh"
fi

echo
echo "Reinicia Signal K:"
echo "  sudo systemctl restart signalk"
echo
echo "Visor: http://<ip-del-pi>:3000/signalk-mfd-cast/"
