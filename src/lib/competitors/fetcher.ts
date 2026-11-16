import { htmlToText, looksEmptyWithoutJs, looksLikeBotWall } from "./html";
import { resolvesToPrivate } from "./netguard";
import { isInsideSite, isPdfUrl } from "./url";

/** Redirect hops the plain fetch follows by hand (each target is checked before it is fetched). */
const MAX_REDIRECTS = 5;

/**
 * Is this redirect target ours to fetch? With a site host: inside that site only. Without one (sitemaps
 * named by robots.txt, preview images): any public host, never a private address (SSRF, story checklist §12).
 */
async function redirectAllowed(target: URL, host: string | undefined): Promise<boolean> {
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  if (host && !isInsideSite(target, host)) return false;
  // Name and addresses: a public-looking name that resolves into our network is refused too.
  return !(await resolvesToPrivate(target.hostname));
}

/**
 * Fetching one page of a competitor's website — the REMOTE lane (Website
 * Scanning PRD 2026-11-04). Plain HTTP first; a page that comes back empty
 * (JavaScript-only) or behind a bot wall is read again through headless
 * Chromium (Playwright), which the scanner container ships with and which is
 * always on in production. PDFs are pages: their text is extracted here.
 *
 * Nothing from the site is trusted as "unchanged": no conditional requests,
 * no 304. Every scan fetches every page and the server hashes the text.
 *
 * The app server never loads the browser: the import is dynamic and only
 * taken when the browser is available (the Cloud Run job, or
 * COMPETITORS_BROWSER=on locally).
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; PM-OS/1.0; +https://pm-os.io; competitor-analysis)";
/** The browser mode identifies itself too: a current Chrome UA with the PM-OS tag appended. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 PM-OS/1.0 (+https://pm-os.io)";

export const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_TIMEOUT_MS = 30_000;
/** PDFs bigger than this are not read (a 300-page brochure is not a product page). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export type FetchMode = "plain" | "browser";
export type FetchErrorKind = "timeout" | "http4xx" | "http5xx" | "botwall" | "login" | "notfound" | "noindex" | "slowdown" | "other" | "unreadable";

/** The user-facing category of a page that was not read (the PRD's reasons list). */
export function outcomeCategoryOf(error: FetchErrorKind | undefined): "denied" | "login" | "notfound" | "timeout" | "robots" | "slowdown" | "unreadable" {
  switch (error) {
    case "botwall":
    case "http4xx":
      return "denied";
    case "login":
      return "login";
    case "notfound":
      return "notfound";
    case "noindex":
      // The site asked robots to leave this page out — honoured like robots.txt.
      return "robots";
    case "slowdown":
      return "slowdown";
    case "unreadable":
      return "unreadable";
    case "timeout":
    case "http5xx":
    case "other":
    default:
      return "timeout";
  }
}

/** Errors worth a second attempt within the same scan (PRD: "ok if fail 1-3 times"). */
export function isRetryable(error: FetchErrorKind | undefined): boolean {
  return error === "timeout" || error === "http5xx" || error === "other";
}

export interface FetchedPage {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  /** Raw HTML ("" for PDFs and failures). */
  html: string;
  text: string;
  /** "page" | "document" (a PDF) */
  kind: "page" | "document";
  mode: FetchMode;
  ms: number;
  /** True when the site needs the browser: bot wall or no text without JS. */
  needsBrowser: boolean;
  /** The answer was a download (installer, archive, office file), not a page: skipped by the crawl, counted for nothing. */
  binary?: boolean;
  error?: FetchErrorKind;
  errorDetail?: string;
}

/**
 * The headless browser: always on in production (the job image ships
 * Chromium); locally only with COMPETITORS_BROWSER=on. COMPETITORS_BROWSER=off
 * turns it off anywhere (local dev without Playwright).
 */
export function browserAvailable(): boolean {
  const v = process.env.COMPETITORS_BROWSER?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return false;
  if (v === "on" || v === "true" || v === "1") return true;
  return process.env.NODE_ENV === "production";
}

/** What an HTTP answer is, from its status, its body and its X-Robots-Tag header (lower case). Also applied to the answers the scan station reports (address-finding.ts). */
export function classify(status: number, html: string, xRobots: string): Pick<FetchedPage, "error" | "errorDetail" | "needsBrowser"> {
  if (status === 429) return { error: "slowdown", errorDetail: "HTTP 429 Too Many Requests", needsBrowser: false };
  const wall = looksLikeBotWall(status, html);
  if (wall) return { error: "botwall", errorDetail: "bot protection", needsBrowser: true };
  if (status === 401 || status === 402 || status === 407) return { error: "login", errorDetail: `HTTP ${status}`, needsBrowser: false };
  if (status === 404 || status === 410) return { error: "notfound", errorDetail: `HTTP ${status}`, needsBrowser: false };
  if (status >= 500) return { error: "http5xx", errorDetail: `HTTP ${status}`, needsBrowser: false };
  if (status >= 400) return { error: "http4xx", errorDetail: `HTTP ${status}`, needsBrowser: false };
  if (/\b(noindex|none)\b/.test(xRobots)) return { error: "noindex", errorDetail: "X-Robots-Tag: noindex", needsBrowser: false };
  return { needsBrowser: false };
}

function failed(url: string, mode: FetchMode, t0: number, e: unknown): FetchedPage {
  const msg = e instanceof Error ? e.message : String(e);
  const timeout = /abort|timeout/i.test(msg);
  return { url, finalUrl: url, status: 0, html: "", text: "", kind: "page", mode, ms: Date.now() - t0, needsBrowser: false, error: timeout ? "timeout" : "other", errorDetail: msg.split("\n")[0].slice(0, 200) };
}

export async function fetchPlain(url: string, opts: { host?: string } = {}): Promise<FetchedPage> {
  const t0 = Date.now();
  try {
    // Redirects by hand: a competitor's page may 302 anywhere, and "anywhere" must not include our own network.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const location = res.headers.get("location");
      if (!(res.status >= 300 && res.status < 400 && location)) break;
      let target: URL;
      try {
        target = new URL(location, current);
      } catch {
        return { url, finalUrl: current, status: res.status, html: "", text: "", kind: "page", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "other", errorDetail: `redirect to an invalid address` };
      }
      if (!(await redirectAllowed(target, opts.host))) {
        return { url, finalUrl: current, status: res.status, html: "", text: "", kind: "page", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "notfound", errorDetail: `redirected outside the site (${target.hostname})` };
      }
      if (hop === MAX_REDIRECTS) {
        return { url, finalUrl: current, status: res.status, html: "", text: "", kind: "page", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "other", errorDetail: "too many redirects" };
      }
      current = target.href;
    }
    if (!res) throw new Error("no response");
    const finalUrl = current;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const xRobots = (res.headers.get("x-robots-tag") ?? "").toLowerCase();
    const isPdf = res.ok && (contentType.includes("application/pdf") || (isPdfUrl(finalUrl) && !contentType.includes("text/html")));
    if (isPdf) {
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_PDF_BYTES) {
        return { url, finalUrl, status: res.status, html: "", text: "", kind: "document", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "unreadable", errorDetail: `PDF larger than 20 MB (${Math.round(length / 1024 / 1024)} MB)` };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_PDF_BYTES) {
        return { url, finalUrl, status: res.status, html: "", text: "", kind: "document", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "unreadable", errorDetail: "PDF larger than 20 MB" };
      }
      let text: string;
      try {
        text = await pdfToText(bytes);
      } catch (e) {
        // PM-OS's own reader failed, not the site: the page is "could not be read" and the server log carries an error (Daniel 2026-11-09: fix the reader when it happens).
        const detail = `PDF could not be read: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}`;
        console.error(`[competitors] page could not be read — ${url} — ${detail}`);
        return { url, finalUrl, status: res.status, html: "", text: "", kind: "document", mode: "plain", ms: Date.now() - t0, needsBrowser: false, error: "unreadable", errorDetail: detail };
      }
      return { url, finalUrl, status: res.status, html: "", text, kind: "document", mode: "plain", ms: Date.now() - t0, needsBrowser: false };
    }
    // A download is not a page: its bytes must never be decoded, hashed and stored as text (Tomer's review 2026-11-10).
    // Text of any kind stays readable — HTML pages, and the XML/plain files the crawl reads for discovery (sitemaps, robots.txt).
    if (res.ok && contentType && !/^(text\/|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml|json))/.test(contentType.trim())) {
      return { url, finalUrl, status: res.status, html: "", text: "", kind: "page", mode: "plain", ms: Date.now() - t0, needsBrowser: false, binary: true, errorDetail: contentType.split(";")[0].trim() };
    }
    const html = await res.text();
    const text = htmlToText(html);
    const c = classify(res.status, html, xRobots);
    return {
      url,
      finalUrl,
      status: res.status,
      html,
      text,
      kind: "page",
      mode: "plain",
      ms: Date.now() - t0,
      needsBrowser: c.needsBrowser || (res.ok && !c.error && looksEmptyWithoutJs(text, html)),
      ...(c.error ? { error: c.error, errorDetail: c.errorDetail } : {}),
    };
  } catch (e) {
    return failed(url, "plain", t0, e);
  }
}

// ————— PDF text —————

type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }> }> };
};

/** PDF bytes → text, one line per text run, page breaks as blank lines. Shared by both lanes (the server parses what the local lane posts). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  // Computed specifier: the Next bundler must not pull pdf.js into the app routes' client graph.
  const mod = "pdfjs-dist/legacy/build/pdf.mjs";
  const pdfjs = (await import(mod)) as PdfJs;
  // Inside a bundled Next server pdf.js points at a chunk-relative worker that does not exist: always use the absolute path.
  const { createRequire } = await import("node:module");
  pdfjs.GlobalWorkerOptions.workerSrc = createRequire(`${process.cwd()}/package.json`).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const out: string[] = [];
  const pages = Math.min(doc.numPages, 400);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items) {
      if (item.str) line += item.str;
      if (item.hasEOL) {
        out.push(line.trim());
        line = "";
      } else if (item.str && !item.str.endsWith(" ")) {
        line += " ";
      }
    }
    if (line.trim()) out.push(line.trim());
    out.push("");
  }
  return out.map((l) => l.replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
/** Scans using the browser right now (inline mode runs several scans in one process; the Cloud Run job runs one). */
let browserUsers = 0;

/** A scan that may need the browser says so up front; releaseBrowser() when it is done. The browser closes when the last user leaves. */
export function acquireBrowser(): void {
  browserUsers++;
}

export async function releaseBrowser(): Promise<void> {
  browserUsers = Math.max(0, browserUsers - 1);
  if (browserUsers === 0) await closeBrowser();
}

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

export async function fetchWithBrowser(url: string, host?: string): Promise<FetchedPage> {
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
    const landed = page.url();
    try {
      const landedUrl = new URL(landed);
      if (!redirectAllowed(landedUrl, host) && landedUrl.href !== url) {
        return { url, finalUrl: landed, status, html: "", text: "", kind: "page", mode: "browser", ms: Date.now() - t0, needsBrowser: true, error: "notfound", errorDetail: `redirected outside the site (${landedUrl.hostname})` };
      }
    } catch {
      // about:blank and the like: keep what the page gave
    }
    const text = htmlToText(html);
    const c = classify(status, html, "");
    return { url, finalUrl: landed, status, html, text, kind: "page", mode: "browser", ms: Date.now() - t0, needsBrowser: true, ...(c.error ? { error: c.error, errorDetail: c.errorDetail } : {}) };
  } catch (e) {
    return { ...failed(url, "browser", t0, e), needsBrowser: true };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Fetch in the given mode (PDFs are always fetched plain). */
export function fetchPage(url: string, mode: FetchMode, host?: string): Promise<FetchedPage> {
  return mode === "browser" && !isPdfUrl(url) ? fetchWithBrowser(url, host) : fetchPlain(url, { host });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
