import {
  addressRefusal,
  answeredPage,
  controlAddress,
  guessCandidates,
  guessVerdict,
  linkCandidates,
  linksWithText,
  llmsCandidates,
  llmsTxtLinks,
  looksLikeLlmsTxt,
  MAX_CANDIDATES,
  mergeCandidates,
  OPENING_CHARS,
  siteAddressOf,
  type Answer,
  type Candidate,
  type FoundVia,
  type RawCandidate,
} from "./addresses";
import { classify, type FetchedPage } from "./fetcher";
import { htmlToText, titleOf } from "./html";
import { isInsideSite, siteHost } from "./url";

/**
 * The search for a company's OTHER ADDRESSES — from what the company's site says to the list of candidates
 * (Website Scanning, "Other addresses of a company"). The rules are addresses.ts; the database side and PMOS AI are
 * address-search.ts.
 *
 * The search needs three things from the company's site — its MATERIAL: the home page (for its links), the site's
 * /llms.txt, and what a handful of addresses answer (the ones the company named, the guessed names, the made-up
 * name). Who requests them follows the scan lanes (addresses.ts searchLane):
 *
 *   the server   findCandidates() requests them itself — only while remote scanning is ON;
 *   the station  the scan station hands them in with its scan of the company's main website
 *                (POST /api/competitors/local/scans/<id>/addresses): readStationReport() → materialFromStation()
 *                → addressesToAsk() (the exact list the station is given) → stationAnswers().
 *
 * Either way the same function, assembleFinding(), turns the material and the answers into the candidates — so the
 * station's report gives the candidates the server's own requests would have given.
 *
 * No database. The only network is the `net` a caller hands to findCandidates().
 */

export interface Finding {
  /** The addresses that may be worth scanning: they answer (or the company itself links to them), one per site. */
  candidates: Candidate[];
  /** Candidates left out because there were more than MAX_CANDIDATES. */
  dropped: number;
  /** How many candidates each way found, before they were merged. */
  byMethod: Record<FoundVia, number>;
  /** The site's llms.txt: its text, "gone" when the site answers not-found for it, null when it could not be read this time. */
  llms: { url: string; text: string } | "gone" | null;
  /** The home page could not be read: no links were taken. */
  homeUnread: string | null;
}

/** What the search has from the company's main site before any other address is asked. */
export interface SearchMaterial {
  /** The home page, when it was read. */
  home: { html: string; finalUrl: string } | null;
  /** Why the home page was not read; null when it was. */
  homeUnread: string | null;
  /** The home page as an answer, for "the page that answers is not the main site again". */
  homeAnswer: Answer | null;
  llms: Finding["llms"];
}

export const NO_ANSWER = (url: string, error: string): Answer => ({ url, status: 0, error, finalUrl: url, title: "", text: "" });

/** What the server's own fetch of an address answered. */
export function answerOfPage(url: string, page: Pick<FetchedPage, "status" | "binary" | "error" | "finalUrl" | "html" | "text">): Answer {
  return { url, status: page.status, error: page.binary ? "binary" : page.error ?? null, finalUrl: page.finalUrl || url, title: page.html ? titleOf(page.html) : "", text: page.text };
}

/** A home page that was read, as an answer. */
export function homeAsAnswer(siteUrl: string, home: { html: string; finalUrl: string }): Answer {
  return { url: siteUrl, status: 200, error: null, finalUrl: home.finalUrl, title: titleOf(home.html), text: htmlToText(home.html) };
}

/**
 * What the answer for /llms.txt says: the file's text; "gone" when the site has none (not found, or the site's own
 * page served for an address it does not have); null when it could not be read this time.
 */
export function llmsOf(llmsUrl: string, a: { status: number; error: string | null; binary: boolean; body: string }): Finding["llms"] {
  const ok = a.status >= 200 && a.status < 300 && !a.binary;
  if (ok && !a.error && looksLikeLlmsTxt(a.body)) return { url: llmsUrl, text: a.body };
  if (a.error === "notfound" || ok) return "gone";
  return null;
}

type Found = RawCandidate & { title: string; opening: string };

/** 1 + 2. What the company itself named: the links of its home page and the addresses of its llms.txt, one per site. */
export function namedOf(site: { url: string; host: string }, m: SearchMaterial): { fromLinks: RawCandidate[]; fromLlms: RawCandidate[]; named: Candidate[]; dropped: number } {
  const fromLinks = m.home ? linkCandidates(linksWithText(m.home.html, m.home.finalUrl), site.host) : [];
  const fromLlms = m.llms && m.llms !== "gone" ? llmsCandidates(llmsTxtLinks(m.llms.text, m.llms.url), site.host) : [];
  const named = mergeCandidates([...fromLinks, ...fromLlms].map((c) => ({ ...c, title: "", opening: "" })), MAX_CANDIDATES);
  return { fromLinks, fromLlms, named: named.candidates, dropped: named.dropped };
}

/** Where each named address lands and what it shows. The company links to it, so it stays a candidate unless the address is plainly not there or leads back. */
function landedOf(named: Candidate[], answers: ReadonlyMap<string, Answer>, mainHost: string): Found[] {
  const found: Found[] = [];
  for (const c of named) {
    const a = answers.get(c.url);
    if (!a || a.status === 0 || a.error === "notfound" || a.error === "private") continue;
    let landed: URL;
    try {
      landed = new URL(a.finalUrl);
    } catch {
      continue;
    }
    if (addressRefusal(landed, mainHost)) continue;
    const page = answeredPage(a);
    found.push({ ...c, url: siteAddressOf(landed), host: siteHost(landed), title: page ? a.title : "", opening: page ? a.text.slice(0, OPENING_CHARS) : "" });
  }
  return found;
}

/** 3a. The guesses still worth asking: a name the company already named — or one a named address landed on — is not guessed. */
function guessesLeft(site: { url: string; host: string }, named: Candidate[], found: Found[]): RawCandidate[] {
  const namedHosts = new Set([...named.map((c) => c.host), ...found.map((c) => c.host)]);
  return guessCandidates(site).filter((g) => !namedHosts.has(g.host));
}

/**
 * The exact list of addresses to ask for one search, when they are all asked in one round (the station): the
 * made-up name first — without its answer no guess can be judged — then what the company named, then the guessed
 * names it did not name. At most 1 + MAX_CANDIDATES + the number of guessed names.
 */
export function addressesToAsk(site: { url: string; host: string }, m: SearchMaterial, token: string): string[] {
  const { named } = namedOf(site, m);
  const guesses = guessesLeft(site, named, []);
  return [...new Set([...(guesses.length ? [controlAddress(site, token)] : []), ...named.map((c) => c.url), ...guesses.map((g) => g.url)])];
}

/**
 * The material and the answers → the candidates. `answers` is what each asked address answered, by the address
 * asked; an address with no answer in it was not asked. A guess is judged only when the made-up name was asked
 * too: without it, a domain that answers for any name would make every guess count.
 */
export function assembleFinding(site: { url: string; host: string }, m: SearchMaterial, answers: ReadonlyMap<string, Answer>, token: string): Finding {
  const { fromLinks, fromLlms, named, dropped } = namedOf(site, m);
  const found = landedOf(named, answers, site.host);
  const control = answers.get(controlAddress(site, token));
  let guessed = 0;
  if (control) {
    for (const g of guessesLeft(site, named, found)) {
      const a = answers.get(g.url);
      if (!a) continue;
      const verdict = guessVerdict(a, control, { host: site.host, home: m.homeAnswer });
      if (!verdict.counts) continue;
      guessed++;
      found.push({ ...g, url: verdict.url, host: verdict.host, title: a.title, opening: a.text.slice(0, OPENING_CHARS) });
    }
  }
  const merged = mergeCandidates(found, MAX_CANDIDATES);
  return { candidates: merged.candidates, dropped: dropped + merged.dropped, byMethod: { link: fromLinks.length, llms: fromLlms.length, guess: guessed }, llms: m.llms, homeUnread: m.homeUnread };
}

// ————— The server requests the material itself (remote scanning ON) —————

/** The network of a server-side search: the scanner's own fetcher and the public-address guard. */
export interface SearchNet {
  fetch(url: string, opts?: { host?: string }): Promise<FetchedPage>;
  isPublic(url: string): Promise<boolean>;
}

/** Addresses fetched at once during a server-side search. */
const FETCHES_AT_ONCE = 4;

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, items.length) }, worker));
  return out;
}

/**
 * Steps 1–3 for one site, requested by the server: fetch the home page and take its links (1); fetch /llms.txt
 * and take its addresses (2) — redirects stay inside the site: another site's file says nothing about this one;
 * ask what the company named once each, then the guessed names and one made-up name (3). `home` is the home page
 * when the caller already fetched it; `token` names the made-up host of the verification. Every address goes
 * through the public-address guard before anything is fetched from it.
 */
export async function findCandidates(site: { url: string; host: string }, home: { html: string; finalUrl: string } | null, token: string, net: SearchNet): Promise<Finding> {
  let homePage = home;
  let homeUnread: string | null = null;
  let homeAnswer: Answer | null = null;
  if (!homePage) {
    if (await net.isPublic(site.url)) {
      const page = await net.fetch(site.url, { host: site.host });
      homeAnswer = answerOfPage(site.url, page);
      if (page.html && !page.error) homePage = { html: page.html, finalUrl: page.finalUrl || site.url };
      else homeUnread = page.errorDetail ?? page.error ?? "no answer";
    } else {
      homeUnread = "not a public address";
    }
  }
  let llms: Finding["llms"] = null;
  const llmsUrl = new URL("/llms.txt", site.url).href;
  if (await net.isPublic(llmsUrl)) {
    const page = await net.fetch(llmsUrl, { host: site.host });
    llms = llmsOf(llmsUrl, { status: page.status, error: page.error ?? null, binary: Boolean(page.binary), body: page.html });
  }
  const material: SearchMaterial = { home: homePage, homeUnread, homeAnswer: homeAnswer ?? (homePage ? homeAsAnswer(site.url, homePage) : null), llms };

  const ask = async (url: string): Promise<Answer> => ((await net.isPublic(url)) ? answerOfPage(url, await net.fetch(url)) : NO_ANSWER(url, "private"));
  const answers = new Map<string, Answer>();
  // What the company itself named is asked once each: where does it land, what does it show.
  const { named } = namedOf(site, material);
  for (const a of await inBatches(named.map((c) => c.url), ask)) answers.set(a.url, a);
  // Common names in front of the domain, verified against a made-up name.
  const guesses = guessesLeft(site, named, landedOf(named, answers, site.host));
  if (guesses.length) for (const a of await inBatches([controlAddress(site, token), ...guesses.map((g) => g.url)], ask)) answers.set(a.url, a);
  return assembleFinding(site, material, answers, token);
}

// ————— The scan station hands the material in (the local lane) —————

/** The start of an answer's HTML that is kept — the station cuts there too, and so is the home page it is compared with. */
export const ANSWER_HTML_CHARS = 500_000;
/** The home page as handed in for its links (the same limit as a page of the scan). */
export const HOME_HTML_BYTES = 2 * 1024 * 1024;
/** The most answers one report may carry (the list given is 1 + MAX_CANDIDATES + the guessed names at most). */
export const MAX_STATION_ANSWERS = 40;

/** One request the station made, as it reports it — no rule is applied on the station. */
export interface StationFetch {
  /** The address asked. */
  url: string;
  /** HTTP status; 0 = no answer at all. */
  status: number;
  /** Where the answer came from after redirects. */
  finalUrl: string;
  /** The X-Robots-Tag header, lower case. */
  xRobots: string;
  /** The start of the body ("" when it was not text, or there was none). */
  body: string;
  /** The answer was not text (a download, an image, a PDF). */
  binary: boolean;
  /** Set by the station when there is no page to report: "timeout" | "other" (no answer), "private" (not a public address), "notfound" (redirected to an address that may not be asked). */
  error: string | null;
}

export interface StationReport {
  /** The home page the station read with its scan: as handed in (rendered with the browser where needed) for the links; `plainHtml` is the plain answer when the page was rendered. */
  home: { finalUrl: string; html: string; plainHtml: string | null };
  /** The answer for /llms.txt; null when the station did not get to ask. */
  llms: StationFetch | null;
  /** What the addresses it was given answered; null in the first call (the station asks for the list). */
  answers: StationFetch[] | null;
  /** Set when the station stopped asking before the end of the list ("slowdown": an address answered 429). */
  stopped: string | null;
}

const STATION_ERRORS = new Set(["timeout", "other", "private", "notfound"]);

function readStationFetch(raw: unknown, url: string | null, bodyChars: number): StationFetch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const asked = url ?? (typeof r.url === "string" ? r.url.trim() : "");
  if (!asked) return null;
  const status = typeof r.status === "number" && Number.isFinite(r.status) && r.status >= 100 && r.status < 600 ? Math.round(r.status) : 0;
  const body = typeof r.html === "string" ? r.html : typeof r.body === "string" ? r.body : "";
  return {
    url: asked,
    status,
    finalUrl: typeof r.finalUrl === "string" && r.finalUrl ? r.finalUrl : asked,
    xRobots: typeof r.xRobots === "string" ? r.xRobots.toLowerCase().slice(0, 200) : "",
    body: body.slice(0, bodyChars),
    binary: r.binary === true,
    error: typeof r.error === "string" && r.error ? (STATION_ERRORS.has(r.error) ? r.error : "other") : status === 0 ? "other" : null,
  };
}

/**
 * The body of the station's call, checked field by field. `{ error }` for anything that is not a report: no home
 * page, or a home page that is not inside the company's site.
 */
export function readStationReport(raw: unknown, site: { url: string; host: string }): StationReport | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the body must be an object" };
  const r = raw as Record<string, unknown>;
  const h = (r.home ?? null) as Record<string, unknown> | null;
  if (!h || typeof h !== "object" || typeof h.html !== "string" || !h.html.trim()) return { error: "home.html is required: the home page the station read" };
  let finalUrl = site.url;
  if (typeof h.finalUrl === "string" && h.finalUrl) {
    try {
      if (!isInsideSite(new URL(h.finalUrl), site.host)) return { error: `home.finalUrl is outside the company's site (${site.host})` };
      finalUrl = h.finalUrl;
    } catch {
      return { error: "home.finalUrl is not an address" };
    }
  }
  const html = Buffer.byteLength(h.html, "utf8") > HOME_HTML_BYTES ? Buffer.from(h.html, "utf8").subarray(0, HOME_HTML_BYTES).toString("utf8") : h.html;
  const answers = Array.isArray(r.answers) ? r.answers.slice(0, MAX_STATION_ANSWERS).map((a) => readStationFetch(a, null, ANSWER_HTML_CHARS)).filter((a): a is StationFetch => a != null) : null;
  return {
    home: { finalUrl, html, plainHtml: typeof h.plainHtml === "string" && h.plainHtml.trim() ? h.plainHtml : null },
    llms: readStationFetch(r.llms, new URL("/llms.txt", site.url).href, Number.MAX_SAFE_INTEGER),
    answers,
    stopped: typeof r.stopped === "string" && r.stopped ? r.stopped.slice(0, 40) : null,
  };
}

/** What a request of the station is, judged exactly as the server judges its own fetch (fetcher.ts classify). */
export function answerFromStation(r: StationFetch): Answer {
  if (r.status === 0) return NO_ANSWER(r.url, r.error ?? "other");
  if (r.error) return { url: r.url, status: r.status, error: r.error, finalUrl: r.finalUrl, title: "", text: "" };
  if (r.binary) return { url: r.url, status: r.status, error: "binary", finalUrl: r.finalUrl, title: "", text: "" };
  const html = r.body.slice(0, ANSWER_HTML_CHARS);
  return { url: r.url, status: r.status, error: classify(r.status, html, r.xRobots).error ?? null, finalUrl: r.finalUrl, title: html ? titleOf(html) : "", text: htmlToText(html) };
}

/**
 * The search's material from the station's report. The home page is compared with the guesses as the station's
 * plain answer for it, cut where every answer is cut — so a name that serves the home page again is told apart
 * the same way whoever asked.
 */
export function materialFromStation(site: { url: string; host: string }, report: StationReport): SearchMaterial {
  const home = { html: report.home.html, finalUrl: report.home.finalUrl };
  const llmsUrl = new URL("/llms.txt", site.url).href;
  const l = report.llms;
  return {
    home,
    homeUnread: null,
    homeAnswer: homeAsAnswer(site.url, { html: (report.home.plainHtml ?? report.home.html).slice(0, ANSWER_HTML_CHARS), finalUrl: report.home.finalUrl }),
    llms: l ? llmsOf(llmsUrl, { status: l.status, error: l.status === 0 ? l.error ?? "other" : l.error ?? classify(l.status, l.body, l.xRobots).error ?? null, binary: l.binary, body: l.body }) : null,
  };
}

/** The station's answers by the address asked — only for the addresses it was given (`asked`); anything else it sends is ignored. */
export function stationAnswers(asked: string[], answers: StationFetch[]): Map<string, Answer> {
  const allowed = new Set(asked);
  const out = new Map<string, Answer>();
  for (const a of answers) if (allowed.has(a.url) && !out.has(a.url)) out.set(a.url, answerFromStation(a));
  return out;
}

/** One call of the station, answered: its list of addresses to ask (the first call), or the candidates (the call that brings the answers). */
export type StationStep =
  | { error: string }
  | { ask: string[] }
  | { ask: string[]; finding: Finding; /** How many of the listed addresses the station brought an answer for. */ answered: number; stopped: string | null };

/**
 * What PM-OS does with one call of the station (the route local/scans/<id>/addresses): nothing is kept between the
 * calls — the list is computed from the home page and llms.txt every time, so the list the station was given and
 * the answers it brings always match.
 */
export function stationStep(site: { url: string; host: string }, scanId: string, body: unknown): StationStep {
  const report = readStationReport(body, site);
  if ("error" in report) return report;
  const token = stationToken(scanId);
  const material = materialFromStation(site, report);
  const ask = addressesToAsk(site, material, token);
  if (!report.answers) return { ask };
  const answers = stationAnswers(ask, report.answers);
  return { ask, finding: assembleFinding(site, material, answers, token), answered: answers.size, stopped: report.stopped };
}

/** The made-up name of a station's search: the same at every call of one scan, so the list the station is given and the answers it brings match. */
export function stationToken(scanId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < scanId.length; i++) {
    h ^= scanId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
