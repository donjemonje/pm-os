#!/bin/sh
# Install the PM-OS local station's menu bar indicator on this Mac (one icon for every installed environment).
#   sh scripts/pmos-local-scan/install-menu.sh
# Compiles menubar.swift to ~/.pmos/bin/pmos-station-menu (needs the Xcode command line tools: xcode-select --install),
# writes the LaunchAgent com.pm-os.local-scan.menu and loads it. Re-running replaces it. install.sh runs this too.
# Remove: launchctl bootout gui/$(id -u)/com.pm-os.local-scan.menu; rm ~/Library/LaunchAgents/com.pm-os.local-scan.menu.plist
set -e
ROOT="$HOME/.pmos"
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.pm-os.local-scan.menu"
BIN="$ROOT/bin/pmos-station-menu"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
command -v swiftc >/dev/null 2>&1 || { echo "menu bar indicator not installed: swiftc is missing (xcode-select --install), the station itself works without it"; exit 0; }
mkdir -p "$ROOT/bin" "$HOME/Library/LaunchAgents"
swiftc -O -swift-version 5 "$DIR/menubar.swift" -o "$BIN.new"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
mv "$BIN.new" "$BIN"
sed -e "s#__BIN__#$BIN#g" -e "s#__ROOT__#$ROOT#g" "$DIR/$LABEL.plist" > "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: the PM-OS station icon is in the menu bar ($PLIST)"
