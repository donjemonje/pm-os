import { ADDRESS_KINDS, isAddressKind, type AddressKind } from "./config";
import { contentHash, decodeEntities } from "./html";
import { isPrivateHost, registrableHost, siteHost } from "./url";

/**
 * A company's OTHER ADDRESSES — the rules (Website Scanning, "Other addresses of a company").
 *
 * A company's help center, developer docs and release notes usually sit on another address than its main site
 * (support.acme.com, developers.acme.com, acme.zendesk.com). The scan stays on the main site, so the best material —
 * what the product really does — was never fetched. PM-OS looks for these addresses itself, in this order, and each
 * candidate remembers how it was found:
 *
 *   1. link   the company's own links: every link on its home page that leaves the site and looks like help /
 *             support / docs / knowledge base / academy / developers / API / changelog / release notes / what's
 *             new — by its text or by its address. This also finds a help center hosted by another company.
 *   2. llms   the site's /llms.txt: every address it lists that leaves the site.
 *   3. guess  common names in front of the company's domain (help.acme.com …), each VERIFIED: some sites answer for
 *             any name, so a guess counts only when a made-up name on the same domain does not give the same answer,
 *             and the page that answers is not the main site again.
 *   4. pick   PMOS AI says, per candidate, what it is — help center, developer docs, release notes — or that it is
 *             not worth scanning. Codes and kinds are closed sets.
 *
 * An address is always a whole site ("https://support.acme.com"): the scanner reads whole sites. So an area of the
 * main site (acme.com/docs) is never a separate address — the website scan reads it — and a page on somebody else's
 * bare domain (intercom.help/acme, github.com/acme) is never one either: that site is not the company's.
 *
 * This file is what can be decided without a database or a network; the search itself is address-search.ts.
 *
 * Pure: no database, no network.
 */

// ————— Which sources are scanned addresses —————

/** A plain site address: http(s), a host, nothing after it ("https://support.acme.com"). */
export function isSiteAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Is this source one of the company's other addresses — scanned whole, shown under the website, rescanned on the
 * website's schedule? Its type is an address kind, its url is a plain site address, and that site is not the
 * company's main site. A source of the same type that a collector fed (an imported document's address, a page deep
 * inside another site) is not one, and neither is an address a PM removed. `mainHost` is the company's host.
 */
export function isScannedAddress(s: { type: string; url: string; removedAt?: Date | string | null }, mainHost: string): boolean {
  if (!isAddressKind(s.type) || s.removedAt || !isSiteAddress(s.url)) return false;
  return siteHost(new URL(s.url)) !== mainHost;
}

/** Does the scanner crawl this source at all? The website, and every other address of the company. */
export function isScannedSource(s: { type: string; url: string; removedAt?: Date | string | null }, mainHost: string): boolean {
  return s.type === "website" || isScannedAddress(s, mainHost);
}

// ————— Candidates —————

export const FOUND_VIA = ["link", "llms", "guess"] as const;
/** How a candidate was found, most reliable first. */
export type FoundVia = (typeof FOUND_VIA)[number];

/** An address that may be worth scanning, before anything was fetched from it. */
export interface RawCandidate {
  /** The site it points into, as a plain address ("https://support.acme.com"). */
  url: string;
  /** siteHost of it ("support.acme.com"). */
  host: string;
  via: FoundVia;
  /** The text of the link that named it ("" for a guess). */
  text: string;
  /** What its text or address looks like — a hint for people and for PMOS AI, never the decision. */
  hint: AddressKind | null;
}

/** A candidate after its address was fetched: it answers, and this is what it shows. */
export interface Candidate extends RawCandidate {
  /** Every way it was found (a help center linked from the home page is often also a verified guess). */
  vias: FoundVia[];
  title: string;
  /** The first lines of the page, cut to OPENING_CHARS. */
  opening: string;
}

/** A candidate's opening lines, as PMOS AI sees them. */
export const OPENING_CHARS = 300;
/** The most candidates one search asks PMOS AI about. A home page that links to more keeps the first ones, by how they were found. */
export const MAX_CANDIDATES = 20;

/**
 * Why an address a link points to is not a candidate, or null when it may be one:
 *   same_site  it is inside the company's main site (the website scan reads it);
 *   private    not a public address;
 *   foreign    it sits on somebody else's bare domain (intercom.help/acme, github.com/acme, youtube.com/…): the
 *              scanner reads whole sites, and that site is not the company's. A host with a name of its own in
 *              front (acme.zendesk.com, acme.readme.io, support.acme.com) is the company's.
 */
export function addressRefusal(target: URL, mainHost: string): "scheme" | "same_site" | "private" | "foreign" | null {
  if (target.protocol !== "https:" && target.protocol !== "http:") return "scheme";
  if (!target.hostname || isPrivateHost(target.hostname)) return "private";
  const host = siteHost(target);
  if (host === mainHost) return "same_site";
  const name = target.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const mainName = mainHost.replace(/:\d+$/, "");
  if (registrableHost(name) === name && registrableHost(mainName) !== name) return "foreign";
  return null;
}

/** The plain site address of a URL: "https://support.acme.com/hc/en-us" → "https://support.acme.com". */
export function siteAddressOf(u: URL): string {
  return `${u.protocol}//${u.hostname.toLowerCase().replace(/\.$/, "")}${u.port ? `:${u.port}` : ""}`;
}

// ————— 1. The company's own links —————

export interface PageLink {
  url: URL;
  /** What the link says: its visible text, else its aria-label, else its title. */
  text: string;
}

/** Every link of a page with what it says, resolved against `base`; links that are not addresses are dropped. */
export function linksWithText(html: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ");
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(raw), base);
    } catch {
      continue;
    }
    const attr = (name: string) => {
      const a = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
      return a ? decodeEntities(a[1] ?? a[2] ?? "") : "";
    };
    const visible = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ url, text: (visible || attr("aria-label") || attr("title")).replace(/\s+/g, " ").trim().slice(0, 120) });
  }
  return out;
}

/**
 * The words that make a link look like one of the kinds — data: adding a word is an edit of these tables.
 * A link's TEXT is matched as people write it in a menu or a footer; its ADDRESS by the names in front of the
 * domain and the folders of the path.
 */
export const TEXT_WORDS: ReadonlyArray<[AddressKind, RegExp]> = [
  ["changelog", /\b(changelog|change log|release notes?|releases|what'?s new|product updates)\b/],
  ["apidocs", /\b(developers?|developer (docs|documentation|portal|hub)|api|apis|api (docs|documentation|reference)|sdks?)\b/],
  ["helpcenter", /\b(help|help ?cent(er|re)|help ?desk|support|knowledge ?base|faqs?|academy|university|docs|documentation|user guides?|guides|tutorials|manuals?)\b/],
];
export const ADDRESS_WORDS: ReadonlyArray<[AddressKind, RegExp]> = [
  ["changelog", /\b(changelog|changelogs|change log|release notes?|releases|whats new|updates)\b/],
  ["apidocs", /\b(developers?|dev|api|apis|sdk|reference)\b/],
  ["helpcenter", /\b(help|helpcenter|help cent(er|re)|helpdesk|support|kb|knowledge|knowledgebase|knowledge base|faqs?|academy|university|learn|docs|documentation|guides?|tutorials|manuals?|hc)\b/],
];

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();

/** What a link's text looks like, or null. */
export function textLooksLike(text: string): AddressKind | null {
  const t = words(text);
  if (!t) return null;
  for (const [kind, re] of TEXT_WORDS) if (re.test(t)) return kind;
  return null;
}

/**
 * What an address looks like, or null: the names in front of its own domain ("support" in support.acme.com, "acme"
 * and "docs" in acme-docs.readme.io — never the domain itself, so helpscout.com is not "help") and its path.
 */
export function addressLooksLike(u: URL): AddressKind | null {
  const name = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const own = registrableHost(name);
  const front = name === own ? "" : name.slice(0, name.length - own.length - 1);
  const t = words(`${front} ${u.pathname.replace(/'/g, "")}`);
  if (!t) return null;
  for (const [kind, re] of ADDRESS_WORDS) if (re.test(t)) return kind;
  return null;
}

/**
 * 1. The links of the company's home page that are candidates: they leave the main site, sit on a host of the
 * company's own (addressRefusal) and look like one of the kinds — by text or by address. One candidate per site,
 * the first link to it wins; what it looks like comes from its text first, then from its address.
 */
export function linkCandidates(links: PageLink[], mainHost: string): RawCandidate[] {
  const out = new Map<string, RawCandidate>();
  for (const l of links) {
    if (addressRefusal(l.url, mainHost)) continue;
    const hint = textLooksLike(l.text) ?? addressLooksLike(l.url);
    if (!hint) continue;
    const host = siteHost(l.url);
    if (!out.has(host)) out.set(host, { url: siteAddressOf(l.url), host, via: "link", text: l.text, hint });
  }
  return [...out.values()];
}

// ————— 2. llms.txt —————

/** Is this the body of an llms.txt — text, not the HTML page a site serves for any unknown address? */
export function looksLikeLlmsTxt(body: string): boolean {
  const t = body.trim();
  return t.length > 0 && !/^(<!doctype|<html|<head|<body|<\?xml)/i.test(t) && !/<\/(html|body|head)>/i.test(t.slice(-2000));
}

/** Every address an llms.txt lists: Markdown links with their text, then bare addresses. */
export function llmsTxtLinks(text: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const add = (raw: string, label: string) => {
    try {
      const url = new URL(raw.trim(), base);
      if (seen.has(url.href)) return;
      seen.add(url.href);
      out.push({ url, text: label.replace(/\s+/g, " ").trim().slice(0, 120) });
    } catch {
      // not an address
    }
  };
  for (const m of text.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) add(m[2], m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/g)) add(m[0].replace(/[.,;:!?]+$/, ""), "");
  return out;
}

/**
 * 2. The addresses an llms.txt lists that are candidates: they leave the main site and sit on a host of the
 * company's own. No word is needed — the site itself listed them. One candidate per site, the first listing wins.
 */
export function llmsCandidates(links: PageLink[], mainHost: string): RawCandidate[] {
  const out = new Map<string, RawCandidate>();
  for (const l of links) {
    if (addressRefusal(l.url, mainHost)) continue;
    const host = siteHost(l.url);
    if (!out.has(host)) out.set(host, { url: siteAddressOf(l.url), host, via: "llms", text: l.text, hint: textLooksLike(l.text) ?? addressLooksLike(l.url) });
  }
  return [...out.values()];
}

// ————— 3. Guessing common names, and verifying —————

/** The names tried in front of the company's domain. */
export const GUESS_NAMES = ["help", "support", "docs", "developers", "developer", "helpcenter", "kb", "knowledge", "academy", "changelog", "api"] as const;

/** What each guessed name looks like (the hint of a guess). */
const GUESS_HINT: Record<(typeof GUESS_NAMES)[number], AddressKind> = {
  help: "helpcenter", support: "helpcenter", docs: "helpcenter", developers: "apidocs", developer: "apidocs", helpcenter: "helpcenter",
  kb: "helpcenter", knowledge: "helpcenter", academy: "helpcenter", changelog: "changelog", api: "apidocs",
};

/** The company's domain a guess goes in front of: the registrable part of its main host ("www.acme.co.uk" → "acme.co.uk"). */
export function guessDomain(mainHost: string): string {
  return registrableHost(mainHost.replace(/:\d+$/, ""));
}

/** 3a. The guesses for a company: "https://<name>.<domain>" for every name, never the main site itself. */
export function guessCandidates(mainHost: string): RawCandidate[] {
  const domain = guessDomain(mainHost);
  // An IP address or a single-label host has no names in front of it.
  if (!domain.includes(".") || /^[\d.]+$/.test(domain)) return [];
  const out: RawCandidate[] = [];
  for (const name of GUESS_NAMES) {
    const host = `${name}.${domain}`;
    if (host === mainHost) continue;
    out.push({ url: `https://${host}`, host, via: "guess", text: "", hint: GUESS_HINT[name] });
  }
  return out;
}

/** The made-up name asked next to the guesses: a name no site has ("pmos-check-3f9a1c2e.acme.com"). `token` is random per search. */
export function controlAddress(mainHost: string, token: string): string {
  return `https://pmos-check-${token.toLowerCase().replace(/[^a-z0-9]/g, "")}.${guessDomain(mainHost)}`;
}

/** What one address answered when it was asked. */
export interface Answer {
  /** The address asked. */
  url: string;
  /** HTTP status; 0 = no answer at all (the name does not exist, no connection, a timeout). */
  status: number;
  /** Set when the answer is not a readable page (the fetcher's error kind: botwall, notfound, timeout …). */
  error: string | null;
  /** Where the answer came from after redirects. */
  finalUrl: string;
  title: string;
  /** The page's text. */
  text: string;
}

/** A page answered: HTTP 2xx, readable, with at least this much text. */
export const MIN_ANSWER_CHARS = 50;
export function answeredPage(a: Answer): boolean {
  return a.status >= 200 && a.status < 300 && !a.error && a.text.trim().length >= MIN_ANSWER_CHARS;
}

/** The host an address was asked under ("support.acme.com"), lower case. */
function askedHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * What an answer is, with the host it was asked under taken out — so two names that get the same page compare
 * equal even when the page repeats the host it was asked under: where it landed (host and path), its title, the
 * fingerprint of its text.
 */
export function answerSignature(a: Answer): { landed: string; title: string; hash: string } {
  const host = askedHost(a.url);
  const strip = (s: string) => (host ? s.toLowerCase().split(host).join("{host}") : s.toLowerCase());
  let landed = a.finalUrl;
  try {
    const u = new URL(a.finalUrl);
    landed = `${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    // keep as given
  }
  return { landed: strip(landed), title: strip(a.title.trim()), hash: contentHash(strip(a.text)) };
}

/**
 * Did two names get the same answer? Yes when both were sent to the same place somewhere else (a redirect to the
 * main site's "not found" page, to a login), or when both show the same title and the same text. Two names that
 * each stay on their own host are compared by what they show only.
 */
export function sameAnswer(a: ReturnType<typeof answerSignature>, b: ReturnType<typeof answerSignature>): boolean {
  if (a.title === b.title && a.hash === b.hash) return true;
  return a.landed === b.landed && !a.landed.startsWith("{host}");
}

export type GuessVerdict =
  | { counts: true; /** The site that answers — the guess itself, or where it redirects to. */ url: string; host: string }
  | { counts: false; why: "no_answer" | "main_site" | "foreign" | "same_as_any_name" };

/**
 * 3b. Does a guess count? Only when ALL of this holds:
 *   - it answers with a readable page (answeredPage) — a name that does not exist, an error page, a login wall or
 *     bot protection is no proof of anything;
 *   - the page is not the main site again: it did not land on the main site (a redirect back), and its text is not
 *     the home page's text;
 *   - where it landed is a host of the company's own (addressRefusal), not somebody else's bare domain;
 *   - a made-up name on the same domain does NOT give the same answer: some sites answer for any name (aha.io,
 *     zendesk.com, productboard.com do). When the made-up name answers with a page too and it is the same answer
 *     (sameAnswer), the guess proves nothing.
 * `control` is the made-up name's answer; `home` the main site's home page.
 */
export function guessVerdict(guess: Answer, control: Answer, main: { host: string; home: Answer | null }): GuessVerdict {
  if (!answeredPage(guess)) return { counts: false, why: "no_answer" };
  let landed: URL;
  try {
    landed = new URL(guess.finalUrl);
  } catch {
    return { counts: false, why: "no_answer" };
  }
  const refusal = addressRefusal(landed, main.host);
  if (refusal === "same_site") return { counts: false, why: "main_site" };
  if (refusal) return { counts: false, why: refusal === "foreign" ? "foreign" : "no_answer" };
  const g = answerSignature(guess);
  if (main.home && answeredPage(main.home) && contentHash(main.home.text.toLowerCase()) === contentHash(guess.text.toLowerCase())) return { counts: false, why: "main_site" };
  if (answeredPage(control)) {
    const c = answerSignature(control);
    if (sameAnswer(g, c)) return { counts: false, why: "same_as_any_name" };
  }
  return { counts: true, url: siteAddressOf(landed), host: siteHost(landed) };
}

// ————— De-duplication, and what is already there —————

const VIA_RANK: Record<FoundVia, number> = { link: 0, llms: 1, guess: 2 };

/**
 * Several findings as one list: one candidate per site, in the order they were found — links first, then llms.txt,
 * then guesses. A site found more than one way keeps the most reliable finding (its text, its hint) and remembers
 * every way. At most `limit` candidates; `dropped` says how many were left out.
 */
export function mergeCandidates(found: Array<RawCandidate & { title: string; opening: string }>, limit = MAX_CANDIDATES): { candidates: Candidate[]; dropped: number } {
  const bySite = new Map<string, Candidate>();
  const ordered = found.map((f, i) => ({ f, i })).sort((a, b) => VIA_RANK[a.f.via] - VIA_RANK[b.f.via] || a.i - b.i);
  for (const { f } of ordered) {
    const known = bySite.get(f.host);
    if (known) {
      if (!known.vias.includes(f.via)) known.vias.push(f.via);
      known.hint ??= f.hint;
      continue;
    }
    bySite.set(f.host, { ...f, vias: [f.via] });
  }
  const all = [...bySite.values()];
  return { candidates: all.slice(0, limit), dropped: Math.max(0, all.length - limit) };
}

/** A source the company already has, as the search sees it. */
export interface KnownAddress {
  /** siteHost of its address. */
  host: string;
  /** A PM removed it. */
  removed: boolean;
}

/**
 * The addresses a company already has, as a search sees them: its other addresses that are scanned (whatever
 * their kind, however they were added — found, typed in by a PM, or put there before this was recorded), and the
 * ones a PM removed. A source a collector fed is not an address: an imported document or a page deep inside a site
 * (support.acme.com/hc/article-12) does not stand in the way of scanning that site.
 */
export function knownAddresses(sources: Array<{ type: string; url: string; removedAt?: Date | string | null }>, mainHost: string): KnownAddress[] {
  const out: KnownAddress[] = [];
  for (const s of sources) {
    if (!isScannedAddress({ ...s, removedAt: null }, mainHost)) continue;
    out.push({ host: siteHost(new URL(s.url)), removed: s.removedAt != null });
  }
  return out;
}

/**
 * What of a list is new to the company. A candidate whose site the company already has as an address — whatever
 * its kind, however it was added — is already there and is not added again. A candidate whose site a PM removed is
 * never added back: a PM's decision stands until a PM adds the address again by hand.
 */
export function screenCandidates<T extends { host: string }>(candidates: T[], known: KnownAddress[]): { fresh: T[]; alreadyThere: T[]; removedByPm: T[] } {
  const fresh: T[] = [];
  const alreadyThere: T[] = [];
  const removedByPm: T[] = [];
  for (const c of candidates) {
    const hits = known.filter((k) => k.host === c.host);
    if (hits.some((k) => !k.removed)) alreadyThere.push(c);
    else if (hits.length) removedByPm.push(c);
    else fresh.push(c);
  }
  return { fresh, alreadyThere, removedByPm };
}

// ————— 4. PMOS AI picks —————

/** Bumping it changes nothing that is stored: a picked address is a source, and a source is a decision. */
export const ADDRESS_PICK_VERSION = "addresses-1";
export const ADDRESS_PICK_MAX_TOKENS = 2000;
/** "Not worth scanning" in the closed set of kinds. */
export const SKIP_KIND = "skip";
export type PickKind = AddressKind | typeof SKIP_KIND;

export const ADDRESS_PICK_SYSTEM_PROMPT = `A product team studies one company to learn what its product does. Besides the company's main website, these other addresses were found: links on its home page, addresses its llms.txt lists, and common names in front of its domain. For each address you get its code, the address, how it was found, the text of the link that named it, the title of the page that answers there and its first lines.

Say what each address is:
- helpcenter: the company's help center — user guides, how-to articles, knowledge base, product documentation for users, support articles, training and academy lessons about the product.
- apidocs: the company's developer documentation — API reference, developer guides, SDK documentation.
- changelog: the company's release notes — changelog, what is new in the product, product updates.
- skip: not worth scanning — a status page, a trust or security center, a login or sign-up page, the product's own app, a community forum or ideas board, a blog or newsroom, a marketing or landing page, a careers page, a shop, a page that belongs to another company, a page with no content.

Rules:
- Answer once for every code you were given. Use only the codes and the four kinds given.
- Decide from the page's title and first lines first, then from the address and the link text.
- A page that describes how to use the product is helpcenter even when its address says "docs".
- When you cannot tell whether an address holds documentation of the product, answer skip.`;

/** The tool of the pick call: the candidate codes and the kinds are closed sets. */
export function addressPickTool(codes: string[]): Record<string, unknown> {
  return {
    name: "pick_addresses",
    description: "Record what every address is.",
    input_schema: {
      type: "object" as const,
      properties: {
        addresses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "An address code, e.g. A3.", enum: codes },
              kind: { type: "string", enum: [...ADDRESS_KINDS, SKIP_KIND] },
            },
            required: ["code", "kind"],
          },
        },
      },
      required: ["addresses"],
    },
  };
}

export interface PickEntry {
  /** "A1" … in the order of the call. */
  code: string;
  candidate: Candidate;
}

export function pickEntries(candidates: Candidate[]): PickEntry[] {
  return candidates.map((candidate, n) => ({ code: `A${n + 1}`, candidate }));
}

const VIA_WORDS: Record<FoundVia, string> = { link: "a link on the home page", llms: "listed in llms.txt", guess: "a common name in front of the domain" };
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export function renderAddressPick(company: { name: string; site: string }, entries: PickEntry[]): string {
  const lines = entries.map((e) => {
    const c = e.candidate;
    return `${e.code} | ${c.url} | found: ${c.vias.map((v) => VIA_WORDS[v]).join(" and ")} | link text: ${c.text ? `"${oneLine(c.text, 80)}"` : "none"} | title: ${c.title ? `"${oneLine(c.title, 120)}"` : "none"} | first lines: ${c.opening ? `"${oneLine(c.opening, OPENING_CHARS)}"` : "none"}`;
  });
  return `COMPANY: ${company.name}\nMAIN WEBSITE: ${company.site}\n\nADDRESSES:\n${lines.join("\n")}`;
}

/**
 * The answer of the pick call, by candidate code. Codes and kinds are closed sets: a code that was not asked or a
 * kind outside the list makes the whole answer unusable (`problems` is not empty) — nothing of it is used, the
 * search records "could not decide" and adds nothing. A code answered twice keeps its first kind; a code the answer
 * leaves out is undecided: it is not added, and the next search asks about it again.
 */
export function parseAddressPick(value: unknown, codes: string[]): { picks: Map<string, PickKind>; undecided: string[]; problems: string[] } {
  const asked = new Set(codes);
  const picks = new Map<string, PickKind>();
  const problems: string[] = [];
  const rows = (value as Record<string, unknown> | null)?.addresses;
  if (!Array.isArray(rows)) return { picks, undecided: [...codes], problems: ["the answer has no list of addresses"] };
  for (const row of rows) {
    const o = (row ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code.trim() : "";
    const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
    if (!asked.has(code)) {
      problems.push(`a code that was not asked (${code || "none"})`);
      continue;
    }
    if (!(isAddressKind(kind) || kind === SKIP_KIND)) {
      problems.push(`a kind outside the list (${kind || "none"}) for ${code}`);
      continue;
    }
    if (!picks.has(code)) picks.set(code, kind);
  }
  return { picks, undecided: codes.filter((c) => !picks.has(c)), problems };
}

/**
 * TEST KNOB: the JSON text PMOS AI would have answered for a pick call, built from a test's kinds by address host
 * (settings.ts TestAiAnswers.addresses): "support.acme.example" → "helpcenter", "*" for every other candidate; a
 * candidate no entry names is "skip". The words go through the same parser as a real answer.
 */
export function injectedAddressPick(kinds: Record<string, string> | undefined, entries: PickEntry[]): string {
  return JSON.stringify({ addresses: entries.map((e) => ({ code: e.code, kind: kinds?.[e.candidate.host] ?? kinds?.["*"] ?? SKIP_KIND })) });
}

// ————— What a search leaves behind —————

/** What the last search of a company that finished says (Competitor.addressSearch). */
export interface AddressSearchResult {
  /** "done" = it ran to the end; "undecided" = PMOS AI could not say what the candidates are, nothing was added. */
  status: "done" | "undecided";
  /** When it finished (ISO). */
  at: string;
  /** "added" = the company was just added; "scan" = a scan of its website ended. */
  trigger: string;
  /** Addresses that answered and were new to the company. */
  candidates: number;
  /** Of those, the ones that became sources. */
  added: number;
  /** Why nothing was decided, for Administration; "" otherwise. */
  note: string;
}

/** The stored result (a Json column), checked field by field; null for anything that is not one. */
export function readAddressSearch(raw: unknown): AddressSearchResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if ((r.status !== "done" && r.status !== "undecided") || typeof r.at !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { status: r.status, at: r.at, trigger: typeof r.trigger === "string" ? r.trigger : "", candidates: num(r.candidates), added: num(r.added), note: typeof r.note === "string" ? r.note : "" };
}

/** A search that started this long ago and never finished is no longer running (its process stopped): the next one takes over. */
export const SEARCH_STALE_MS = 10 * 60_000;

export function searchRunning(startedAt: Date | string | null | undefined, now: number = Date.now()): boolean {
  if (!startedAt) return false;
  const t = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt.getTime();
  return Number.isFinite(t) && now - t < SEARCH_STALE_MS;
}
