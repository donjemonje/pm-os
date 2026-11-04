# PM-OS local scan station

The local lane of competitor website scanning (Website Scanning PRD, 2026-11-04). A small poller on a PM's Mac — for now Daniel's, as PM-OS operator for every customer — reads competitor websites in the PM's own browser and hands the pages to PM-OS. The station is a server, not a user: a machine key with no expiry, rotated by PM-OS itself every 30 days, revoked in Administration when the Mac is retired.

## One-time setup (the only manual work)

1. Administration → Competitors → Local stations → **New station key**. Copy the key (shown once).
2. On the Mac, from the PM-OS repo:

       sh scripts/pmos-local-scan/install.sh https://app.pm-os.io <key>

   This writes `~/.pmos/station-key`, installs `~/Library/LaunchAgents/com.pm-os.local-scan.plist` (check-in every 15 minutes, also at login) and runs the first check-in.
3. Keep the Mac on the charger with the lid open, "Prevent automatic sleeping when the display is off" on, Chrome open with the Claude extension, Chrome in Login Items. A sleeping Mac runs nothing; requests wait and PM-OS emails support after 24 hours.

## What happens

- Screen locked → waiting scans run without asking.
- Screen active → one dialog lists every waiting site: **Approve** runs them all, **Later** snoozes two hours. A locked screen runs them anyway.
- One scan at a time. Each page is handed in as it is read; PM-OS extracts the text, normalizes, hashes and decides new / changed / unchanged.
- Runner: `claude` (Claude Code + Claude in Chrome: this Chrome, this IP, no bot tag; Claude gets only the browser tools, file writes under the scan's temp folder and the hand-in script) when `claude` is on PATH; `fetch` (plain HTTP from this machine) otherwise or with `--runner fetch`.
- The local lane does not read robots.txt: it is a person's browser acting on a person's intent.

## Flags (tests and troubleshooting)

    node scripts/pmos-local-scan/poller.mjs --app-url http://localhost:3205 --key-file /tmp/key \
      --runner fetch --mac-state locked --answer approve --pause-ms 0 --max-pages 20

`--mac-state active|locked` and `--answer approve|later` replace the real lock state and dialog; `--loop` keeps running instead of one check-in. Log: `~/.pmos/local-scan.log`.
