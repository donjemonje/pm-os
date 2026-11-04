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
 *   claude  Claude Code with Claude in Chrome on this Mac — the PM's own
 *           browser, a person reading a public site with AI doing the reading.
 *           Claude gets only the browser tools and the hand-in script.
 *   fetch   plain HTTP from this machine (tests, and a fallback when Claude is
 *           not installed). Same hand-in route either way; the server extracts,
 *           normalizes and hashes.
 *
 * No dependencies. Node 20+.
 *
 *   node poller.mjs                          one check-in (the LaunchAgent runs it every 15 min)
 *   node poller.mjs --loop                   keep running, check in every 15 min
 *   --app-url URL        PM-OS origin (default: PMOS_APP_URL or https://app.pm-os.io)
 *   --key-file PATH      machine key file (default: ~/.pmos/station-key)
 *   --runner claude|fetch (default: claude when `claude` is on PATH, else fetch)
 *   --mac-state auto|active|locked   (default auto — reads the real lock state)
 *   --answer ask|approve|later       (default ask — the real dialog)
 *   --pause-ms N         pause between pages in the fetch runner (default 1000)
 *   --max-pages N        read at most N pages per scan (default: the server's ceiling)
 *   --max-minutes N      stop a scan after N minutes (default: the server's ceiling)
 *   --state-dir PATH     where the snooze file and the log live (default ~/.pmos)
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
const PAUSE_MS = Number(flag("pause-ms", "1000"));
const MAC_STATE = flag("mac-state", "auto");
const ANSWER = flag("answer", "ask");
const MAX_PAGES_FLAG = Number(flag("max-pages", "0")) || 0;
const MAX_MINUTES_FLAG = Number(flag("max-minutes", "0")) || 0;
/** A browser's own identity — this is a person's machine, not the PM-OS crawler. */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

mkdirSync(STATE_DIR, { recursive: true });

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
  if (want === "fetch" || want === "claude") return want;
  try {
    await run("which", ["claude"]);
    return "claude";
  } catch {
    return "fetch";
  }
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

async function api(path, init = {}) {
  const res = await fetch(`${APP_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(120_000) });
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

/** The same "site" rule as the server: registrable host plus a non-default port. */
function siteOf(u) {
  return `${registrable(u.hostname)}${u.port ? `:${u.port}` : ""}`;
}

function pageKey(u) {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

const NON_PAGE = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|eot|txt|csv)$/i;

/** The fetch runner: this machine's own HTTP, no robots.txt (a person's browser acting on a person's intent). */
async function runFetch(job, limits, post) {
  const host = siteOf(new URL(job.siteUrl));
  const seen = new Set();
  const queue = [];
  const add = (u) => {
    if (!/^https?:$/.test(u.protocol) || siteOf(u) !== host || NON_PAGE.test(u.pathname)) return;
    if (/\/(wp-json|wp-admin|wp-content|feed|page\/\d+|cdn-cgi)\b/i.test(u.pathname)) return;
    const k = pageKey(u);
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
  // The sitemap is a hint for discovery, never a reason to skip a page.
  try {
    const sm = await fetch(new URL("/sitemap.xml", job.siteUrl), { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
    if (sm.ok) {
      for (const m of (await sm.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        try {
          const u = new URL(m[1]);
          if (!/sitemap/i.test(u.pathname)) add(u);
        } catch {
          // skip
        }
      }
    }
  } catch {
    // no sitemap
  }
  const t0 = Date.now();
  let n = 0;
  while (queue.length) {
    if (n >= limits.pages || Date.now() - t0 > limits.ms) break;
    const url = queue.shift();
    if (n > 0 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    n++;
    const started = Date.now();
    let body;
    try {
      const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const ms = Date.now() - started;
      if (res.status === 404 || res.status === 410) body = { url, status: "notfound", ms };
      else if (res.status === 401 || res.status === 402 || res.status === 407) body = { url, status: "login", ms };
      else if (res.status === 403 || res.status === 429) body = { url, status: "blocked", ms };
      else if (res.status >= 500) body = { url, status: "other", ms };
      else if (ct.includes("application/pdf") || /\.pdf$/i.test(new URL(res.url || url).pathname)) {
        const bytes = Buffer.from(await res.arrayBuffer());
        body = { url, status: "ok", pdfBase64: bytes.toString("base64"), ms };
      } else {
        const html = await res.text();
        body = { url, status: "ok", html, ms };
        for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
          try {
            add(new URL(m[1].trim(), res.url || url));
          } catch {
            // skip
          }
        }
      }
    } catch (e) {
      body = { url, status: /abort|timeout/i.test(String(e)) ? "timeout" : "other", ms: Date.now() - started };
    }
    const r = await post(body);
    log(`  ${body.status === "ok" ? r.outcome : body.status} ${url}`);
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
  const handin = join(dir, "handin.sh");
  writeFileSync(
    handin,
    `#!/bin/sh
# handin.sh <url> <status> [file-with-html]
URL="$1"; STATUS="$2"; FILE="$3"
API="${APP_URL}/api/competitors/local/scans/${job.scanId}/pages"
if [ -n "$FILE" ] && [ -f "$FILE" ]; then
  node -e 'const fs=require("fs");const [u,s,f]=process.argv.slice(1);const html=fs.readFileSync(f,"utf8");process.stdout.write(JSON.stringify({url:u,status:s,html}))' "$URL" "$STATUS" "$FILE" > "$FILE.json"
  curl -sS -X POST "$API" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @"$FILE.json"
else
  curl -sS -X POST "$API" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d "{\\"url\\":\\"$URL\\",\\"status\\":\\"$STATUS\\"}"
fi
echo
`,
    { mode: 0o700 },
  );
  const known = (job.knownUrls ?? []).slice(0, 400).join("\n");
  const hostname = new URL(job.siteUrl).hostname;
  const prompt = `You are the PM-OS local scan station reading a competitor's public website in this Chrome, on behalf of the product manager who approved it. Read the site the way a person would and hand every page in.

Site: ${job.siteUrl}
Read at most ${limits.pages} pages and stop after ${Math.round(limits.ms / 60000)} minutes.
Pages earlier scans know (read these first, then anything new you find in menus, footers, the sitemap and links):
${known || "(none yet)"}

For EVERY page you read:
1. Open it in Chrome. Same site only: never leave ${hostname} or its subdomains, never follow links to other sites, never log in anywhere.
2. Get the full HTML with the javascript tool (document.documentElement.outerHTML) and save it to a file under ${dir}/ (one file per page, e.g. ${dir}/page-1.html).
3. Hand it in: ${handin} "<url>" ok ${dir}/page-N.html
   If the page says it does not exist (a "not found" page): ${handin} "<url>" notfound
   If it demands a login or a paywall: ${handin} "<url>" login
   If the site refuses you (blocked, a captcha you cannot pass): ${handin} "<url>" blocked
   If it never loads: ${handin} "<url>" timeout
Hand pages in as you go, not at the end. PDFs linked from product pages count as pages: save the file and hand it in with status ok.
Do not summarize or interpret the pages; PM-OS does that. When you are done, or the limits are reached, print exactly one final line: DONE <number of discovered pages you did not read>`;
  const allowed = ["mcp__claude-in-chrome__*", `Write(${dir}/*)`, `Bash(${handin}:*)`];
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
  if (out.code !== 0) log(`claude exited ${out.code}: ${out.stderr.slice(0, 400)}`);
  const m = out.stdout.match(/DONE\s+(\d+)/);
  return { notAttempted: m ? Number(m[1]) : 0 };
}

// ————— One scan —————

async function runJob(job, runner) {
  const limits = {
    pages: MAX_PAGES_FLAG || job.ceiling?.pages || 2000,
    ms: MAX_MINUTES_FLAG ? MAX_MINUTES_FLAG * 60_000 : job.ceiling?.ms || 3 * 3600_000,
  };
  const auth = { authorization: `Bearer ${job.token}` };
  log(`scan ${job.scanId} — ${job.competitorName} (${job.siteUrl}) via ${runner}, up to ${limits.pages} pages`);
  await api(`/api/competitors/local/scans/${job.scanId}/start`, { method: "POST", headers: auth });
  const post = (body) => api(`/api/competitors/local/scans/${job.scanId}/pages`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const result = runner === "claude" ? await runClaude(job, limits, job.token) : await runFetch(job, limits, post);
  const done = await api(`/api/competitors/local/scans/${job.scanId}/done`, { method: "POST", headers: auth, body: JSON.stringify({ notAttempted: result.notAttempted }) });
  log(`scan ${job.scanId} ${done.scan?.status} (${done.scan?.badge}) · ${done.scan?.pagesFetched} pages, ${done.scan?.pagesChanged} changed, ${done.scan?.pagesNotAttempted ?? 0} not attempted`);
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
      await runJob(job, runner);
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
