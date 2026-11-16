import { arr, str } from "../ai";
import { checkPii } from "../pii";
import type { IncidentDraft, RequestPage } from "./reading";
import { WHERE_A_PM_LOOKS } from "./reading";
import { quoteChecker } from "./quotes";
import { isSectionLabel, MAP_OPENING_CHARS, prefixPath, SECTION_LABELS, type Section, type SectionLabel } from "./sections";

/**
 * Three prompts of the capability analysis (Capability Analysis, "How the analysis runs"): the map, the match and
 * the second look. The others live next to their rules: the reading in analysis/reading.ts, unify in
 * analysis/unify.ts, domains in analysis/domains.ts. Administration → Competitors lists every prompt.
 *
 * Each prompt has a version, the system text, the tool (the JSON schema the answer is held to), a render function
 * for the user content and a parse function that validates the answer field by field and returns typed, cleaned
 * data. A parser never throws on a bad field: it drops it and counts it.
 *
 * PMOS AI never decides a cell. The map labels the sections of the site that code built (closed codes, closed
 * labels), skimming a few sample pages of each. The match answers with OUR codes (a closed set), never free names.
 * The second look answers, for the rows of ours a company has no item for, which of them a chunk of its pages
 * shows — by row code, with a quote that is checked in code. The cells are filled by fixed rules (cells.ts).
 *
 * Pure: no database, no network.
 */

/**
 * Bumping MAP_VERSION invalidates nothing: a saved section label is a decision. It is stored with every label it gave.
 * map-2 (2026-11-15): the map skims the sample pages — each carries its first lines, not only its title and address.
 */
export const MAP_VERSION = "map-2";

/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
export const MAX_ENUM = 120;
/**
 * "No value" in a closed set. An enum may not hold an empty string — Gemini refuses the whole request (HTTP 400,
 * "enum[0]: cannot be empty"; first real run, 2026-11-11) — so a field that may stay without a value offers this
 * word instead. The parsers read it, like an empty string, as nothing.
 */
export const NO_VALUE = "none";

// ————— 0. Map: the sections of the site —————

export const MAP_SYSTEM_PROMPT = `A product team studies one company to learn what its product does. Below are the sections of the company's website: for each section its code, its address prefix and how many pages it holds, then a few sample pages of it — each with its address, its title and the first lines of its own text. Label every section with exactly one label.

Labels:
- product: pages that describe what the company sells and what it does — products, platform, features, solutions, use cases, integrations, security of the product. Products are often named by brand, not by the word "product": a section named after a product is a product section.
- pricing: prices, plans and editions.
- compare: pages where the company compares itself with another company.
- help: the help center — user guides, how-to articles, knowledge base, support articles, FAQ.
- release_notes: release notes, changelog, what is new in the product.
- api_docs: developer documentation and API reference.
- news: blog, news, press releases, announcements.
- noise: everything that says nothing about what the product does — customers and case studies, landing pages, events, webinars, the company and its people, careers, legal, press kits, prompt libraries, glossaries, general articles about the industry.

Rules:
- Answer once for every section code you were given. Use only the codes and the labels given.
- Skim the sample pages: decide from their first lines first — a title or an address often does not say what a page is — then from the titles and the addresses. When a section mixes kinds, give the label of most of its pages.
- When you cannot tell whether a section is product or noise, answer product.
- LLMS.TXT, when given, is the site's own description of its content: use it.`;

export const MAP_MAX_TOKENS = 4000;
/** Sections per map call; a longer list is asked in consecutive calls. At most MAX_ENUM, so the codes always ride in the schema as a closed set. */
export const MAP_MAX_SECTIONS = 120;
/** The site's /llms.txt is cut to this many characters. */
export const LLMS_TXT_MAX_CHARS = 20_000;

/** The tool of one map call: the section codes and the labels are closed sets. */
export function mapTool(codes: string[]): Record<string, unknown> {
  return {
    name: "label_sections",
    description: "Record the label of every section.",
    input_schema: {
      type: "object" as const,
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "A section code, e.g. S7.", ...(codes.length <= MAX_ENUM ? { enum: codes } : {}) },
              label: { type: "string", enum: [...SECTION_LABELS] },
            },
            required: ["code", "label"],
          },
        },
      },
      required: ["sections"],
    },
  };
}

/** A sample page as the map sees it: its address, its title, and the first lines of its own text (sections.ts sampleOpenings). */
export interface MapSample {
  url: string;
  title: string;
  opening: string;
}

export interface MapEntry {
  /** "S1" … in the order of the call. */
  code: string;
  section: Pick<Section, "prefix" | "pages"> & { samples: MapSample[]; /** Source type label when the pages are not the website's ("Help center"). */ sourceLabel?: string | null };
}

/** "/products/core" — an address as a sample: the path, without the host the prefix already shows. */
function samplePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return url;
  }
}

export function renderMap(company: { name: string; site: string }, entries: MapEntry[], llmsTxt: string | null): string {
  const lines = entries.map((e) => {
    const s = e.section;
    const samples = s.samples.map((p) => `  - ${samplePath(p.url)} | title: ${p.title ? `"${short(p.title, 80)}"` : "none"} | first lines: ${p.opening ? `"${short(p.opening, MAP_OPENING_CHARS)}"` : "none"}`);
    return [`${e.code} | ${s.prefix} | ${s.pages} page${s.pages === 1 ? "" : "s"}${s.sourceLabel ? ` | source: ${s.sourceLabel}` : ""}`, ...samples].join("\n");
  });
  const llms = llmsTxt?.trim() ? `\n\nLLMS.TXT:\n${llmsTxt.trim().slice(0, LLMS_TXT_MAX_CHARS)}` : "";
  return `COMPANY: ${company.name}\nSITE: ${company.site}${llms}\n\nSECTIONS:\n${lines.join("\n")}`;
}

/**
 * The labels of one map answer, by section code. A code that was not asked and a label outside the closed set are
 * reported, never guessed: the step treats either as an unusable answer and fails the run. A code answered twice
 * keeps its first label; a code the answer leaves out is simply not in the result (the step asks it again).
 */
export function parseMap(value: unknown, codes: string[]): { labels: Map<string, SectionLabel>; unknownCodes: string[]; unknownLabels: string[] } {
  const asked = new Set(codes);
  const labels = new Map<string, SectionLabel>();
  const unknownCodes: string[] = [];
  const unknownLabels: string[] = [];
  for (const row of arr((value as Record<string, unknown> | null)?.sections)) {
    const o = (row ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim().toLowerCase() : "";
    if (!asked.has(code)) {
      unknownCodes.push(code || "(none)");
      continue;
    }
    if (!isSectionLabel(label)) {
      unknownLabels.push(label || "(none)");
      continue;
    }
    if (!labels.has(code)) labels.set(code, label);
  }
  return { labels, unknownCodes, unknownLabels };
}

/**
 * TEST KNOB: the JSON text PMOS AI would have answered for a map call, built from a test's labels by section
 * address (settings.ts TestAiAnswers.map): the full prefix ("acme.example/blog") or its path ("/blog"), "*" for
 * every other section; a section no entry names is "product".
 */
export function injectedMapAnswer(labels: Record<string, string> | undefined, entries: MapEntry[]): string {
  return JSON.stringify({
    sections: entries.map((e) => ({ code: e.code, label: labels?.[e.section.prefix] ?? labels?.[prefixPath(e.section.prefix)] ?? labels?.["*"] ?? "product" })),
  });
}

// ————— Map, page by page: the release-notes pages inside a help center or a blog —————

/**
 * Release notes win over where they sit (Daniel 2026-11-16): a company may keep its release notes as an article of
 * its help center, or publish its changelog as blog posts. A section label is not enough there, so for the
 * sections labeled help or news the map also looks at the pages one by one — address and title only, never the
 * text — and names the release-notes pages by code (a closed set). Asked once per page: the answer is kept on the
 * page (SourcePage.readAs).
 */
export const MAP_PAGES_VERSION = "map-pages-1";

export const MAP_PAGES_SYSTEM_PROMPT = `A product team studies one company to learn what its product does. Below are pages of the company's help center or of its blog — each with a code, the kind of place it sits in, its address and its title. Some companies publish their RELEASE NOTES there: a changelog article, "what's new" or "product updates" posts, a page per release. Name those pages.

A release-notes page says what was shipped in the product: new features, improvements and fixes, by release or by date. A how-to article, a guide, a FAQ, an opinion or marketing post, a customer story, an event or a company announcement is NOT one — also when it mentions a new feature.

Answer with the codes of the release-notes pages. Use only the codes given. Most help centers and blogs have none: an empty list is a correct answer. Do not guess from a code or from the order of the pages: decide from the address and the title.`;

/** Pages per call of the page pick. A line is a code, an address and a title: about 40 tokens. */
export const MAP_PAGES_BATCH = 400;
export const MAP_PAGES_MAX_TOKENS = 8_000;

export function mapPagesTool(codes: string[]): Record<string, unknown> {
  return {
    name: "name_release_notes",
    description: "Record the codes of the pages that are release notes.",
    input_schema: {
      type: "object" as const,
      properties: { release_notes: { type: "array", items: { type: "string", description: "A page code, e.g. P7.", ...(codes.length <= MAX_ENUM ? { enum: codes } : {}) } } },
      required: ["release_notes"],
    },
  };
}

export interface MapPageEntry {
  /** "P1" … in the order of the call. */
  code: string;
  url: string;
  title: string;
  /** The label of the section it sits in: "help" | "news". */
  label: string;
}

/** "support.acme.com/hc/articles/360-release-notes" — an address without its scheme. */
function addressOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}

export function renderMapPages(company: string, entries: MapPageEntry[]): string {
  const lines = entries.map((e) => `${e.code} | ${e.label === "news" ? "blog" : "help center"} | ${addressOf(e.url)} | ${e.title ? `"${short(e.title, 120)}"` : "no title"}`);
  return `COMPANY: ${company.replace(/\s+/g, " ").trim()}\n\nPAGES:\n${lines.join("\n")}`;
}

/**
 * The release-notes pages of one answer, as codes. A code that was not asked is reported, never guessed: the step
 * treats it as an unusable answer and fails the run. A code named twice counts once. Every page of the call the
 * answer does not name is NOT a release-notes page — that is an answer too, and it is kept.
 */
export function parseMapPages(value: unknown, codes: string[]): { releaseNotes: Set<string>; unknownCodes: string[] } {
  const asked = new Set(codes);
  const releaseNotes = new Set<string>();
  const unknownCodes: string[] = [];
  for (const c of arr((value as Record<string, unknown> | null)?.release_notes)) {
    const code = typeof c === "string" ? c.trim() : "";
    if (asked.has(code)) releaseNotes.add(code);
    else unknownCodes.push(code || "(none)");
  }
  return { releaseNotes, unknownCodes };
}

/**
 * TEST KNOB: the JSON text PMOS AI would have answered for a page-pick call, built from a test's list of
 * release-notes pages (settings.ts TestAiAnswers.releaseNotes): full addresses, or paths ("/blog/changelog-may").
 */
export function injectedMapPagesAnswer(releaseNotes: string[] | undefined, entries: MapPageEntry[]): string {
  const named = new Set(releaseNotes ?? []);
  const path = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };
  return JSON.stringify({ release_notes: entries.filter((e) => named.has(e.url) || named.has(path(e.url))).map((e) => e.code) });
}

const piiIn = (...texts: string[]) => texts.some((t) => checkPii(t).hit);
/** A text that names a person is emptied. */
const clean = (text: string): string => (checkPii(text).hit ? "" : text);
const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ").replace(/"/g, "'");

// ————— Match: a company's new items against the rows that exist —————

/** Bumping MATCH_VERSION invalidates nothing: a saved match is a decision. match-3 (2026-11-16): an entry that is none of ours goes into an EXISTING domain — no new domain is proposed. */
export const MATCH_VERSION = "match-3";

export const MATCH_SYSTEM_PROMPT = `You match one company's list of capabilities and features to the rows of a product team's comparison table.

OUR TABLE is grouped by domain. Each domain has the team's definition: read the definitions first, they say what belongs in each domain. Every domain, capability and feature of ours has a code. THEIR LIST has codes too; each entry comes with what it does, in the company's own words.

For each entry of THEIR LIST answer:
- ours: the code of the capability or feature of ours that is the same thing, or "none". Match by what it is, not by its name. A capability of theirs can be a feature of ours, and a feature of theirs can be a capability of ours. Give a code only when you are confident it is the same thing; otherwise answer "none".

An entry with ours = "none" becomes a new row of the table. For it give:
- marketName: the name the market uses for it. Vendor-neutral: never a product, brand or marketing name.
- description: one plain sentence saying what it does.
- If it is a capability: domain = the code of the domain of ours it belongs in. Always one of ours — no new domain is made here.
- If it is a feature: answer "none" for domain. It follows its capability.

For an entry with ours = a code, answer "none" for domain and leave marketName and description empty.`;

export const MATCH_MAX_TOKENS = 12000;
/** Entries of their list per match call. */
export const MATCH_BATCH = 100;

/** What the parser needs of our catalog (built by match.ts buildCatalog). */
export interface MatchCatalog {
  /** K- and F-codes → our row. */
  ours: Map<string, { kind: "capability" | "feature"; id: string }>;
  /** D-codes → our domain. */
  domains: Map<string, { id: string; state: string }>;
}

export interface MatchBatchEntry {
  /** "T1" … in the order of the batch. */
  code: string;
  kind: "capability" | "feature";
}

/** The tool of one batch: `entry` is always a closed set; our codes ride as an enum only while the set is small. */
export function matchTool(entryCodes: string[], catalog: MatchCatalog): Record<string, unknown> {
  const ours = ["none", ...catalog.ours.keys()];
  const domains = [NO_VALUE, ...catalog.domains.keys()];
  const closed = (values: string[]) => (values.length <= MAX_ENUM ? { enum: values } : {});
  return {
    name: "match_entries",
    description: "Record, for each entry of their list, which of ours it is, or where it belongs.",
    input_schema: {
      type: "object" as const,
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entry: { type: "string", enum: entryCodes },
              ours: { type: "string", description: 'A K- or F-code of ours, or "none".', ...closed(ours) },
              domain: { type: "string", description: 'A D-code of ours for a capability that is none of ours; "none" for a feature, or for an entry that is one of ours.', ...closed(domains) },
              marketName: { type: "string" },
              description: { type: "string" },
            },
            required: ["entry", "ours", "domain", "marketName", "description"],
          },
        },
      },
      required: ["matches"],
    },
  };
}

export interface MatchTheirEntry extends MatchBatchEntry {
  /** For a feature: the T-code of its capability when that is in the same batch, else that capability's name. */
  parent: { code: string } | { name: string } | null;
  name: string;
  /** What it does, in the company's own words; "" when its list does not say. */
  description: string;
  quote: string;
}

export function renderMatchTail(company: string, entries: MatchTheirEntry[]): string {
  const what = (e: MatchTheirEntry) => `${e.name}${e.description ? ` — ${short(e.description, 240)}` : ""}${e.quote ? ` | "${short(e.quote, 120)}"` : ""}`;
  const lines = entries.map((e) => {
    if (e.kind === "capability") return `${e.code} | capability | ${what(e)}`;
    const under = e.parent ? ("code" in e.parent ? e.parent.code : `"${e.parent.name}"`) : "a capability not listed";
    return `  ${e.code} | feature of ${under} | ${what(e)}`;
  });
  return `COMPANY: ${company}\n\nTHEIR LIST:\n${lines.join("\n")}`;
}

/** The match call's answer for an item that is none of ours — what the apply step turns into a row. */
export interface Placement {
  /** For a capability: the domain of ours it belongs in. Null for a feature (it follows its capability). */
  domainId: string | null;
  marketName: string;
  description: string;
}

export type MatchAnswer =
  | { entry: string; ours: { kind: "capability" | "feature"; id: string }; placement: null }
  | { entry: string; ours: null; placement: Placement };

/**
 * The answers of one batch. An entry outside the batch is dropped; a duplicate entry keeps the first; an `ours`
 * that is neither a code of ours nor "none" counts as "none" (and is reported). A capability that is none of ours
 * must name a domain of ours: with any other answer the entry is NOT answered — it is in `noDomain` and the step
 * asks it again (no domain is guessed for it).
 */
export function parseMatch(value: unknown, batch: MatchBatchEntry[], catalog: MatchCatalog): { answers: MatchAnswer[]; unknownOurs: string[]; noDomain: string[] } {
  const kinds = new Map(batch.map((b) => [b.code, b.kind]));
  const seen = new Set<string>();
  const answers: MatchAnswer[] = [];
  const unknownOurs: string[] = [];
  const noDomain: string[] = [];
  for (const m of arr((value as Record<string, unknown> | null)?.matches)) {
    const o = (m ?? {}) as Record<string, unknown>;
    const entry = typeof o.entry === "string" ? o.entry.trim() : "";
    const kind = kinds.get(entry);
    if (!kind || seen.has(entry)) continue;
    seen.add(entry);
    const oursCode = typeof o.ours === "string" ? o.ours.trim() : "";
    const ours = catalog.ours.get(oursCode);
    if (ours) {
      answers.push({ entry, ours, placement: null });
      continue;
    }
    if (oursCode && oursCode.toLowerCase() !== "none") unknownOurs.push(oursCode);
    const placement: Placement = { domainId: null, marketName: clean(str(o.marketName, 80)), description: clean(str(o.description, 300)) };
    if (kind === "capability") {
      const domain = catalog.domains.get(typeof o.domain === "string" ? o.domain.trim() : "");
      if (!domain) {
        noDomain.push(entry);
        continue;
      }
      placement.domainId = domain.id;
    }
    answers.push({ entry, ours: null, placement });
  }
  return { answers, unknownOurs, noDomain };
}

// ————— Second look, in bulk: the rows of ours a company has no item for —————

/** look-3 (2026-11-16): one request per chunk of the company's pages for ALL the rows that are due, instead of one request per capability. */
export const LOOK_VERSION = "look-3";

export const LOOK_SYSTEM_PROMPT = `A product team compares its own product with another company's. You get capabilities of the team's own product that the reading of the other company did not find — each with a code, its name and what it is — and then pages of that company's own material. Each page has a code, its address, its kind, its title and its text.

Say which of these capabilities the pages show the company offers.
- For each one the pages show: its code; one exact passage that shows it, copied character for character from ONE page — one continuous passage of at most 300 characters, nothing added, no ellipsis; the code of the page the quote is on; and the name the company itself uses for it.
- Leave out every capability the pages do not show. An empty list is a correct answer.
A related or broader offering is not the capability. Do not guess. Use only the capability codes given, each at most once.
A block marked SITE FRAME holds the lines a site repeats on most of its pages, shown once. It is not a page: take no quote from it.

${WHERE_A_PM_LOOKS}`;

export const LOOK_MAX_TOKENS = 16_000;

export function lookTool(rowCodes: string[]): Record<string, unknown> {
  return {
    name: "second_look",
    description: "Record which of the capabilities the pages show the company offers, each with its quote and page.",
    input_schema: {
      type: "object" as const,
      properties: {
        found: {
          type: "array",
          items: {
            type: "object",
            properties: {
              capability: { type: "string", description: "The code of the capability, e.g. R4.", ...(rowCodes.length <= MAX_ENUM ? { enum: rowCodes } : {}) },
              quote: { type: "string", description: "One exact, continuous passage from ONE page, at most 300 characters." },
              page: { type: "string", description: "The code of the page the quote is on, e.g. P12." },
              their_name: { type: "string", description: "The name the company uses for it." },
            },
            required: ["capability", "quote", "page", "their_name"],
          },
        },
      },
      required: ["found"],
    },
  };
}

/** A row of ours as a second look asks about it. */
export interface LookRow {
  /** "R1" … in table order, for this run's look. */
  code: string;
  capabilityId: string;
  name: string;
  description: string;
  aliases: string[];
  domain: string;
}

/** The user content of one second-look request: the company, the rows still looked for, the pages of the chunk. */
export function renderLook(company: string, rows: LookRow[], pagesText: string): string {
  const lines = rows.map((r) => `${r.code} | ${short(r.name, 80)}${r.description.trim() ? ` — ${short(r.description, 300)}` : ""}${r.aliases.length ? ` (also known as: ${r.aliases.map((a) => short(a, 60)).join(", ")})` : ""} | domain: ${short(r.domain, 60)}`);
  return `COMPANY: ${company.replace(/\s+/g, " ").trim()}\n\nCAPABILITIES OF OURS TO LOOK FOR:\n${lines.join("\n")}\n\n${pagesText}`;
}

export interface LookFound {
  capabilityId: string;
  /** The row's code in this request. */
  code: string;
  pageId: string;
  pageHash: string;
  quote: string;
  /** The company's own name for it; "" when the answer gave none. */
  wording: string;
}

/**
 * The answer of one second-look request. "Found" counts only when the code is one of the rows asked, the page is
 * one of the request's and the quote is on that page. A code that was not asked, a page that is not in the request
 * and a quote that is not on its page are INCIDENTS: nothing of them reaches the table. A row answered twice keeps
 * its first answer that passed. A quote or a name that names a person is left out.
 */
export function parseLook(value: unknown, rows: LookRow[], pages: RequestPage[]): { found: LookFound[]; incidents: IncidentDraft[] } {
  const byCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]));
  const pageOf = new Map(pages.map((p) => [p.code.toLowerCase(), p]));
  const checks = new Map<string, (quote: string) => string | null>();
  const check = (p: RequestPage, quote: string) => {
    let c = checks.get(p.id);
    if (!c) {
      c = quoteChecker(p.text);
      checks.set(p.id, c);
    }
    return c(quote);
  };
  const found: LookFound[] = [];
  const incidents: IncidentDraft[] = [];
  const done = new Set<string>();
  for (const f of arr((value as Record<string, unknown> | null)?.found)) {
    const o = (f ?? {}) as Record<string, unknown>;
    const code = typeof o.capability === "string" ? o.capability.trim() : "";
    const quote = typeof o.quote === "string" ? o.quote : "";
    const pageCode = typeof o.page === "string" ? o.page.trim() : "";
    const row = byCode.get(code.toLowerCase());
    const base = { itemKind: "row", parent: null, quote, pageCode };
    if (!row) {
      incidents.push({ kind: "unknown_item", ...base, item: code || "(none)", pageUrl: null, pageId: null, pageHash: null, foundOn: null });
      continue;
    }
    if (done.has(row.code)) continue;
    const page = pageOf.get(pageCode.toLowerCase());
    if (!page) {
      incidents.push({ kind: "unknown_page", ...base, item: row.name, pageUrl: null, pageId: null, pageHash: null, foundOn: null });
      continue;
    }
    const stored = check(page, quote);
    if (!stored) {
      const other = pages.find((p) => p.id !== page.id && check(p, quote));
      incidents.push({ kind: "quote_not_on_page", ...base, item: row.name, pageUrl: page.url, pageId: page.id, pageHash: page.hash, foundOn: other?.url ?? null });
      continue;
    }
    const wording = str(o.their_name, 80);
    if (piiIn(stored, wording)) continue;
    done.add(row.code);
    found.push({ capabilityId: row.capabilityId, code: row.code, pageId: page.id, pageHash: page.hash, quote: stored, wording });
  }
  return { found, incidents };
}
