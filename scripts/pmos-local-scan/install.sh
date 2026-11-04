#!/bin/sh
# Install the PM-OS local scan station on this Mac — the one-time setup (zero manual work afterwards).
#   sh scripts/pmos-local-scan/install.sh <pm-os origin> [machine key]
# Writes ~/.pmos/station-key (when a key is given), the LaunchAgent plist with this repo's paths, loads it,
# and runs the first check-in.
set -e
APP_URL="${1:?usage: install.sh <pm-os origin> [machine key]}"
KEY="$2"
HOME_DIR="$HOME"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
mkdir -p "$HOME_DIR/.pmos" "$HOME_DIR/Library/LaunchAgents"
if [ -n "$KEY" ]; then
  printf '%s' "$KEY" > "$HOME_DIR/.pmos/station-key"
  chmod 600 "$HOME_DIR/.pmos/station-key"
fi
[ -f "$HOME_DIR/.pmos/station-key" ] || { echo "no key: pass it as the second argument or save it to ~/.pmos/station-key"; exit 2; }
PLIST="$HOME_DIR/Library/LaunchAgents/com.pm-os.local-scan.plist"
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__APP_URL__#$APP_URL#g" -e "s#__HOME__#$HOME_DIR#g" \
  "$REPO/scripts/pmos-local-scan/com.pm-os.local-scan.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.pm-os.local-scan" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $PLIST (checks in every 15 min; log: ~/.pmos/local-scan.log)"
echo "first check-in now:"
"$NODE" "$REPO/scripts/pmos-local-scan/poller.mjs" --app-url "$APP_URL"
