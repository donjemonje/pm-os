# PM-OS local scan station

The local lane of competitor website scanning (Website Scanning PRD, 2026-11-04). A small poller on a PM's Mac — for now Daniel's, as PM-OS operator for every customer — reads competitor websites from the PM's Mac with a browser identity and hands the pages to PM-OS. The station is a server, not a user: a machine key with no expiry, rotated by PM-OS itself every 30 days, revoked in Administration when the Mac is retired.

## One-time setup (the only manual work)

1. Administration → Competitors → Local stations → **New station key**. Copy the key (shown once).
2. On the Mac, from the PM-OS repo:

       sh scripts/pmos-local-scan/install.sh prod https://app.pm-os.io <key>

   This writes `~/.pmos/prod/station-key`, installs `~/Library/LaunchAgents/com.pm-os.local-scan.prod.plist` (check-in every 15 minutes, also at login) and runs the first check-in. One station per environment, side by side: `install.sh dev http://localhost:3000 <dev key>` for the dev server. Each environment has its own key, state folder and log.
3. Keep the Mac on the charger with the lid open, "Prevent automatic sleeping when the display is off" on. Chrome installed (used headless for pages that need JavaScript). A sleeping Mac runs nothing; requests wait and PM-OS emails support after 24 hours.

## What happens

- Waiting scans start at the next check-in, without asking (Daniel 2026-11-12): the scan reads the site in the background, not in the PM's browser, so there is no dialog and no snooze.
- A small icon in the menu bar shows the station: dimmed when idle, the icon plus the page count while a scan is read, a warning sign when a station has not checked in for 20 minutes or cannot reach PM-OS. Its menu has one line per environment, the last scan, **Check in now** and **Open log**. It reads `~/.pmos/<env>/status.json`, which the poller writes. Installed by `install.sh` (or alone: `sh scripts/pmos-local-scan/install-menu.sh`); needs the Xcode command line tools.
- One scan at a time. The station reads the site itself (v1, Daniel 2026-11-08): sitemap plus the links on every page, same site only, a browser identity, 2 s between pages, stop on 429. Pages with no text, and home/hub pages whose menus are built by JavaScript, are rendered with the installed Chrome headless. PDFs are downloaded and handed in as documents. Each page is handed in as it is read; PM-OS extracts the text, normalizes, hashes and decides new / changed / unchanged.
- The local lane reads robots.txt only for its Sitemap lines (then /sitemap.xml and /sitemap_index.xml, indexes followed). Its crawl restrictions are never obeyed: it is a person's machine acting on a person's intent, and pages a site hides from bots are brought too.
- `--runner claude` (Claude Code + Claude in Chrome) stays available for later judgment work; it cannot export a real page's HTML unattended, so it is not the default.

## Flags (tests and troubleshooting)

    node scripts/pmos-local-scan/poller.mjs --app-url http://localhost:3205 --key-file /tmp/key \
      --runner fetch --pause-ms 0 --max-minutes 5

`--render off` disables headless Chrome; `--loop` keeps running instead of one check-in. Log: `~/.pmos/<env>/local-scan.log`; status for the menu bar icon: `~/.pmos/<env>/status.json`.

## A scan that stops in the middle (2026-11-12)

The station saves the scan's place in `<state-dir>/scan-state.json` before every page (pages left, pages seen, counters).

- **Network lost:** a failed read is checked against two neutral addresses. Offline → the station waits up to 5 minutes and reads the same page again (no page is marked "not read"). Still offline → the scan is parked with reason `network`.
- **Shutdown / logout / station stopped:** the signal handler marks the place `shutdown`.
- **Crash / power cut:** the place has no reason → reported as `crash`.
- **Mac asleep:** the process freezes and continues; a read that slept is read again, not counted as a failure.

At the next check-in the station reports the scan, the reason, the time and the page counts (`?resume=…`). PM-OS puts the scan back to waiting at once, writes the reason into the scan log, and the station continues from the page it stopped on. The file is deleted when the scan is handed in or no longer wanted by PM-OS.
