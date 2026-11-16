/**
 * PM-OS local scan station — what the search for a company's OTHER ADDRESSES needs (help center, developer docs,
 * release notes), brought with the scan of the company's main website (Daniel 2026-11-16).
 *
 * Why here: the search follows the scan lanes. While remote scanning is off, PM-OS itself requests nothing from a
 * company's site — only this station does, so sites do not block PM-OS. The search needs three things from the
 * site, and the station brings them right after it handed the home page in:
 *
 *   1. the home page it just read (PM-OS takes the links that leave the site from it);
 *   2. the site's /llms.txt, when it has one;
 *   3. what a short list of addresses answers. PM-OS gives the exact list — what the company named, the guessed names
 *      in front of its domain and one made-up name — and for each the station reports what it got: the status, where
 *      it landed, the start of the page.
 *
 * The station only fetches and reports. Which link is a candidate, whether a guess counts, what an address is: all
 * of that is decided by PM-OS (src/lib/competitors/address-finding.ts), from this report.
 *
 * The same manners as the scan: one request at a time with the scan's pause before each, a browser's identity, and a
 * "slow down" answer (429) stops the asking. An address that is not a public one is never requested — not the one
 * given, and not one a redirect points at (nothing a page points at on this Mac's own network is ever read).
 *
 * Nothing happens when the module is loaded, and all I/O is handed in (`deps`), so the step can be tested without a
 * network (tests/unit/competitors-address-lanes.test.ts).
 */

/** The start of an answer that is sent to PM-OS, in characters (PM-OS cuts at the same place). */
export const ANSWER_MAX_CHARS = 500_000;
/** An llms.txt longer than this is cut. */
export const LLMS_MAX_CHARS = 400_000;
/** Redirect hops followed by hand (each target is checked before it is requested). */
export const MAX_REDIRECTS = 5;
/** The most addresses asked for one site, whatever the list says. */
export const MAX_ASK = 40;
/** One call to PM-OS stays under this (its route refuses 30 MB). */
export const MAX_CALL_BYTES = 24 * 1024 * 1024;

const TEXT_TYPE = /^(text\/|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml|json))/;

/** The same "site" rule as the scan: the hostname without a leading www., plus a non-default port. */
function siteOf(u) {
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}`;
}

/** Is this host name (or IP literal) a private one — this Mac, its network, a link-local address? The same rule as PM-OS (url.ts isPrivateHost). */
export function isPrivateName(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h === "::" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd");
  return false;
}

/**
 * May this address be requested from this Mac? http(s), a public name, and every address the name resolves to is
 * public. A name that does not resolve is let through: the request that follows reports the real failure.
 *   deps.lookup(hostname) → [{ address }]   (node:dns/promises lookup with { all: true })
 *   deps.allowPrivate                       tests only: a fixture site on this machine
 */
export async function mayRequest(u, deps) {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (deps.allowPrivate) return true;
  if (isPrivateName(u.hostname)) return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return true;
  try {
    const found = await deps.lookup(h);
    return !found.some((a) => isPrivateName(a.address));
  } catch {
    return true;
  }
}

/**
 * One address, asked once: a plain GET with a browser's identity, redirects followed by hand. Reports what it got
 * and applies no rule to it:
 *   { url, status, finalUrl, xRobots, html }   a text answer of any status — `html` is the start of the body
 *   { url, status, finalUrl, binary: true }    an answer that is not text (a download, an image, a PDF): not read
 *   { url, status: 0, error }                  no answer: "timeout" | "other", or "private" (not a public address)
 *   { url, status: 3xx, finalUrl, error }      a redirect that was not followed: "notfound" (it leaves `sameSite`, or
 *                                              points at an address that may not be requested), "other" (too many hops)
 * `sameSite` (a site key) keeps the redirects inside that site — for /llms.txt: another site's file says nothing
 * about this one.
 *   deps.fetch, deps.lookup, deps.allowPrivate, deps.userAgent, deps.timeoutMs
 */
export async function askAddress(url, deps, opts = {}) {
  const maxChars = opts.maxChars ?? ANSWER_MAX_CHARS;
  let current;
  try {
    current = new URL(url);
  } catch {
    return { url, status: 0, finalUrl: url, error: "other" };
  }
  if (!(await mayRequest(current, deps))) return { url, status: 0, finalUrl: url, error: "private" };
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await deps.fetch(current.href, {
        headers: { "user-agent": deps.userAgent, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7", "accept-language": "en-US,en;q=0.9" },
        redirect: "manual",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
      });
    } catch (e) {
      return { url, status: 0, finalUrl: url, error: /abort|timeout/i.test(String(e)) ? "timeout" : "other" };
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      let target;
      try {
        target = new URL(location, current);
      } catch {
        return { url, status: res.status, finalUrl: current.href, error: "other" };
      }
      if ((opts.sameSite && siteOf(target) !== opts.sameSite) || !(await mayRequest(target, deps))) return { url, status: res.status, finalUrl: current.href, error: "notfound" };
      if (hop >= MAX_REDIRECTS) return { url, status: res.status, finalUrl: current.href, error: "other" };
      current = target;
      continue;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase().trim();
    const xRobots = (res.headers.get("x-robots-tag") ?? "").toLowerCase();
    if (res.ok && contentType && !TEXT_TYPE.test(contentType)) return { url, status: res.status, finalUrl: current.href, xRobots, binary: true };
    let html = "";
    try {
      html = (await res.text()).slice(0, maxChars);
    } catch {
      // the answer broke off: what the status says is still reported
    }
    return { url, status: res.status, finalUrl: current.href, xRobots, html };
  }
}

/** The site's /llms.txt, asked once; redirects stay inside the site. */
export function readLlms(siteUrl, deps) {
  const u = new URL("/llms.txt", siteUrl);
  return askAddress(u.href, deps, { sameSite: siteOf(new URL(siteUrl)), maxChars: LLMS_MAX_CHARS });
}

/** The body of one call to PM-OS, small enough to be taken: the largest answers lose their page until it fits (they are reported as answers without a readable page). */
export function fitCall(payload) {
  const size = (p) => Buffer.byteLength(JSON.stringify(p), "utf8");
  if (!Array.isArray(payload.answers) || size(payload) <= MAX_CALL_BYTES) return payload;
  const answers = payload.answers.map((a) => ({ ...a }));
  const bySize = answers.filter((a) => a.html).sort((a, b) => b.html.length - a.html.length);
  for (const a of bySize) {
    delete a.html;
    a.error = "other";
    if (size({ ...payload, answers }) <= MAX_CALL_BYTES) break;
  }
  return { ...payload, answers };
}

/**
 * The whole step for one scan of a company's main website, right after its home page was handed in.
 *
 *   siteUrl      the site being scanned
 *   home         { url, finalUrl, html, plainHtml? } — the home page as it was handed in; `plainHtml` is the plain
 *                answer when the page was rendered with Chrome
 *   call(body)   POST /api/competitors/local/scans/<id>/addresses → the JSON answer (throws on a refusal)
 *   pause()      the scan's pause between two requests of one site
 *   online()     does this Mac reach the internet at all
 *   deps         for askAddress
 *   log(msg)
 *
 * Returns { result, asked?, candidates? }:
 *   "handed in"   PM-OS has the report and runs the search from it
 *   "slowdown"    /llms.txt answered 429: the site asked to slow down — nothing more is asked for the search in this
 *                 scan (PM-OS looks again with the next scan of the site)
 *   "offline"     the network dropped during the step: nothing is reported, so no address is judged "not there"
 *                 because this Mac was offline (PM-OS looks again with the next scan)
 *   "refused"     PM-OS did not take the call (an older PM-OS without this route, a scan that ended)
 * It never throws: the search must never cost the scan.
 */
export async function runAddressStep({ siteUrl, home, call, pause, online, deps, log }) {
  try {
    let checkedOnline = 0;
    const offline = async () => {
      // "No answer" is the site's only if this Mac is online; asked at most once in 15 s.
      if (Date.now() - checkedOnline < 15_000) return false;
      checkedOnline = Date.now();
      return !(await online());
    };
    await pause();
    const llms = await readLlms(siteUrl, deps);
    if (llms.status === 429) {
      log("  other addresses: /llms.txt answered slow down (429) — not asked further in this scan; PM-OS looks again with the next scan");
      return { result: "slowdown" };
    }
    if (llms.status === 0 && llms.error !== "private" && (await offline())) {
      log("  other addresses: network lost — nothing reported; PM-OS looks again with the next scan");
      return { result: "offline" };
    }
    const found = { home: { url: home.url, finalUrl: home.finalUrl, html: home.html, ...(home.plainHtml ? { plainHtml: home.plainHtml.slice(0, ANSWER_MAX_CHARS) } : {}) }, llms };
    let plan;
    try {
      plan = await call(found);
    } catch (e) {
      log(`  other addresses: PM-OS did not take the home page's links (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — skipped`);
      return { result: "refused" };
    }
    const ask = (Array.isArray(plan?.ask) ? plan.ask : []).filter((u) => typeof u === "string" && u).slice(0, MAX_ASK);
    const answers = [];
    let stopped = null;
    for (const url of ask) {
      await pause();
      const a = await askAddress(url, deps);
      if (a.status === 0 && a.error !== "private" && (await offline())) {
        log("  other addresses: network lost — nothing reported; PM-OS looks again with the next scan");
        return { result: "offline" };
      }
      answers.push(a);
      if (a.status === 429) {
        // The site asked to slow down: stop asking. What was asked so far is reported; PM-OS looks again with the next scan.
        stopped = "slowdown";
        log(`  other addresses: slow down (429) at ${url} — stopped asking, ${ask.length - answers.length} addresses not asked`);
        break;
      }
    }
    let done;
    try {
      done = await call(fitCall({ ...found, answers, ...(stopped ? { stopped } : {}) }));
    } catch (e) {
      log(`  other addresses: PM-OS did not take the answers (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — skipped`);
      return { result: "refused" };
    }
    const pages = answers.filter((a) => a.status >= 200 && a.status < 300 && a.html).length;
    log(`  other addresses: asked /llms.txt (${llms.status || llms.error}) and ${answers.length} address${answers.length === 1 ? "" : "es"} (${pages} answered a page) — handed in, ${done?.candidates ?? "?"} candidate${done?.candidates === 1 ? "" : "s"} for PM-OS to judge`);
    return { result: "handed in", asked: answers.length, candidates: done?.candidates ?? null };
  } catch (e) {
    log(`  other addresses: the step failed (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — the scan goes on`);
    return { result: "refused" };
  }
}
