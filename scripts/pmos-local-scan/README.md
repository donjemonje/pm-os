# PM-OS local scan station

The local lane of competitor website scanning (Website Scanning PRD, 2026-11-04). A small poller on a PM's Mac — for now Daniel's, as PM-OS operator for every customer — reads competitor websites from the PM's Mac with a browser identity and hands the pages to PM-OS. The station is a server, not a user: a machine key with no expiry, rotated by PM-OS itself every 30 days, revoked in Administration when the Mac is retired.

## One-time setup (the only manual work)

1. Administration → Competitors → Local stations → **New station key**. Copy the key (shown once).
2. On the Mac, from the PM-OS repo:

       sh scripts/pmos-local-scan/install.sh prod https://app.pm-os.io <key>

   This writes `~/.pmos/prod/station-key`, installs `~/Library/LaunchAgents/com.pm-os.local-scan.prod.plist` (check-in every 15 minutes, also at login) and runs the first check-in. One station per environment, side by side: `install.sh dev http://localhost:3000 <dev key>` for the dev server. Each environment has its own key, state folder and log.
3. Keep the Mac on the charger with the lid open, "Prevent automatic sleeping when the display is off" on. Chrome installed (used headless for pages that need JavaScript). A sleeping Mac runs nothing; requests wait and PM-OS emails support after 24 hours.

## What happens

- Screen locked → waiting scans run without asking.
- Screen active → one dialog lists every waiting site: **Approve** runs them all, **Later** snoozes two hours. A locked screen runs them anyway.
- One scan at a time. The station reads the site itself (v1, Daniel 2026-11-08): sitemap plus the links on every page, same site only, a browser identity, 2 s between pages, stop on 429. Pages with no text, and home/hub pages whose menus are built by JavaScript, are rendered with the installed Chrome headless. PDFs are downloaded and handed in as documents. Each page is handed in as it is read; PM-OS extracts the text, normalizes, hashes and decides new / changed / unchanged.
- The local lane reads robots.txt only for its Sitemap lines (then /sitemap.xml and /sitemap_index.xml, indexes followed). Its crawl restrictions are never obeyed: it is a person's machine acting on a person's intent, and pages a site hides from bots are brought too.
- `--runner claude` (Claude Code + Claude in Chrome) stays available for later judgment work; it cannot export a real page's HTML unattended, so it is not the default.

## Flags (tests and troubleshooting)

    node scripts/pmos-local-scan/poller.mjs --app-url http://localhost:3205 --key-file /tmp/key \
      --runner fetch --mac-state locked --answer approve --pause-ms 0 --max-pages 20

`--mac-state active|locked` and `--answer approve|later` replace the real lock state and dialog; `--render off` disables headless Chrome; `--loop` keeps running instead of one check-in. Log: `~/.pmos/<env>/local-scan.log`.
