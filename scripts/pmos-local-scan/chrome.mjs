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

/** Every Chrome this process started and has not closed: killed when the station stops (killAllChrome). */
const live = new Set();
export function killAllChrome() {
  for (const child of live) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  live.clear();
}

/**
 * Start Chrome on a profile folder and keep it open: one browser for the many pages of one site (a fresh Chrome per
 * page, ten sites side by side, brought the Mac to a crawl on 2026-11-22). Returns { read(url), close(), alive() } or
 * { error } when Chrome could not be started.
 *   chrome        the Chrome binary
 *   profile       the profile folder (one per site; never the PM's)
 *   userAgent     the browser identity the station uses everywhere
 */
export async function openChrome({ chrome, profile, userAgent }) {
  if (!chromeReaderSupported()) return { error: "this Node has no built-in WebSocket (Node 22 or newer is needed)" };
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--mute-audio", `--user-data-dir=${profile}`, `--user-agent=${userAgent}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  live.add(child);
  // Two different things: the PROCESS is gone (the profile folder is free), or only its DevTools connection closed
  // (a page crashed it) — then the process is still there and holds the folder until it is ended.
  let exited = false;
  let gone = false;
  child.once("exit", () => {
    exited = true;
    gone = true;
    live.delete(child);
  });
  const shut = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    // The profile folder is free again only when Chrome is gone: whoever opens it next waits for that.
    await new Promise((resolve) => {
      if (exited) return resolve(undefined);
      const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(hard);
        resolve(undefined);
      });
    });
  };
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
        if (err.length > 20_000) err = err.slice(-2_000);
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome ended at once (code ${code}) — is another Chrome using the profile folder?`));
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(undefined), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect to Chrome's DevTools address")), { once: true });
    });
  } catch (e) {
    await shut();
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
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
  ws.addEventListener("close", () => {
    gone = true;
    for (const { reject } of pending.values()) reject(new Error("Chrome closed its DevTools connection"));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error("Chrome is not running"));
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      // A command Chrome never answers must not hold a scan for ever.
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Chrome did not answer ${method} in time`));
      }, 60_000);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  /** One page, in its own tab, closed afterwards. Returns { status, html, finalUrl } or { error }. */
  async function read(url, { timeoutMs = 60_000, settleMs = 2_500, challengeMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let targetId = null;
    let onEvent = null;
    try {
      ({ targetId } = await send("Target.createTarget", { url: "about:blank" }));
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      await send("Network.enable", {}, sessionId);
      const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
      const mainFrame = frameTree.frame.id;
      /** The page's document answers, in order: a bot check that passes shows as 403 and then 200. */
      const answers = [];
      let loaded = 0;
      onEvent = (msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === "Network.responseReceived" && msg.params.type === "Document" && msg.params.frameId === mainFrame) answers.push({ status: msg.params.response.status, url: msg.params.response.url });
        if (msg.method === "Page.loadEventFired") loaded++;
      };
      listeners.add(onEvent);
      const nav = await send("Page.navigate", { url }, sessionId);
      // The navigation was given up: a download (not a page), a refused connection, a bad address. The caller asks plainly.
      if (nav.errorText) return { error: `Chrome could not open the page (${nav.errorText})` };
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
      if (onEvent) listeners.delete(onEvent);
      if (targetId && !gone) await send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }

  return {
    read,
    alive: () => !gone,
    close: async () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      await shut();
    },
  };
}

/**
 * Read one page with a Chrome started for it and closed after it. Returns { status, html, finalUrl } — status null
 * when the page gave no document answer — or { error } when Chrome could not be used. For many pages of one site use
 * openChrome and read them with the same browser.
 */
export async function readWithChrome({ chrome, profile, userAgent, url, timeoutMs = 60_000, settleMs = 2_500, challengeMs = 20_000 }) {
  const browser = await openChrome({ chrome, profile, userAgent });
  if (browser.error) return { error: browser.error };
  try {
    return await browser.read(url, { timeoutMs, settleMs, challengeMs });
  } finally {
    await browser.close();
  }
}
