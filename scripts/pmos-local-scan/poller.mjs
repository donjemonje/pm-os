#!/usr/bin/env node
/**
 * PM-OS local scan station — the poller (Website Scanning PRD 2026-11-04).
 *
 * Runs on a PM's Mac (for now Daniel's, as PM-OS operator for every
 * customer). Every 15 minutes it asks PM-OS which competitor scans are
 * waiting for a station and runs them, without asking (Daniel 2026-11-12:
 * the scan reads the site in the background, not in the PM's browser, so
 * there is nothing to approve). Scans run one at a time. What the station is
 * doing is written to <state-dir>/status.json, which the menu bar indicator
 * (menubar.swift) shows. The station is a server:
 * it holds a machine key with no expiry (~/.pmos/station-key), which PM-OS
 * rotates on its own every 30 days through the check-in call.
 *
 * Runners (how pages are read):
 *   fetch   DEFAULT (v1, Daniel 2026-11-08): the station reads the site itself
 *           from this Mac with a browser identity — sitemaps (robots.txt
 *           Sitemap lines, /sitemap.xml, /sitemap_index.xml, indexes followed)
 *           plus the links on every page, same site only; robots.txt rules are
 *           read for discovery only, never obeyed (a person's intent), a
 *           pause between pages, stop on 429. Pages that come back empty, and
 *           the home / hub pages when their navigation is built by JavaScript,
 *           are rendered with the installed Chrome in headless mode. PDFs are
 *           downloaded and handed in as documents.
 *   claude  Claude Code with Claude in Chrome — kept for later (judgment on odd
 *           sites); it cannot export a real page's HTML unattended, so it is
 *           not the default. --runner claude selects it.
 *           Same hand-in route either way; the server extracts, normalizes and hashes.
 *
 * No dependencies. Node 20+.
 *
 *   node poller.mjs                          one check-in (the LaunchAgent runs it every 15 min)
 *   node poller.mjs --loop                   keep running, check in every 15 min
 *   --app-url URL        PM-OS origin (default: PMOS_APP_URL or https://app.pm-os.io)
 *   --key-file PATH      machine key file (default: ~/.pmos/station-key)
 *   --runner fetch|claude (default fetch)
 *   --render auto|off    headless Chrome for empty pages and JS-built navigation (default auto; off = plain fetch only)
 *   --chrome PATH        the Chrome binary (default: PMOS_CHROME, else the Mac's /Applications path)
 *   --pause-ms N         pause between pages in the fetch runner (default 2000)
 *   --max-minutes N      stop a scan after N minutes (default: the server's time limit, 8 h; no page limit)
 *   --state-dir PATH     where the status file and the log live (default ~/.pmos)
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const STATE_DIR = flag("state-dir", join(homedir(), ".pmos"));
const KEY_FILE = flag("key-file", join(STATE_DIR, "station-key"));
const APP_URL = (flag("app-url", process.env.PMOS_APP_URL || "https://app.pm-os.io")).replace(/\/+$/, "");
const STATUS_FILE = join(STATE_DIR, "status.json");
const LOG_FILE = join(STATE_DIR, "local-scan.log");
const POLL_MS = 15 * 60_000;
const PAUSE_MS = Number(flag("pause-ms", "2000"));
const RENDER = flag("render", "auto");
const CHROME = flag("chrome", process.env.PMOS_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
/** Headless renders per scan are bounded: home, hubs and empty pages only. */
const MAX_RENDERS = 40;
/** The render's own Chrome profile (never the PM's). */
const CHROME_PROFILE = join(STATE_DIR, "chrome-profile");
const MAX_MINUTES_FLAG = Number(flag("max-minutes", "0")) || 0;
/** A browser's own identity — this is a person's machine, not the PM-OS crawler. */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

mkdirSync(STATE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // no log file, fine
  }
}

/**
 * What the station is doing, for the menu bar indicator: one small JSON file, replaced whole on every change.
 *   state      "idle" | "scanning" | "unreachable"
 *   lastCheckIn, message, and while scanning: competitor, site, pagesRead, scanStartedAt, waiting (scans after this one)
 *   lastScan   { competitor, pagesRead, finishedAt, result } of the scan that ended last
 */
let station = { appUrl: APP_URL, state: "idle" };
try {
  const prev = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
  if (prev && typeof prev === "object") station = { ...station, lastCheckIn: prev.lastCheckIn, lastScan: prev.lastScan, station: prev.station };
} catch {
  // first run, or an unreadable file: start clean
}
function status(patch) {
  station = { ...station, ...patch, appUrl: APP_URL, updatedAt: new Date().toISOString() };
  try {
    writeFileSync(`${STATUS_FILE}.tmp`, JSON.stringify(station, null, 1));
    renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
  } catch {
    // the indicator is a convenience: a status file that cannot be written never stops a scan
  }
}

// ————— The scan's saved place (Daniel 2026-11-12) —————
//
// One file, written before every page: what is left to read, what was already seen, the counters. Whatever stops the
// station — the network, a shutdown, a crash, a power cut — the next check-in finds this file, tells PM-OS why the scan
// stopped, and continues with the page it was on. The file is removed only when the scan is over on the server.

const SCAN_STATE_FILE = join(STATE_DIR, "scan-state.json");
/** Offline: wait this long for the network before the scan is parked for the next check-in. */
const OFFLINE_WAIT_MS = Number(flag("offline-wait-ms", String(5 * 60_000)));
const OFFLINE_PROBE_EVERY_MS = Number(flag("offline-probe-ms", "15000"));
/** Two neutral "is the internet there" addresses (the ones macOS and Android use). Nothing of PM-OS or the scan is sent. */
const PROBES = flag("probe-urls", "http://captive.apple.com/hotspot-detect.html,https://www.gstatic.com/generate_204").split(",").filter(Boolean);

function loadScanState() {
  try {
    const s = JSON.parse(readFileSync(SCAN_STATE_FILE, "utf8"));
    return s && typeof s.scanId === "string" && Array.isArray(s.queue) && Array.isArray(s.seen) ? s : null;
  } catch {
    return null;
  }
}

function saveScanState(state) {
  try {
    writeFileSync(`${SCAN_STATE_FILE}.tmp`, JSON.stringify({ ...state, savedAt: new Date().toISOString() }));
    renameSync(`${SCAN_STATE_FILE}.tmp`, SCAN_STATE_FILE);
  } catch (e) {
    log(`  could not save the scan's place: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function clearScanState() {
  try {
    unlinkSync(SCAN_STATE_FILE);
  } catch {
    // nothing saved
  }
}

/** Marks why the scan stopped, on the place already saved. Synchronous: it runs in signal and crash handlers. */
function markStopped(reason, detail) {
  const s = loadScanState();
  if (!s || s.stopped) return;
  saveScanState({ ...s, stopped: { reason, at: new Date().toISOString(), ...(detail ? { detail: String(detail).slice(0, 200) } : {}) } });
}

/** True when this Mac reaches the internet at all — tells "the site did not answer" from "we are offline". */
async function online() {
  for (const u of PROBES) {
    try {
      await fetch(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    markStopped("shutdown");
    log(`station stopped (${sig})${loadScanState() ? " — the scan's place is saved" : ""}`);
    process.exit(0);
  });
}
process.on("uncaughtException", (e) => {
  markStopped("error", e instanceof Error ? e.message : e);
  log(`station error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
  process.exit(1);
});

function readKey() {
  if (!existsSync(KEY_FILE)) {
    log(`no machine key at ${KEY_FILE} — create one in Administration → Competitors → Local stations and save it there`);
    process.exit(2);
  }
  return readFileSync(KEY_FILE, "utf8").trim();
}

async function whichRunner() {
  const want = flag("runner", "");
  if (want === "claude") {
    try {
      await run("which", ["claude"]);
      return "claude";
    } catch {
      log("--runner claude asked for but `claude` is not on PATH — using the fetch runner");
    }
  }
  return "fetch";
}

// ————— PM-OS API —————

async function api(path, init = {}, timeoutMs = 120_000) {
  const res = await fetch(`${APP_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json?.error ?? text.slice(0, 200)}`);
  return json;
}

async function checkIn(key, saved) {
  // A saved place means the last scan did not finish on this station: PM-OS hears which scan, why and when, and hands it back.
  const resume = saved
    ? `?${new URLSearchParams({ resume: saved.scanId, reason: saved.stopped?.reason ?? "crash", stoppedAt: saved.stopped?.at ?? saved.savedAt ?? "", pages: String(saved.pagesRead ?? 0), left: String(saved.queue.length) })}`
    : "";
  const json = await api(`/api/competitors/local/waiting${resume}`, { headers: { authorization: `Bearer ${key}` } });
  if (json.rotatedKey) {
    writeFileSync(KEY_FILE, json.rotatedKey, { mode: 0o600 });
    log("machine key rotated by PM-OS (30 days) — new key stored");
  }
  return json;
}

// ————— Runners —————

function registrable(hostname) {
  const lower = hostname.toLowerCase();
  if (/^[\d.]+$/.test(lower) || lower.includes(":") || !lower.includes(".")) return lower;
  const parts = lower.split(".");
  if (parts.length <= 2) return parts.join(".");
  const two = new Set(["co.uk", "org.uk", "co.il", "org.il", "com.au", "co.jp", "co.nz", "co.za", "com.br", "co.in"]);
  const last2 = parts.slice(-2).join(".");
  return two.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** The same "site" rule as the server: the hostname without a leading www., plus a non-default port (subdomains are other sources). */
function siteOf(u) {
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}`;
}

/**
 * Canonical page key (same rule as the server's pageKey): no trailing slash, no query or hash, and the http/https and
 * www/bare copies of the site's own host collapse onto the site's address — one page, one row.
 */
function pageKey(u, siteUrl) {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const s = new URL(siteUrl);
  const same = siteOf(u) === siteOf(s);
  return `${same ? s.protocol : u.protocol}//${same ? s.host.toLowerCase() : u.host.toLowerCase()}${path}`;
}

const NON_PAGE = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|tgz|bz2|7z|rar|tar|dmg|exe|msi|pkg|apk|iso|bin|docx?|pptx?|xlsx?|mp4|mp3|m4a|wav|ogg|mov|avi|webm|woff2?|ttf|eot|txt|csv)$/i;
/** PDFs bigger than this are not read — the same limit as PM-OS's hand-in route (a 300-page brochure is not a product page). */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Hub pages whose navigation often needs JavaScript: home and the first-level sections. */
function isHub(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  return parts.length === 0 || (parts.length === 1 && /^(products?|platform|solutions?|pricing|plans|resources?|blog|news|docs|documentation|integrations?|partners?|customers?|company|about)$/i.test(parts[0]));
}

/** Rough visible-text size of an HTML document (the server decides for real; this only picks what to render). */
function roughText(html) {
  return html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function inSiteLinks(html, base, host) {
  let n = 0;
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    try {
      const u = new URL(m[1].trim(), base);
      if (siteOf(u) === host) n++;
    } catch {
      // skip
    }
  }
  return n;
}

let chromeChecked = null;
async function chromeAvailable() {
  if (RENDER === "off") return false;
  if (chromeChecked == null) chromeChecked = existsSync(CHROME);
  return chromeChecked;
}

/** Render a page with the installed Chrome, headless, and return the DOM after the page ran. null on failure. */
async function renderWithChrome(url) {
  try {
    // Its own profile folder: without one Chrome hands the URL to the PM's running Chrome and prints nothing.
    const { stdout } = await run(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${CHROME_PROFILE}`, `--user-agent=${BROWSER_UA}`, "--virtual-time-budget=6000", "--timeout=30000", "--dump-dom", url], { timeout: 45_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout && stdout.length > 100 ? stdout : null;
  } catch (e) {
    log(`  render failed ${url}: ${String(e).split("\n")[0].slice(0, 120)}`);
    return null;
  }
}

/**
 * One attempt to read a page with this machine's own HTTP. The same rules as the remote lane (fetcher.ts): a redirect
 * that leaves the site is "not found" (one domain per source — and nothing a competitor's page points at on this Mac's
 * own network is ever read); a download (installer, archive, office file) is not a page; a PDF over 20 MB is not read.
 */
async function readOnce(url, started, host) {
  try {
    const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const ms = Date.now() - started;
    const finalUrl = new URL(res.url || url);
    if (siteOf(finalUrl) !== host) return { url, status: "notfound", ms, error: `redirected outside the site (${finalUrl.hostname})` };
    if (res.status === 404 || res.status === 410) return { url, status: "notfound", ms };
    if (res.status === 401 || res.status === 402 || res.status === 407) return { url, status: "login", ms };
    if (res.status === 429) return { url, status: "slowdown", ms };
    if (res.status === 403) return { url, status: "blocked", ms };
    if (res.status >= 500) return { url, status: "other", ms };
    if (ct.includes("application/pdf") || /\.pdf$/i.test(finalUrl.pathname)) {
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_PDF_BYTES) return { url, status: "unreadable", ms, error: `PDF larger than 20 MB (${Math.round(declared / 1024 / 1024)} MB)` };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_PDF_BYTES) return { url, status: "unreadable", ms, error: `PDF larger than 20 MB (${Math.round(bytes.byteLength / 1024 / 1024)} MB)` };
      return { url, status: "ok", pdfBase64: bytes.toString("base64"), ms };
    }
    if (ct && !/^(text\/|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml|json))/.test(ct.trim())) return { url, status: "binary", ms, contentType: ct.split(";")[0].trim() };
    const html = await res.text();
    return { url, status: "ok", html, ms, finalUrl: finalUrl.href };
  } catch (e) {
    return { url, status: /abort|timeout/i.test(String(e)) ? "timeout" : "other", ms: Date.now() - started };
  }
}

/**
 * Sitemap discovery (Daniel 2026-11-09): robots.txt is read for its Sitemap lines only — its
 * Disallow rules are never obeyed, that is the point of the local lane. Then /sitemap.xml and
 * /sitemap_index.xml. A sitemap index is followed into its child sitemaps (same site only).
 * Returns the page URLs found and a short summary for the log.
 */
async function discoverSitemaps(siteUrl, host) {
  const get = async (u) => {
    try {
      const res = await fetch(u, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const sameSite = (raw) => {
    try {
      const u = new URL(raw);
      return /^https?:$/.test(u.protocol) && siteOf(u) === host ? u : null;
    } catch {
      return null;
    }
  };
  const candidates = [];
  const robots = await get(new URL("/robots.txt", siteUrl));
  for (const line of (robots ?? "").split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m && sameSite(m[1])) candidates.push(m[1]);
  }
  candidates.push(new URL("/sitemap.xml", siteUrl).href, new URL("/sitemap_index.xml", siteUrl).href);
  const pages = [];
  const fetched = new Set();
  let files = 0;
  const read = async (u, depth) => {
    if (fetched.has(u) || fetched.size >= 60) return;
    fetched.add(u);
    const xml = await get(u);
    if (!xml) return;
    files++;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      if (depth >= 2) return;
      for (const l of locs) {
        if (!sameSite(l)) continue; // every child sitemap is read, image/video/news ones included: they list the pages that host the media (Daniel 2026-11-09)
        await read(l, depth + 1);
      }
      return;
    }
    for (const l of locs) {
      const pu = sameSite(l);
      if (pu && !/sitemap.*\.xml$/i.test(pu.pathname)) pages.push(pu);
    }
  };
  for (const c of candidates) await read(c, 0);
  return { pages, summary: `${files} sitemap file${files === 1 ? "" : "s"}, ${pages.length} URLs${robots ? ", robots.txt read for Sitemap lines only" : ""}` };
}

/** The fetch runner: this machine's own HTTP; robots.txt rules are not obeyed (a person's browser acting on a person's intent). */
async function runFetch(job, limits, post, saved) {
  const host = siteOf(new URL(job.siteUrl));
  const seen = new Set(saved?.seen ?? []);
  const queue = saved ? [...saved.queue] : [];
  const add = (u) => {
    if (!/^https?:$/.test(u.protocol) || siteOf(u) !== host || NON_PAGE.test(u.pathname)) return;
    if (/\/(wp-json|wp-admin|wp-content|feed|page\/\d+|cdn-cgi)\b/i.test(u.pathname)) return;
    const k = pageKey(u, job.siteUrl);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push(k);
  };
  let pendingLinked;
  if (saved) {
    // Continue where the scan stopped: the same queue, the page it was on first. Nothing is discovered again.
    pendingLinked = saved.pendingLinked ?? [];
    log(`  continuing where the scan stopped (${saved.stopped?.reason ?? "crash"}): ${saved.pagesRead ?? 0} pages already read, ${queue.length} left`);
  } else {
    for (const k of job.knownUrls ?? []) {
      try {
        add(new URL(k));
      } catch {
        // skip
      }
    }
    add(new URL(job.siteUrl));
    // Sitemaps are a hint for discovery, never a reason to skip a page.
    const sitemaps = await discoverSitemaps(job.siteUrl, host);
    for (const u of sitemaps.pages) add(u);
    log(`  sitemaps: ${sitemaps.summary} · ${queue.length} URLs to start with`);
    // The sitemap points at its pages: PM-OS must hear that, or a page only the sitemap lists ends "unlinked" (713 Flashpoint
    // pages on 2026-11-09). Handed in with the first page PM-OS accepts.
    pendingLinked = sitemaps.pages.map((u) => pageKey(u, job.siteUrl));
  }
  const t0 = Date.now();
  let n = 0;
  let renders = saved?.renders ?? 0;
  /** Pages read but lost on the way in: PM-OS refused the page AND the not-read note for it. Reported with done as not attempted. */
  let lost = saved?.lost ?? 0;
  /** The scan's place, with the page being read still first in the queue — a stop in the middle of a page reads it again. */
  const place = (current) => ({ scanId: job.scanId, competitor: job.competitorName, siteUrl: job.siteUrl, queue: current ? [current, ...queue] : queue, seen: [...seen], pendingLinked, renders, lost, pagesRead: job.pagesRead ?? 0 });
  while (queue.length) {
    if (Date.now() - t0 > limits.ms) break;
    const url = queue.shift();
    saveScanState(place(url));
    if (n > 0 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    n++;
    const started = Date.now();
    let body;
    /** Tries not counted against the page (offline, the Mac slept) — bounded so one odd page can never loop for ever. */
    let free = 0;
    // PRD: a page is pending until done — up to 3 attempts on a timeout or a server error.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const attemptStarted = Date.now();
      body = await readOnce(url, started, host);
      body.attempts = attempt;
      if (!(body.status === "timeout" || body.status === "other")) break;
      // A failed read is the site's fault only if this Mac is online. Offline (wifi dropped, the Mac just woke up): wait
      // for the network and read the same page again — the try is not counted and no page is marked "not read".
      if (!(await online())) {
        const since = Date.now();
        log(`  network lost at ${url} — waiting up to ${Math.round(OFFLINE_WAIT_MS / 60_000)} min`);
        status({ state: "offline", message: "Network lost — the scan waits" });
        let back = false;
        while (Date.now() - since < OFFLINE_WAIT_MS) {
          await sleep(OFFLINE_PROBE_EVERY_MS);
          if (await online()) {
            back = true;
            break;
          }
        }
        if (!back) {
          markStopped("network");
          log(`  network still down after ${Math.round((Date.now() - since) / 60_000)} min — scan parked, ${queue.length + 1} pages left; it continues from this page at the next check-in`);
          return { paused: "network", notAttempted: queue.length + 1 };
        }
        log(`  network back after ${Math.round((Date.now() - since) / 1000)} s — continuing`);
        status({ state: "scanning", message: `Scanning ${job.competitorName}` });
        if (free++ < 20) attempt--;
        continue;
      }
      // The Mac slept through this try (a 20 s read that took minutes): not the site's fault either.
      if (Date.now() - attemptStarted > 60_000 && free++ < 20) {
        log(`  the Mac slept during ${url} — reading it again`);
        attempt--;
        continue;
      }
      if (attempt < 3) {
        log(`  retry ${attempt} after ${body.status} ${url}`);
        await new Promise((r) => setTimeout(r, Math.max(PAUSE_MS, 500)));
      }
    }
    if (body.status === "binary") {
      // A download, not a page: skipped, counted for nothing (the same rule as the remote lane).
      log(`  not a web page (${body.contentType}) — skipped ${url}`);
      continue;
    }
    if (body.status === "slowdown") {
      // The site asked us to slow down: hand the signal in and stop this scan; the rest is "not attempted" and the next scan continues.
      if ((await post(body)) === null) return { notAttempted: queue.length, ended: true };
      log(`  slow down (429) ${url} — stopping this scan, ${queue.length} pages left for the next one`);
      return { notAttempted: queue.length };
    }
    if (body.status === "ok" && body.html) {
      // Headless Chrome for what plain HTTP cannot show: a page with no text, or a home/hub page whose menus are built by JavaScript.
      const u = new URL(url);
      const links = inSiteLinks(body.html, body.finalUrl || url, host);
      const empty = roughText(body.html).length < 200;
      if (renders < MAX_RENDERS && (empty || (isHub(u) && links < 8)) && (await chromeAvailable())) {
        renders++;
        const rendered = await renderWithChrome(url);
        if (rendered && (roughText(rendered).length > roughText(body.html).length || inSiteLinks(rendered, body.finalUrl || url, host) > links)) {
          body.html = rendered;
          body.rendered = true;
          log(`  rendered with Chrome ${url}`);
        } else {
          log(`  render attempt (no gain) ${url}`);
        }
      }
      for (const m of body.html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
        try {
          add(new URL(m[1].trim(), body.finalUrl || url));
        } catch {
          // skip
        }
      }
      delete body.finalUrl;
      delete body.rendered;
    }
    if (pendingLinked.length) body.linked = pendingLinked;
    const r = await post(body);
    if (r && !r.refused) pendingLinked = [];
    if (r && r.stop) {
      // PM-OS's store is full: this page and everything left are "not attempted"; the server says so in the scan.
      log(`  PM-OS stopped the scan (${r.stop}): ${r.error ?? ""} — ${queue.length + 1} pages left`);
      return { notAttempted: queue.length + 1 };
    }
    if (r === null) {
      // The scan ended on the server (cancelled, or already processed): nothing more to hand in.
      log(`  scan ended on the server — stopping, ${queue.length} pages left`);
      return { notAttempted: queue.length, ended: true };
    }
    if (r && r.refused) {
      // PM-OS would not take the page (too large, a bad post, three failed attempts): it is recorded as not read with the
      // reason instead of vanishing from the scan (Tomer's review 2026-11-10). A note PM-OS refuses too is counted in done.
      const note = body.status === "unreadable" ? r : await post({ url, status: "unreadable", error: `PM-OS refused the page: ${r.refused}`, ms: body.ms, attempts: body.attempts });
      if (note === null) {
        log(`  scan ended on the server — stopping, ${queue.length} pages left`);
        return { notAttempted: queue.length, ended: true };
      }
      if (!note || note.refused) lost++;
      log(`  refused by PM-OS (${r.refused}) — ${!note || note.refused ? "page lost, reported with done" : "recorded as not read"} ${url}`);
      continue;
    }
    log(`  ${body.status === "ok" ? r.outcome : body.status} ${url}`);
  }
  return { notAttempted: queue.length + lost };
}

/**
 * The Claude runner: Claude Code + Claude in Chrome read the site in the
 * PM's browser and hand each page in through a small script (the scan token
 * stays in the script, out of Claude's own commands). Claude is allowed the
 * browser tools, file writes under the scan's temp folder and that script —
 * nothing else.
 */
async function runClaude(job, limits, token) {
  const dir = join(tmpdir(), `pmos-local-scan-${job.scanId}`);
  mkdirSync(dir, { recursive: true });
  // The scan token and route live in the scan folder; handin.sh (what Claude is allowed to run) calls handin.mjs with them.
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });
  writeFileSync(join(dir, "api"), `${APP_URL}/api/competitors/local/scans/${job.scanId}/pages`, { mode: 0o600 });
  const handin = join(dir, "handin.sh");
  const handinJs = join(dirname(fileURLToPath(import.meta.url)), "handin.mjs");
  writeFileSync(handin, `#!/bin/sh
# handin.sh <url> <status> [file]
exec "${process.execPath}" "${handinJs}" "${dir}" "$@"
`, { mode: 0o700 });
  const known = (job.knownUrls ?? []).slice(0, 400).join("\n");
  const hostname = new URL(job.siteUrl).hostname;
  const site = siteOf(new URL(job.siteUrl));
  const prompt = `You are the PM-OS local scan station reading a competitor's public website in this Chrome, on behalf of the product manager who approved it. Read the site the way a person would and hand every page in.

Site: ${job.siteUrl}
Stay on this site only: ${site} (www.${site.replace(/:\d+$/, "")} is the same site). Any other subdomain (app., docs., support., …) and any other website is a separate source: do not open it, do not hand it in, do not count it. Never log in anywhere.
Read every page; stop after ${Math.round(limits.ms / 60000)} minutes.
Pages earlier scans know (read these first, then anything new you find in menus, footers, the sitemap and links):
${known || "(none yet)"}

For EVERY page you read:
1. Open it in Chrome.
2. Get the full HTML with the javascript tool (document.documentElement.outerHTML) and save it to a file under ${dir}/ (one file per page, e.g. ${dir}/page-1.html). If the tool truncates long output, take it in slices (outerHTML.slice(start, end)) and append them in order; the file must be the complete, unmodified HTML.
3. Hand it in: ${handin} "<url>" ok ${dir}/page-N.html
   A PDF linked from a page: ${handin} "<pdf url>" pdf   (the station downloads it itself — do not try to download or open it)
   A "not found" page (the site says the page does not exist): ${handin} "<url>" notfound
   A login or paywall: ${handin} "<url>" login
   The site refuses you (blocked, a captcha you cannot pass): ${handin} "<url>" blocked
   Never loads: ${handin} "<url>" timeout
Hand each page in exactly once, as you go, not at the end. Do not summarize or interpret the pages; PM-OS does that.
When you are done, or the limits are reached, print exactly one final line: DONE <number of pages of this site you discovered but did not read>`;
  // File rules are matched as Edit(path) (Claude Code's permission syntax); the browser tools and the hand-in script are the only other tools.
  const allowed = ["mcp__claude-in-chrome__*", `Edit(${dir})`, `Edit(${dir}/*)`, `Edit(${dir}/**)`, `Bash(${handin}:*)`];
  const out = await new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--chrome", "--allowedTools", ...allowed, "--output-format", "text", prompt], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), limits.ms + 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  // Keep Claude's own account of the run in the station log (its final lines), whatever the exit code.
  const tail = out.stdout.trim().split("\n").slice(-6).join(" | ").slice(0, 1200);
  log(`claude exited ${out.code}${out.stderr.trim() ? ` (stderr: ${out.stderr.trim().slice(0, 300)})` : ""} — ${tail || "(no output)"}`);
  const m = out.stdout.match(/DONE\s+(\d+)/);
  return { notAttempted: m ? Number(m[1]) : 0 };
}

// ————— One scan —————

async function runJob(job, runner, key) {
  // No page limit (Daniel 2026-11-09): time is the station's only stop; the PM-OS store limit is the server's (it answers stop: "storage").
  const limits = { ms: MAX_MINUTES_FLAG ? MAX_MINUTES_FLAG * 60_000 : job.ceiling?.ms || 8 * 3600_000 };
  const auth = { authorization: `Bearer ${job.token}` };
  log(`scan ${job.scanId} — ${job.competitorName} (${job.siteUrl}) via ${runner}, up to ${Math.round(limits.ms / 60000)} minutes`);
  // The machine key names the station that took the scan (Administration); the scan token does the work.
  await api(`/api/competitors/local/scans/${job.scanId}/start`, { method: "POST", headers: { ...auth, "x-pmos-station": `Bearer ${key}` } });
  /**
   * One page in. null = the scan is over on the server (409 ended, 410 cancelled): stop reading. A page PM-OS refuses
   * (400/413/422: a bad URL, a body too large) is skipped and the scan goes on — one odd page must never cost the
   * site (Tomer's review). Anything else (network, 5xx) is retried a few times, then skipped too.
   */
  // The place saved by a scan that did not finish on this station (same scan only; the fetch runner only).
  const state = loadScanState();
  const saved = runner === "fetch" && state?.scanId === job.scanId ? state : null;
  if (!saved) clearScanState();
  let pagesRead = saved?.pagesRead ?? 0;
  job.pagesRead = pagesRead;
  if (saved) status({ pagesRead });
  const post = async (body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await api(`/api/competitors/local/scans/${job.scanId}/pages`, { method: "POST", headers: auth, body: JSON.stringify(body) });
        if (body.status === "ok") {
          job.pagesRead = ++pagesRead;
          status({ pagesRead });
        }
        return answer;
      } catch (e) {
        const m = /→ (\d{3}) (.*)$/.exec(e instanceof Error ? e.message : String(e));
        const status = m ? Number(m[1]) : 0;
        if (status === 409 || status === 410) return null;
        if (status >= 400 && status < 500) return { refused: `${status} ${m[2].slice(0, 100)}` };
        if (attempt >= 3) return { refused: `${status || "network"} after ${attempt} attempts` };
        await sleep(5_000 * attempt);
      }
    }
  };
  // A scan that stopped after its last page (only the hand-in call was missing) goes straight to the hand-in.
  const result = saved?.finished ? saved.finished : runner === "claude" ? await runClaude(job, limits, job.token) : await runFetch(job, limits, post, saved);
  job.pagesRead = pagesRead;
  if (result.paused) {
    // Parked with its place saved: PM-OS puts the scan back to waiting and the next check-in continues it.
    job.paused = result.paused;
    return;
  }
  if (result.ended) {
    clearScanState();
    return;
  }
  if (runner === "fetch") saveScanState({ scanId: job.scanId, competitor: job.competitorName, siteUrl: job.siteUrl, queue: [], seen: [], pagesRead, finished: { notAttempted: result.notAttempted } });
  // PM-OS answers "received" at once, in every environment, and processes the pages (hash compare, page states, badge) in its
  // own runner — a Cloud Run job in production, a background task in local dev. A network blip or a 5xx is retried three
  // times (the pages are in; only this call is missing); no answer within 5 minutes each time is a real failure.
  let done;
  for (let attempt = 1; ; attempt++) {
    try {
      done = await api(`/api/competitors/local/scans/${job.scanId}/done`, { method: "POST", headers: auth, body: JSON.stringify({ notAttempted: result.notAttempted }) }, 5 * 60_000);
      break;
    } catch (e) {
      const m = /→ (\d{3}) /.exec(e instanceof Error ? e.message : String(e));
      const status = m ? Number(m[1]) : 0;
      if (status === 409 || status === 410) {
        log(`scan ${job.scanId} ended on the server before the hand-in call (${status})`);
        clearScanState();
        return;
      }
      if ((status >= 400 && status < 500) || attempt >= 3) throw e;
      log(`  done call failed (${status || "network"}) — retry ${attempt} in ${5 * 2 ** (attempt - 1)} s`);
      await sleep(5_000 * 2 ** (attempt - 1));
    }
  }
  clearScanState();
  if (done.processing) log(`scan ${job.scanId} handed in · ${result.notAttempted} not attempted · PM-OS is processing the pages`);
  else log(`scan ${job.scanId} ${done.scan?.status} (${done.scan?.badge}) · ${done.scan?.pagesFetched} pages, ${done.scan?.pagesChanged} changed, ${done.scan?.pagesNotAttempted ?? 0} not attempted`);
}

async function once() {
  const key = readKey();
  const runner = await whichRunner();
  const saved = loadScanState();
  const data = await checkIn(key, saved);
  // The saved scan first; a saved place PM-OS no longer wants (cancelled, finished, deleted) is dropped.
  const waiting = [...(data.waiting ?? [])].sort((a, b) => Number(b.scanId === saved?.scanId) - Number(a.scanId === saved?.scanId));
  if (saved && !waiting.some((w) => w.scanId === saved.scanId)) {
    log(`the saved place of scan ${saved.scanId} (${saved.competitor ?? "?"}) is no longer wanted by PM-OS — dropped`);
    clearScanState();
  }
  status({ state: "idle", station: data.station, lastCheckIn: new Date().toISOString(), message: waiting.length ? `${waiting.length} waiting` : "Nothing waiting", competitor: null, site: null, pagesRead: null, scanStartedAt: null, waiting: 0 });
  if (!waiting.length) {
    log(`check-in as ${data.station}: nothing waiting`);
    return;
  }
  // No dialog, no snooze (Daniel 2026-11-12): the scan runs in the background, so the station starts it at once.
  log(`check-in as ${data.station}: ${waiting.length} waiting (${waiting.map((w) => w.competitorName).join(", ")})`);
  for (const [i, job] of waiting.entries()) {
    status({ state: "scanning", competitor: job.competitorName, site: job.siteUrl, pagesRead: 0, scanStartedAt: new Date().toISOString(), waiting: waiting.length - i - 1, message: `Scanning ${job.competitorName}` });
    let result = "handed in";
    try {
      await runJob(job, runner, key);
      if (job.paused) result = `paused: ${job.paused} lost — continues at the next check-in`;
    } catch (e) {
      result = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      log(`scan ${job.scanId} failed on the station: ${e instanceof Error ? e.message : String(e)}`);
    }
    status({ lastScan: { competitor: job.competitorName, pagesRead: job.pagesRead ?? station.pagesRead ?? 0, finishedAt: new Date().toISOString(), result } });
    // Offline: the other waiting scans would only fail the same way.
    if (job.paused) {
      status({ state: "idle", message: `${job.competitorName}: paused, ${job.paused} lost — continues at the next check-in`, competitor: null, site: null, pagesRead: null, scanStartedAt: null, waiting: 0 });
      return;
    }
  }
  status({ state: "idle", message: "Nothing waiting", competitor: null, site: null, pagesRead: null, scanStartedAt: null, waiting: 0 });
}

async function main() {
  if (!has("loop")) {
    await once();
    return;
  }
  for (;;) {
    try {
      await once();
    } catch (e) {
      status({ state: "unreachable", message: `Check-in failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
      log(`check-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  status({ state: "unreachable", message: `Check-in failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
