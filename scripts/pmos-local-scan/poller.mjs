#!/usr/bin/env node
/**
 * PM-OS local scan station — the poller (Website Scanning PRD 2026-11-04).
 *
 * Runs on a PM's Mac (for now Daniel's, as PM-OS operator for every
 * customer). Every 15 minutes it asks PM-OS which competitor scans are
 * waiting for a station; when the screen is locked it runs them without
 * asking, when the PM is working it shows ONE dialog listing every waiting
 * site (Approve runs them all, Later snoozes two hours — a locked screen
 * overrides the snooze). Scans run one at a time. The station is a server:
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
 *   --mac-state auto|active|locked   (default auto — reads the real lock state)
 *   --answer ask|approve|later       (default ask — the real dialog)
 *   --pause-ms N         pause between pages in the fetch runner (default 2000)
 *   --max-pages N        read at most N pages per scan (default: the server's ceiling)
 *   --max-minutes N      stop a scan after N minutes (default: the server's ceiling)
 *   --state-dir PATH     where the snooze file and the log live (default ~/.pmos)
 *   --done-delay-ms N    TEST KNOB (e2e WS-35, server honours it only with COMPETITORS_TEST_KNOBS=on): ask PM-OS to hold the done answer N ms
 */
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const SNOOZE_FILE = join(STATE_DIR, "snooze-until");
const LOG_FILE = join(STATE_DIR, "local-scan.log");
const POLL_MS = 15 * 60_000;
const SNOOZE_MS = 2 * 3600_000;
const PAUSE_MS = Number(flag("pause-ms", "2000"));
const RENDER = flag("render", "auto");
const CHROME = flag("chrome", process.env.PMOS_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
/** Headless renders per scan are bounded: home, hubs and empty pages only. */
const MAX_RENDERS = 40;
/** The render's own Chrome profile (never the PM's). */
const CHROME_PROFILE = join(STATE_DIR, "chrome-profile");
const MAC_STATE = flag("mac-state", "auto");
const ANSWER = flag("answer", "ask");
const MAX_PAGES_FLAG = Number(flag("max-pages", "0")) || 0;
const MAX_MINUTES_FLAG = Number(flag("max-minutes", "0")) || 0;
/** TEST KNOB (WS-35): passed through to the done route as testDelayMs; 0 = absent. Never set by the LaunchAgent. */
const DONE_DELAY_MS = Number(flag("done-delay-ms", "0")) || 0;
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

// ————— Mac state —————

async function screenLocked() {
  if (MAC_STATE === "locked") return true;
  if (MAC_STATE === "active") return false;
  try {
    const { stdout } = await run("ioreg", ["-n", "Root", "-d1", "-a"]);
    return /CGSSessionScreenIsLocked/.test(stdout);
  } catch {
    return false;
  }
}

function snoozed() {
  try {
    const until = Number(readFileSync(SNOOZE_FILE, "utf8").trim());
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/** One dialog for every waiting site. Approve runs them all; Later snoozes two hours; no answer = Later. */
async function askUser(sites) {
  if (ANSWER === "approve") return true;
  if (ANSWER === "later") return false;
  const list = sites.map((s) => `• ${s}`).join("\n");
  const script = `display dialog "PM-OS wants to scan ${sites.length === 1 ? "this site" : `${sites.length} sites`} from your browser:\n\n${list.replace(/"/g, '\\"')}" with title "PM-OS competitor scan" buttons {"Later", "Approve"} default button "Approve" giving up after 120`;
  try {
    const { stdout } = await run("osascript", ["-e", script]);
    return /button returned:Approve/.test(stdout) && !/gave up:true/.test(stdout);
  } catch {
    return false; // Cancel / Esc = Later
  }
}

// ————— PM-OS API —————

/**
 * A call whose answer can take many minutes (in local dev the server processes the whole scan inside the done call:
 * 27 minutes for SpyCloud's 977 pages on 2026-11-09). Plain node:http(s): fetch gives up on a response whose headers
 * take more than 5 minutes, whatever its signal says. `timeoutMs` is an idle limit — no byte from the server for that long.
 */
function apiLong(path, init = {}, timeoutMs = 20 * 60_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${APP_URL}${path}`);
    const mod = u.protocol === "https:" ? https : http;
    const body = init.body ?? null;
    const headers = { "content-type": "application/json", ...(init.headers ?? {}), ...(body ? { "content-length": Buffer.byteLength(body) } : {}) };
    const req = mod.request(u, { method: init.method ?? "POST", headers, timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { raw: text };
        }
        if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error(`${path} → ${res.statusCode} ${json?.error ?? text.slice(0, 200)}`));
        else resolve(json);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${path} → no answer for ${Math.round(timeoutMs / 60_000)} minutes`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

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

async function checkIn(key) {
  const json = await api("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${key}` } });
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

const NON_PAGE = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|eot|txt|csv)$/i;

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

/** One attempt to read a page with this machine's own HTTP. */
async function readOnce(url, started) {
  try {
    const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const ms = Date.now() - started;
    if (res.status === 404 || res.status === 410) return { url, status: "notfound", ms };
    if (res.status === 401 || res.status === 402 || res.status === 407) return { url, status: "login", ms };
    if (res.status === 429) return { url, status: "slowdown", ms };
    if (res.status === 403) return { url, status: "blocked", ms };
    if (res.status >= 500) return { url, status: "other", ms };
    if (ct.includes("application/pdf") || /\.pdf$/i.test(new URL(res.url || url).pathname)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { url, status: "ok", pdfBase64: bytes.toString("base64"), ms };
    }
    const html = await res.text();
    return { url, status: "ok", html, ms, finalUrl: res.url || url };
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
async function runFetch(job, limits, post) {
  const host = siteOf(new URL(job.siteUrl));
  const seen = new Set();
  const queue = [];
  const add = (u) => {
    if (!/^https?:$/.test(u.protocol) || siteOf(u) !== host || NON_PAGE.test(u.pathname)) return;
    if (/\/(wp-json|wp-admin|wp-content|feed|page\/\d+|cdn-cgi)\b/i.test(u.pathname)) return;
    const k = pageKey(u, job.siteUrl);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push(k);
  };
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
  let pendingLinked = sitemaps.pages.map((u) => pageKey(u, job.siteUrl));
  const t0 = Date.now();
  let n = 0;
  let renders = 0;
  while (queue.length) {
    if (n >= limits.pages || Date.now() - t0 > limits.ms) break;
    const url = queue.shift();
    if (n > 0 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    n++;
    const started = Date.now();
    let body;
    // PRD: a page is pending until done — up to 3 attempts on a timeout or a server error.
    for (let attempt = 1; attempt <= 3; attempt++) {
      body = await readOnce(url, started);
      body.attempts = attempt;
      if (!(body.status === "timeout" || body.status === "other")) break;
      if (attempt < 3) {
        log(`  retry ${attempt} after ${body.status} ${url}`);
        await new Promise((r) => setTimeout(r, Math.max(PAUSE_MS, 500)));
      }
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
    if (r === null) {
      // The scan ended on the server (cancelled, or already processed): nothing more to hand in.
      log(`  scan ended on the server — stopping, ${queue.length} pages left`);
      return { notAttempted: queue.length, ended: true };
    }
    log(`  ${r.refused ? `refused by PM-OS (${r.refused}) — page skipped` : body.status === "ok" ? r.outcome : body.status} ${url}`);
  }
  return { notAttempted: queue.length };
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
Read at most ${limits.pages} pages and stop after ${Math.round(limits.ms / 60000)} minutes.
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
  const limits = {
    pages: MAX_PAGES_FLAG || job.ceiling?.pages || 2000,
    ms: MAX_MINUTES_FLAG ? MAX_MINUTES_FLAG * 60_000 : job.ceiling?.ms || 3 * 3600_000,
  };
  const auth = { authorization: `Bearer ${job.token}` };
  log(`scan ${job.scanId} — ${job.competitorName} (${job.siteUrl}) via ${runner}, up to ${limits.pages} pages`);
  // The machine key names the station that took the scan (Administration); the scan token does the work.
  await api(`/api/competitors/local/scans/${job.scanId}/start`, { method: "POST", headers: { ...auth, "x-pmos-station": `Bearer ${key}` } });
  /**
   * One page in. null = the scan is over on the server (409 ended, 410 cancelled): stop reading. A page PM-OS refuses
   * (400/413/422: a bad URL, a body too large) is skipped and the scan goes on — one odd page must never cost the
   * site (Tomer's review). Anything else (network, 5xx) is retried a few times, then skipped too.
   */
  const post = async (body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await api(`/api/competitors/local/scans/${job.scanId}/pages`, { method: "POST", headers: auth, body: JSON.stringify(body) });
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
  const result = runner === "claude" ? await runClaude(job, limits, job.token) : await runFetch(job, limits, post);
  if (result.ended) return;
  // PM-OS processes the pages inside this call in local dev (page states, PMOS AI); in production it hands them to its own job.
  const done = await apiLong(`/api/competitors/local/scans/${job.scanId}/done`, { method: "POST", headers: auth, body: JSON.stringify({ notAttempted: result.notAttempted, ...(DONE_DELAY_MS ? { testDelayMs: DONE_DELAY_MS } : {}) }) }, 20 * 60_000);
  if (done.processing) log(`scan ${job.scanId} handed in · ${result.notAttempted} not attempted · PM-OS is processing the pages`);
  else log(`scan ${job.scanId} ${done.scan?.status} (${done.scan?.badge}) · ${done.scan?.pagesFetched} pages, ${done.scan?.pagesChanged} changed, ${done.scan?.pagesNotAttempted ?? 0} not attempted`);
}

async function once() {
  const key = readKey();
  const runner = await whichRunner();
  const data = await checkIn(key);
  const waiting = data.waiting ?? [];
  if (!waiting.length) {
    log(`check-in as ${data.station}: nothing waiting`);
    return;
  }
  const locked = await screenLocked();
  log(`check-in as ${data.station}: ${waiting.length} waiting (${waiting.map((w) => w.competitorName).join(", ")}) — screen ${locked ? "locked" : "active"}`);
  if (!locked) {
    if (snoozed()) {
      log("snoozed (Later) — skipping this check-in");
      return;
    }
    const approved = await askUser(waiting.map((w) => w.competitorName));
    if (!approved) {
      writeFileSync(SNOOZE_FILE, String(Date.now() + SNOOZE_MS));
      log("Later — snoozed for 2 hours (a locked screen runs anyway)");
      return;
    }
  }
  for (const job of waiting) {
    try {
      await runJob(job, runner, key);
    } catch (e) {
      log(`scan ${job.scanId} failed on the station: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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
      log(`check-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
