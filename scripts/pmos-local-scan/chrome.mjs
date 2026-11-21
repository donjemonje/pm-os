/**
 * PM-OS local scan station — reading a page with the Mac's Chrome when the site refuses the plain request (Daniel 2026-11-21).
 *
 * PRD: "When a site blocks PM-OS or needs a real browser, the scan runs in a PM's own Chrome." The fetch runner asks
 * with plain HTTP and a browser's identity; some sites answer 403 to that whatever the identity says (Bitsight's site
 * and help center, ZeroFox's help center on 2026-11-21: 0 pages). Such a page is asked once more with the installed
 * Chrome, headless, through its DevTools connection — not with --dump-dom, which prints the page but not what the
 * site answered: without the HTTP status a "page not found" or a bot wall would be stored as the page's text.
 *
 * The rules, with no I/O so they can be tested (tests/unit/competitors-station-chrome.test.ts):
 *   - judgeChromeRead: what a Chrome read counts as — a page, not found, login, slow down, or still refused;
 *   - refusedStop: a scan ends when REFUSED_IN_A_ROW pages in a row were refused on the plain request and (when Chrome
 *     can be used) in Chrome too. The rest is "not attempted"; the next scan continues from them. A site that refuses
 *     everything is not asked for every one of its pages.
 *
 * readWithChrome does the reading. One Chrome at a time (the caller queues): every read uses the station's own profile
 * folder, never the PM's. The profile keeps the site's cookies between reads, as a person's browser does.
 * No dependencies: Node's built-in WebSocket (Node 22+). Without it the station cannot use Chrome this way and says so.
 */
import { spawn } from "node:child_process";

/** A scan ends after this many pages in a row that the site refused. */
export const REFUSED_IN_A_ROW = 5;

/** True when this Node can talk to Chrome's DevTools (a built-in WebSocket). */
export const chromeReaderSupported = () => typeof globalThis.WebSocket === "function";

/** The pages bot protection shows instead of the site (the same signs as the server's looksLikeBotWall, html.ts). */
export function looksLikeBotWallPage(html) {
  const head = String(html ?? "").slice(0, 6000);
  return /just a moment|verify you are human|checking your browser|cf-chl|cf_chl|attention required|access denied|request unsuccessful\. incapsula|_incapsula_|akamai.*bot|px-captcha|captcha-delivery|hcaptcha|recaptcha\/api\.js/i.test(head);
}

/**
 * What a read with Chrome counts as.
 *   status   the HTTP status of the page's last document answer, or null when Chrome got none
 *   html     the page's DOM after it ran
 * Returns the station's page status: "ok" | "notfound" | "login" | "slowdown" | "blocked" | "other".
 * A 2xx/3xx answer is the page — the status is what the site said, so a real page that merely carries a captcha
 * script is not taken for a wall; only a 200 that is still the "Just a moment…" check is.
 * @param {{ status: number | null, html?: string | null }} read
 */
export function judgeChromeRead({ status, html }) {
  if (status === null || status === undefined) return "blocked";
  if (status === 404 || status === 410) return "notfound";
  if (status === 401 || status === 402 || status === 407) return "login";
  if (status === 429) return "slowdown";
  if (status === 403) return "blocked";
  if (status >= 500) return looksLikeBotWallPage(html) ? "blocked" : "other";
  if (status >= 400) return "blocked";
  if (!html || html.length <= 100) return "other";
  if (/<title>\s*just a moment/i.test(String(html).slice(0, 6000))) return "blocked";
  return "ok";
}

/**
 * After a page the site refused: does the scan go on?
 *   inARow   refused pages in a row, this one included
 * @returns {{ stop: boolean }}
 */
export function refusedStop(inARow, limit = REFUSED_IN_A_ROW) {
  return { stop: inARow >= limit };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read one page with Chrome. Returns { status, html, finalUrl } — status null when the page gave no document answer —
 * or { error } when Chrome could not be used (not started, no DevTools address, the page never loaded).
 *   chrome        the Chrome binary
 *   profile       the station's own profile folder
 *   userAgent     the browser identity the station uses everywhere
 *   timeoutMs     the whole read, Chrome's start included
 *   settleMs      after the page's load event, the time its scripts get
 *   challengeMs   when the first answer is a bot check, how long Chrome may take to pass it
 */
export async function readWithChrome({ chrome, profile, userAgent, url, timeoutMs = 60_000, settleMs = 2_500, challengeMs = 20_000 }) {
  if (!chromeReaderSupported()) return { error: "this Node has no built-in WebSocket (Node 22 or newer is needed)" };
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${profile}`, `--user-agent=${userAgent}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const deadline = Date.now() + timeoutMs;
  let ws = null;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let err = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not open its DevTools address")), 15_000);
      child.stderr.on("data", (d) => {
        err += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome ended at once (code ${code}) — is another Chrome using the station's profile folder?`));
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(undefined), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect to Chrome's DevTools address")), { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? "DevTools error"));
        else resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of listeners) l(msg);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
    const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
    const mainFrame = frameTree.frame.id;
    /** The page's document answers, in order: a bot check that passes shows as 403 and then 200. */
    const answers = [];
    let loaded = 0;
    listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Network.responseReceived" && msg.params.type === "Document" && msg.params.frameId === mainFrame) answers.push({ status: msg.params.response.status, url: msg.params.response.url });
      if (msg.method === "Page.loadEventFired") loaded++;
    });
    const nav = await send("Page.navigate", { url }, sessionId);
    if (nav.errorText && !answers.length) return { error: `Chrome could not open the page (${nav.errorText})` };
    while (!loaded && Date.now() < deadline) await sleep(200);
    if (!loaded && !answers.length) return { error: "the page did not load in Chrome in time" };
    await sleep(settleMs);
    const dom = async () => (await send("Runtime.evaluate", { expression: "document.documentElement ? document.documentElement.outerHTML : ''", returnByValue: true }, sessionId)).result?.value ?? "";
    let html = await dom();
    // A bot check that Chrome can pass reloads the page by itself: give it its time, then read again.
    const refusedNow = () => judgeChromeRead({ status: answers.at(-1)?.status ?? null, html }) === "blocked";
    const waitUntil = Math.min(deadline, Date.now() + challengeMs);
    if (refusedNow() && looksLikeBotWallPage(html)) {
      const seen = answers.length;
      while (Date.now() < waitUntil && answers.length === seen) await sleep(500);
      if (answers.length > seen) {
        await sleep(settleMs);
        html = await dom();
      }
    }
    const finalUrl = (await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId)).result?.value ?? url;
    return { status: answers.at(-1)?.status ?? null, html, finalUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      ws?.close();
    } catch {
      // already closed
    }
    child.kill("SIGTERM");
    // The profile folder is free again only when Chrome is gone: the next read waits for that.
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
      const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(hard);
        resolve(undefined);
      });
    });
  }
}
