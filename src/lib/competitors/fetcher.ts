import { htmlToText, looksEmptyWithoutJs, looksLikeBotWall } from "./html";

/**
 * Fetching one page of a competitor's website. Plain HTTP first (fast, cheap);
 * a site that answers with a bot wall or JS-only pages is re-read through
 * headless Chromium (Playwright), which the scanner container ships with.
 * The app server never loads the browser: the import is dynamic and only
 * taken when COMPETITORS_BROWSER=on (the Cloud Run job sets it).
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; PM-OS/1.0; +https://pm-os.io; competitor-analysis)";
/** A current desktop Chrome UA for the browser mode — Cloudflare's basic check wants one. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_TIMEOUT_MS = 30_000;

export type FetchMode = "plain" | "browser";
export type FetchErrorKind = "timeout" | "http4xx" | "http5xx" | "botwall" | "login" | "notfound" | "noindex" | "other";

/** Validators from the previous scan of the same URL — sent as conditional headers. */
export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

/** The user-facing category of a page that was not read (scanner rules, "what users see"). */
export function outcomeCategoryOf(error: FetchErrorKind | undefined): "denied" | "login" | "notfound" | "timeout" | "policy" {
  switch (error) {
    case "botwall":
    case "http4xx":
      return "denied";
    case "login":
      return "login";
    case "notfound":
      return "notfound";
    case "noindex":
      return "policy";
    case "timeout":
    case "http5xx":
    case "other":
    default:
      return "timeout";
  }
}

export interface FetchedPage {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  html: string;
  text: string;
  mode: FetchMode;
  ms: number;
  /** True when the site needs the browser: bot wall or no text without JS. */
  needsBrowser: boolean;
  /** 304 Not Modified — the previous scan's text still stands. */
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  error?: FetchErrorKind;
  errorDetail?: string;
}

export function browserAvailable(): boolean {
  const v = process.env.COMPETITORS_BROWSER?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export async function fetchPlain(url: string, validators: Validators = {}): Promise<FetchedPage> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...(validators.etag ? { "if-none-match": validators.etag } : {}),
        ...(validators.lastModified ? { "if-modified-since": validators.lastModified } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (res.status === 304) {
      return { url, finalUrl: res.url || url, status: 304, html: "", text: "", mode: "plain", ms: Date.now() - t0, needsBrowser: false, notModified: true, etag, lastModified };
    }
    const html = await res.text();
    const text = htmlToText(html);
    const wall = looksLikeBotWall(res.status, html);
    const page: FetchedPage = {
      url,
      finalUrl: res.url || url,
      status: res.status,
      html,
      text,
      mode: "plain",
      ms: Date.now() - t0,
      needsBrowser: wall || (res.ok && looksEmptyWithoutJs(text, html)),
      etag,
      lastModified,
    };
    const xRobots = (res.headers.get("x-robots-tag") ?? "").toLowerCase();
    if (wall) {
      page.error = "botwall";
    } else if (res.status === 401 || res.status === 402 || res.status === 407) {
      page.error = "login";
      page.errorDetail = `HTTP ${res.status}`;
    } else if (res.status === 404 || res.status === 410) {
      page.error = "notfound";
      page.errorDetail = `HTTP ${res.status}`;
    } else if (res.status >= 500) {
      page.error = "http5xx";
      page.errorDetail = `HTTP ${res.status}`;
    } else if (res.status >= 400) {
      page.error = "http4xx";
      page.errorDetail = `HTTP ${res.status}`;
    } else if (/\b(noindex|none)\b/.test(xRobots)) {
      // The site asked robots to leave this page out — honoured like robots.txt.
      page.error = "noindex";
      page.errorDetail = "X-Robots-Tag: noindex";
    }
    return page;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /abort|timeout/i.test(msg);
    return {
      url,
      finalUrl: url,
      status: 0,
      html: "",
      text: "",
      mode: "plain",
      ms: Date.now() - t0,
      needsBrowser: false,
      error: timeout ? "timeout" : "other",
      errorDetail: msg.slice(0, 200),
    };
  }
}

// ————— Browser mode —————

type PwBrowser = {
  newPage(opts: { userAgent: string; locale?: string }): Promise<PwPage>;
  close(): Promise<void>;
};
type PwPage = {
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
};

let browserPromise: Promise<PwBrowser> | null = null;

async function getBrowser(): Promise<PwBrowser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // Computed specifier: the Next bundler must not try to resolve Playwright
      // into the app; the scanner image has it installed.
      const mod = "playwright";
      const pw = (await import(mod)) as { chromium: { launch(o: { headless: boolean }): Promise<PwBrowser> } };
      return pw.chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => undefined);
}

export async function fetchWithBrowser(url: string): Promise<FetchedPage> {
  const t0 = Date.now();
  let page: PwPage | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({ userAgent: BROWSER_UA, locale: "en-US" });
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
    let status = res?.status() ?? 0;
    let html = await page.content();
    // A Cloudflare challenge resolves itself in a few seconds; wait once for it.
    if (looksLikeBotWall(status, html)) {
      await page.waitForTimeout(6000);
      html = await page.content();
      status = looksLikeBotWall(status, html) ? status : 200;
    } else if (looksEmptyWithoutJs(htmlToText(html), html)) {
      await page.waitForTimeout(2500);
      html = await page.content();
    }
    const text = htmlToText(html);
    const wall = looksLikeBotWall(status, html);
    const out: FetchedPage = {
      url,
      finalUrl: page.url(),
      status,
      html,
      text,
      mode: "browser",
      ms: Date.now() - t0,
      needsBrowser: true,
    };
    if (wall) out.error = "botwall";
    else if (status === 401 || status === 402) { out.error = "login"; out.errorDetail = `HTTP ${status}`; }
    else if (status === 404 || status === 410) { out.error = "notfound"; out.errorDetail = `HTTP ${status}`; }
    else if (status >= 500) { out.error = "http5xx"; out.errorDetail = `HTTP ${status}`; }
    else if (status >= 400) { out.error = "http4xx"; out.errorDetail = `HTTP ${status}`; }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      url,
      finalUrl: url,
      status: 0,
      html: "",
      text: "",
      mode: "browser",
      ms: Date.now() - t0,
      needsBrowser: true,
      error: /timeout/i.test(msg) ? "timeout" : "other",
      errorDetail: msg.split("\n")[0].slice(0, 200),
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Fetch in the given mode (conditional headers only make sense in plain mode). */
export function fetchPage(url: string, mode: FetchMode, validators: Validators = {}): Promise<FetchedPage> {
  return mode === "browser" ? fetchWithBrowser(url) : fetchPlain(url, validators);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
