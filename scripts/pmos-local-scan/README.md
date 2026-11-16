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
- Several scans at the same time (Daniel 2026-11-16) — see "Parallel scans" below. The station reads each site itself (v1, Daniel 2026-11-08): sitemap plus the links on every page, same site only, a browser identity, 2 s between pages of one site, stop on 429. Pages with no text, and home/hub pages whose menus are built by JavaScript, are rendered with the installed Chrome headless. PDFs are downloaded and handed in as documents. Each page is handed in as it is read; PM-OS extracts the text, normalizes, hashes and decides new / changed / unchanged.
- The local lane reads robots.txt only for its Sitemap lines (then /sitemap.xml and /sitemap_index.xml, indexes followed). Its crawl restrictions are never obeyed: it is a person's machine acting on a person's intent, and pages a site hides from bots are brought too.
- `--runner claude` (Claude Code + Claude in Chrome) stays available for later judgment work; it cannot export a real page's HTML unattended, so it is not the default. It reads one site at a time.

## Parallel scans (2026-11-16)

Nine waiting sites used to take the sum of their times. Different sites have no reason to wait for each other; only requests to the same site must stay slow.

- The station reads **up to 10 sites at the same time**. 10 is a safety net for the Mac and for PM-OS, not a working limit: `--max-parallel N` changes it (`PMOS_MAX_PARALLEL=N sh install.sh …` for the installed station).
- **Never two scans of one site together** — the second waits for the first. "Site" is the host without `www.` (plus a non-default port); a subdomain is another site. The 2 s pause is between two pages of one site, so every site sees what it saw before: one request per pause.
- More than 10 waiting: the rest wait their turn, oldest request first, and start as running scans end. A scan held back by its site does not hold back the ones after it. The log says when scans waited and why (the limit, or their site).
- While scans run the station checks in again every 15 minutes, so a scan requested in the meantime starts without waiting for the running ones to end. The 15-minute LaunchAgent run finds the station busy and exits, as before.
- Everything else is per scan, unchanged: the pause, the time limit (`--max-minutes`), the saved place, the hand-in of each page, the done call, PDFs. Network lost: every running scan waits and is parked on its own; no new scan is started until the next check-in.
- **What each runner can do.** `fetch` (default): parallel — each scan is its own loop of plain HTTP reads. The one shared thing is the headless Chrome: it has one profile folder, so pages that need rendering are rendered **one at a time** across all running scans (a scan renders 40 pages at most; the others keep reading meanwhile). `claude`: **not parallel** — it drives the one Chrome on this Mac through one browser session and keeps no saved place, so it reads one site at a time whatever `--max-parallel` says. The log says which applies at each check-in with more than one scan waiting.
- Log (`local-scan.log`): every line of a scan starts with its site — `[acme.com]   new https://acme.com/pricing` — so parallel scans stay readable (`grep '\[acme.com\]'`).
- Status file (`status.json`, read by the menu bar icon): `competitor`, `site`, `pagesRead` and `scanStartedAt` describe the **oldest running scan**, `waiting` is the number of scans not started yet — what they always meant. New: `running` (how many scans are being read) and `scans` (one entry per running scan: `scanId`, `competitor`, `site`, `pagesRead`, `startedAt`, `state`). The menu line reads "scanning Acme + 4 more · …" once the menu app is rebuilt (`sh scripts/pmos-local-scan/install-menu.sh`); the installed one keeps working and shows the oldest scan.

## Flags (tests and troubleshooting)

    node scripts/pmos-local-scan/poller.mjs --app-url http://localhost:3205 --key-file /tmp/key \
      --runner fetch --pause-ms 0 --max-minutes 5

`--render off` disables headless Chrome; `--loop` keeps running instead of one check-in; `--max-parallel N` sets how many scans are read at the same time (default 10; 1 = the old one-at-a-time station); `--recheck-ms N` sets how often a busy station asks for new waiting scans (default 15 minutes). Log: `~/.pmos/<env>/local-scan.log`; status for the menu bar icon: `~/.pmos/<env>/status.json`.

## A scan that stops in the middle (2026-11-12)

The station saves each scan's place in its own file, `<state-dir>/scan-state/<scan id>.json`, before every page (pages left, pages seen, counters). A station that stops while it reads five sites leaves five files; each scan continues on its own. The single `<state-dir>/scan-state.json` of the one-scan-at-a-time station is picked up at the first check-in: it becomes that scan's own file, unchanged, and the scan continues from the page it stopped on.

- **Network lost:** a failed read is checked against two neutral addresses. Offline → the station waits up to 5 minutes and reads the same page again (no page is marked "not read"). Still offline → the scan is parked with reason `network`.
- **Shutdown / logout / station stopped:** the signal handler marks the place `shutdown`.
- **Crash / power cut:** the place has no reason → reported as `crash`.
- **Mac asleep:** the process freezes and continues; a read that slept is read again, not counted as a failure.

At the next check-in the station reports every such scan, with the reason, the time and the page counts (`?resume=…`, repeated once per scan). PM-OS puts the scans back to waiting at once, writes the reason into each scan log, and the station continues each from the page it stopped on. A file is deleted when its scan is handed in or no longer wanted by PM-OS.
