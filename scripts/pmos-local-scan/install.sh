#!/bin/sh
# Install a PM-OS local scan station on this Mac — one per environment, side by side (dev + prod).
#   sh scripts/pmos-local-scan/install.sh <env> <pm-os origin> [machine key]
#   e.g. install.sh dev http://localhost:3000 pmosk_…    install.sh prod https://app.pm-os.io pmosk_…
# Writes ~/.pmos/<env>/station-key (when a key is given), the LaunchAgent com.pm-os.local-scan.<env> with this
# repo's paths, loads it, and runs the first check-in. Re-running replaces that environment's agent only.
set -e
ENV_NAME="${1:?usage: install.sh <env> <pm-os origin> [machine key]}"
APP_URL="${2:?usage: install.sh <env> <pm-os origin> [machine key]}"
KEY="$3"
case "$ENV_NAME" in *[!a-z0-9_-]*) echo "env must be letters, digits, - or _"; exit 2;; esac
HOME_DIR="$HOME"
STATE_DIR="$HOME_DIR/.pmos/$ENV_NAME"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
LABEL="com.pm-os.local-scan.$ENV_NAME"
mkdir -p "$STATE_DIR" "$HOME_DIR/Library/LaunchAgents"
if [ -n "$KEY" ]; then
  printf '%s' "$KEY" > "$STATE_DIR/station-key"
  chmod 600 "$STATE_DIR/station-key"
fi
[ -f "$STATE_DIR/station-key" ] || { echo "no key: pass it as the third argument or save it to $STATE_DIR/station-key"; exit 2; }
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
sed -e "s#__LABEL__#$LABEL#g" -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__APP_URL__#$APP_URL#g" \
    -e "s#__STATE_DIR__#$STATE_DIR#g" -e "s#__HOME__#$HOME_DIR#g" \
  "$REPO/scripts/pmos-local-scan/com.pm-os.local-scan.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# First check-in BEFORE the agent loads: the agent runs at load too, and two check-ins at once must not race for one scan.
echo "first check-in now:"
"$NODE" "$REPO/scripts/pmos-local-scan/poller.mjs" --app-url "$APP_URL" --state-dir "$STATE_DIR"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $PLIST (checks in every 15 min; log: $STATE_DIR/local-scan.log)"
