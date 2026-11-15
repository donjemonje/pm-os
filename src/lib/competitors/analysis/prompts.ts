import { arr, pageMeta, str } from "../ai";
import { checkPii } from "../pii";
import { wordingKey } from "./items";
import { quoteChecker, verifyQuote } from "./quotes";
import { isSectionLabel, MAP_OPENING_CHARS, prefixPath, SECTION_LABELS, type Section, type SectionLabel } from "./sections";

/**
 * The prompts of the setup run's two own steps live next to their rules: analysis/unify.ts (unify, unify review)
 * and analysis/domains.ts (domains). Administration → Competitors lists every prompt, these included.
 *
 * The five prompts of the capability analysis (Capability Analysis, "How the analysis runs"). Each has a version,
 * the system text, the tool (the JSON schema the answer is held to), a render function for the user content and a
 * parse function that validates the answer field by field and returns typed, cleaned data. A parser never throws
 * on a bad field: it drops it and counts it.
 *
 * PMOS AI never decides a cell. The map labels the sections of the site that code built (closed codes, closed
 * labels), skimming a few sample pages of each: address, title and first lines. Research lists what a page offers, in the page's words, with a quote; the quote is checked in code.
 * Merge groups wordings. Match answers with OUR codes (a closed set), never free names. The second look answers
 * one capability from its most likely pages. The cells are filled by fixed rules (cells.ts).
 *
 * Pure: no database, no network.
 */

/**
 * Bumping MAP_VERSION invalidates nothing: a saved section label is a decision. It is stored with every label it gave.
 * map-2 (2026-11-15): the map skims the sample pages — each carries its first lines, not only its title and address.
 */
export const MAP_VERSION = "map-2";

/** Bumping RESEARCH_VERSION makes every page of every competitor due again (it is part of SourcePage.analyzedKey). */
export const RESEARCH_VERSION = "research-2";
export const MERGE_VERSION = "merge-1";
/** Bumping MATCH_VERSION invalidates nothing: a saved match is a decision. */
export const MATCH_VERSION = "match-2";
export const LOOK_VERSION = "look-2";

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

// ————— 1. Research: one call per page —————

export const RESEARCH_SYSTEM_PROMPT = `You read one page of a company's website for a product team that studies this company. List every capability the page says the company offers, and under each capability the features the page describes for it.

A capability is something a buyer would list as a requirement when choosing a product. A feature is a detail of how a capability works.

Rules:
- Use their words. The name is the name the page itself uses, as short as the page allows (at most 80 characters). Do not rename, generalise or translate it.
- For every capability and every feature give one exact quote from the page that shows it: copied character for character, one continuous passage of at most 300 characters, no ellipsis, nothing added, nothing joined from two places.
- For every capability and every feature give one sentence of reasoning: why this quote means the company offers it.
- For every capability and every feature give a description: one plain sentence saying what it does, taken only from what this page says. When the page does not say what it does, leave the description empty. Never fill it from what you know.
- A page marked COMPARISON PAGE compares the company named there with another company. List only what the page says that company itself offers. Ignore every statement about the other company: nothing the other company offers or lacks is listed, and no quote is taken from a passage about the other company.
- Only what this page says the company itself offers today. Not what its customers or partners do, not what an article discusses in general, not plans or roadmaps, not job requirements, not legal text, not menu labels.
- A page that offers nothing (an article about the industry, a legal page, an empty page) has an empty list. An empty list is a correct answer.
- Nothing about people: no names, titles or contact details.`;

const FINDING_PROPS = {
  name: { type: "string", description: "The name the page uses, at most 80 characters." },
  quote: { type: "string", description: "One exact, continuous passage from the page, at most 300 characters." },
  reasoning: { type: "string", description: "One sentence: why this quote means the company offers it." },
  description: { type: "string", description: "One plain sentence of what it does, taken only from this page. Empty when the page does not say." },
};

export const RESEARCH_TOOL = {
  name: "list_capabilities",
  description: "Record every capability the page says the company offers, with the features under each.",
  input_schema: {
    type: "object" as const,
    properties: {
      capabilities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ...FINDING_PROPS,
            features: { type: "array", items: { type: "object", properties: FINDING_PROPS, required: ["name", "quote", "reasoning", "description"] } },
          },
          required: ["name", "quote", "reasoning", "description", "features"],
        },
      },
    },
    required: ["capabilities"],
  },
};

export const RESEARCH_MAX_TOKENS = 8000;
export const MAX_CAPABILITIES_PER_PAGE = 40;
export const MAX_FEATURES_PER_CAPABILITY = 30;
/** A finding's description is cut to this many characters. */
export const MAX_DESCRIPTION_CHARS = 300;

export interface PromptPage {
  url: string;
  title: string;
  text: string;
  /** SourcePage.kind */
  kind?: string;
  /** Source type label ("Help center", "Datasheets & documents"). */
  sourceLabel?: string;
}

/** The extra instruction the research call gets on a page of a "compare" section: one line in the page's header, naming the company that owns the site. */
export function comparePageLine(company: string): string {
  return `COMPARISON PAGE: this page compares ${company} with another company. List only what it says ${company} itself offers; ignore every statement about the other company.`;
}

/**
 * One page, whole: no cut, no other page. `compareCompany` is set for a page of a "compare" section (the company
 * that owns the site): the page then carries the COMPARISON PAGE line — only that company's own claims are listed.
 */
export function renderResearch(page: PromptPage, opts: { compareCompany?: string | null } = {}): string {
  const meta = pageMeta(page);
  const company = opts.compareCompany?.replace(/\s+/g, " ").trim();
  const compare = company ? `\n${comparePageLine(company)}` : "";
  return `PAGE ${page.url}\nTitle: ${page.title}${meta ? `\nSource: ${meta}` : ""}${compare}\n\n${page.text}`;
}

export interface ResearchFinding {
  kind: "capability" | "feature";
  /** Their name for it, as the page says it. */
  wording: string;
  /** For a feature: the wording of the capability it sits under on this page. */
  parentWording: string | null;
  quote: string;
  reasoning: string;
  /** One plain sentence of what it does, from this page only; null when the page does not say. */
  description: string | null;
}

export interface ResearchDropped {
  /** The quote is not on the page (or there was none). */
  noQuote: number;
  /** The finding named a person. */
  pii: number;
  /** Beyond 40 capabilities per page or 30 features per capability: the sum of the two below. */
  over: number;
  /** Capabilities beyond MAX_CAPABILITIES_PER_PAGE that the answer listed and were left out. */
  overCapabilities: number;
  /** Features beyond MAX_FEATURES_PER_CAPABILITY, under the capabilities that were kept. */
  overFeatures: number;
}

const piiIn = (...texts: string[]) => texts.some((t) => checkPii(t).hit);
/** A text that names a person is emptied. */
const clean = (text: string): string => (checkPii(text).hit ? "" : text);

export function parseResearch(value: unknown, pageText: string): { findings: ResearchFinding[]; dropped: ResearchDropped } {
  const findings: ResearchFinding[] = [];
  const dropped: ResearchDropped = { noQuote: 0, pii: 0, over: 0, overCapabilities: 0, overFeatures: 0 };
  const check = quoteChecker(pageText);
  /** capability wording key → the wording that won; its features hang under that wording. */
  const capabilityByKey = new Map<string, string>();
  const featureKeys = new Set<string>();
  const one = (o: Record<string, unknown>): { name: string; quote: string; reasoning: string; description: string | null } | null => {
    const name = str(o.name, 80);
    if (!name || !wordingKey(name)) return null;
    const quote = typeof o.quote === "string" ? check(o.quote) : null;
    if (!quote) {
      dropped.noQuote++;
      return null;
    }
    const reasoning = str(o.reasoning, 300);
    if (piiIn(name, quote, reasoning)) {
      dropped.pii++;
      return null;
    }
    // A description that names a person is emptied; the finding stays (its quote was checked above).
    return { name, quote, reasoning, description: clean(str(o.description, MAX_DESCRIPTION_CHARS)) || null };
  };
  const capabilities = arr((value as Record<string, unknown> | null)?.capabilities);
  dropped.overCapabilities = Math.max(0, capabilities.length - MAX_CAPABILITIES_PER_PAGE);
  dropped.over += dropped.overCapabilities;
  for (const c of capabilities.slice(0, MAX_CAPABILITIES_PER_PAGE)) {
    const o = (c ?? {}) as Record<string, unknown>;
    const name = str(o.name, 80);
    const key = wordingKey(name);
    let parentWording = key ? capabilityByKey.get(key) ?? null : null;
    if (!parentWording) {
      // A capability whose quote fails (or that names a person) is dropped, and its features with it: no parent, no place in the list.
      const cap = one(o);
      if (!cap) continue;
      capabilityByKey.set(key, cap.name);
      findings.push({ kind: "capability", wording: cap.name, parentWording: null, quote: cap.quote, reasoning: cap.reasoning, description: cap.description });
      parentWording = cap.name;
    }
    const features = arr(o.features);
    dropped.overFeatures += Math.max(0, features.length - MAX_FEATURES_PER_CAPABILITY);
    dropped.over += Math.max(0, features.length - MAX_FEATURES_PER_CAPABILITY);
    for (const f of features.slice(0, MAX_FEATURES_PER_CAPABILITY)) {
      const fo = (f ?? {}) as Record<string, unknown>;
      const fkey = `${wordingKey(parentWording)}>${wordingKey(str(fo.name, 80))}`;
      // The same feature listed twice under one capability: the first wins.
      if (featureKeys.has(fkey)) continue;
      const feature = one(fo);
      if (!feature) continue;
      featureKeys.add(fkey);
      findings.push({ kind: "feature", wording: feature.name, parentWording, quote: feature.quote, reasoning: feature.reasoning, description: feature.description });
    }
  }
  return { findings, dropped };
}

// ————— 2. Merge: the competitor's own list —————

export const MERGE_SYSTEM_PROMPT = `Below is a numbered list of capabilities, or of features under their capabilities, found on the pages of one company's website. Some entries are the same thing under different wording. Group the entries that are the same thing.

Rules:
- Two entries are the same thing only when a buyer would treat them as one line of a requirements list. A broader thing and a narrower thing are not the same.
- Features are grouped only with features under the same capability.
- Entries marked KNOWN are lists merged by earlier scans. A new entry may join a KNOWN entry. Two KNOWN entries are never put in one group.
- List only groups of two or more entries. An entry that stands alone is not listed.`;

export const MERGE_TOOL = {
  name: "group_entries",
  description: "Record the groups of entries that are the same thing.",
  input_schema: {
    type: "object" as const,
    properties: {
      groups: {
        type: "array",
        items: { type: "object", properties: { members: { type: "array", items: { type: "string", description: "An entry code, e.g. M7." } } }, required: ["members"] },
      },
    },
    required: ["groups"],
  },
};

export const MERGE_MAX_TOKENS = 12000;
/** Capability lines per merge call; more are split into consecutive calls. */
export const MERGE_MAX_CAPABILITY_LINES = 800;
/** Feature lines per merge call; a capability's features are never split across calls. */
export const MERGE_MAX_FEATURE_LINES = 500;

export interface MergeEntry {
  /** "M1" … in the order of the call. */
  code: string;
  kind: "capability" | "feature";
  /** For a feature: the item id of its capability (features merge only inside one capability). */
  parentId: string | null;
  name: string;
  /** Distinct pages that carry it. */
  pages: number;
  /** Its top quote. */
  quote: string;
  /** Merged by an earlier run. */
  known: boolean;
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ").replace(/"/g, "'");

export function renderMergeCapabilities(company: string, entries: MergeEntry[]): string {
  const lines = entries.map((e) => `${e.code} | ${e.name} | ${e.pages} page${e.pages === 1 ? "" : "s"} | "${short(e.quote, 120)}"${e.known ? " | KNOWN" : ""}`);
  return `COMPANY: ${company}\n\nCAPABILITIES:\n${lines.join("\n")}`;
}

export function renderMergeFeatures(company: string, parents: Array<{ name: string; entries: MergeEntry[] }>): string {
  const blocks = parents.map((p) => `CAPABILITY: ${p.name}\n${p.entries.map((e) => `  ${e.code} | ${e.name} | "${short(e.quote, 120)}"${e.known ? " | KNOWN" : ""}`).join("\n")}`);
  return `COMPANY: ${company}\n\n${blocks.join("\n\n")}`;
}

/**
 * The groups of an answer, as entry codes: unknown codes dropped; a code that appears in two groups stays in the
 * first; a group that mixes kinds or (for features) capabilities is split; of several KNOWN entries in one group
 * only the first stays; groups left with fewer than two members are dropped.
 */
export function parseMerge(value: unknown, entries: MergeEntry[]): string[][] {
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const used = new Set<string>();
  const out: string[][] = [];
  for (const g of arr((value as Record<string, unknown> | null)?.groups)) {
    const members = arr((g as Record<string, unknown> | null)?.members);
    /** kind + parent → the codes of this group that belong together. */
    const parts = new Map<string, { codes: string[]; hasKnown: boolean }>();
    for (const m of members) {
      const code = typeof m === "string" ? m.trim() : "";
      const e = byCode.get(code);
      if (!e || used.has(code)) continue;
      const key = `${e.kind}|${e.parentId ?? ""}`;
      const part = parts.get(key) ?? { codes: [], hasKnown: false };
      if (e.known && part.hasKnown) continue;
      if (e.known) part.hasKnown = true;
      part.codes.push(code);
      parts.set(key, part);
      used.add(code);
    }
    for (const part of parts.values()) {
      if (part.codes.length >= 2) out.push(part.codes);
      else for (const c of part.codes) used.delete(c);
    }
  }
  return out;
}

// ————— 3. Match and place: their list against ours —————

export const MATCH_SYSTEM_PROMPT = `You match one company's list of capabilities and features to a product team's own list.

OUR LIST is grouped by domain. Each domain has the team's definition: read the definitions first, they say what belongs in each domain. Every domain, capability and feature of ours has a code. THEIR LIST has codes too.

For each entry of THEIR LIST answer:
- ours: the code of the capability or feature of ours that is the same thing, or "none". Match by what it is, not by its name. A capability of theirs can be a feature of ours, and a feature of theirs can be a capability of ours. Give a code only when you are confident it is the same thing; otherwise answer "none".

For an entry with ours = "none":
- marketName: the most common name for it in the market. Vendor-neutral: never a product, brand or marketing name.
- description: one plain sentence saying what it does.
- If it is a capability: domain = the code of the domain of ours it belongs in, or "new" when no domain of ours fits. With "new" give newDomainName (short, title case, a market term) and newDomainDefinition (one sentence). Always give closestDomain: the code of the existing domain of ours that fits best, also when you answer "new".
- Never propose a domain that is in REMOVED DOMAINS, or a rewording of one. Answer with the closest existing domain instead.
- If it is a feature: answer "none" for domain and closestDomain and leave newDomainName and newDomainDefinition empty. It follows its capability.

For an entry with ours = a code, answer "none" for domain and closestDomain and leave every other field empty.`;

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
  const domains = [NO_VALUE, "new", ...catalog.domains.keys()];
  const closest = [NO_VALUE, ...catalog.domains.keys()];
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
              domain: { type: "string", description: 'A D-code of ours, "new", or "none" (a feature, or an entry that is one of ours).', ...closed(domains) },
              newDomainName: { type: "string" },
              newDomainDefinition: { type: "string" },
              closestDomain: { type: "string", description: 'A D-code of ours, or "none" (a feature, or an entry that is one of ours).', ...closed(closest) },
              marketName: { type: "string" },
              description: { type: "string" },
            },
            required: ["entry", "ours", "domain", "newDomainName", "newDomainDefinition", "closestDomain", "marketName", "description"],
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
  quote: string;
}

export function renderMatchTail(company: string, proposedDomains: string[], entries: MatchTheirEntry[]): string {
  const lines = entries.map((e) => {
    if (e.kind === "capability") return `${e.code} | capability | ${e.name} | "${short(e.quote, 120)}"`;
    const under = e.parent ? ("code" in e.parent ? e.parent.code : `"${e.parent.name}"`) : "a capability not listed";
    return `  ${e.code} | feature of ${under} | ${e.name} | "${short(e.quote, 120)}"`;
  });
  return `COMPANY: ${company}\n\nDOMAINS PROPOSED EARLIER IN THIS RUN: ${proposedDomains.length ? proposedDomains.join(", ") : "none"}\n\nTHEIR LIST:\n${lines.join("\n")}`;
}

/** The match call's answer for an item that is none of ours — what the apply step turns into a row. */
export interface Placement {
  /** A domain of ours (active or suggested) the capability belongs in; null = a new domain, or unknown. */
  domainId: string | null;
  newDomainName: string;
  newDomainDefinition: string;
  /** The existing active domain that fits best. */
  closestDomainId: string | null;
  marketName: string;
  description: string;
}

export type MatchAnswer =
  | { entry: string; ours: { kind: "capability" | "feature"; id: string }; placement: null }
  | { entry: string; ours: null; placement: Placement };

/**
 * The answers of one batch. An entry outside the batch is dropped; a duplicate entry keeps the first; an `ours`
 * that is neither a code of ours nor "none" counts as "none" (and is reported); `domain` must be a D-code or "new"
 * (anything else leaves the placement to closestDomain); closestDomain must be an active domain of ours.
 */
export function parseMatch(value: unknown, batch: MatchBatchEntry[], catalog: MatchCatalog): { answers: MatchAnswer[]; unknownOurs: string[] } {
  const kinds = new Map(batch.map((b) => [b.code, b.kind]));
  const seen = new Set<string>();
  const answers: MatchAnswer[] = [];
  const unknownOurs: string[] = [];
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
    const placement: Placement = { domainId: null, newDomainName: "", newDomainDefinition: "", closestDomainId: null, marketName: clean(str(o.marketName, 80)), description: clean(str(o.description, 300)) };
    if (kind === "capability") {
      const domainCode = typeof o.domain === "string" ? o.domain.trim() : "";
      const domain = catalog.domains.get(domainCode);
      if (domain) {
        placement.domainId = domain.id;
      } else if (domainCode.toLowerCase() === "new") {
        placement.newDomainName = clean(str(o.newDomainName, 60));
        placement.newDomainDefinition = clean(str(o.newDomainDefinition, 300));
      }
      const closest = catalog.domains.get(typeof o.closestDomain === "string" ? o.closestDomain.trim() : "");
      placement.closestDomainId = closest && closest.state === "active" ? closest.id : null;
    }
    answers.push({ entry, ours: null, placement });
  }
  return { answers, unknownOurs };
}

// ————— 4. Second look: one capability of ours that got no match —————

export const LOOK_SYSTEM_PROMPT = `A product team wants to know whether one company offers one capability. You get the capability with the team's definition, and the pages of the company's website most likely to mention it.

Answer whether the pages show that the company offers this capability.
- If they do: found = true; quote = the exact passage that shows it (copied character for character, one continuous passage of at most 300 characters); url = the address of the page the quote is on (one of the PAGE lines); theirName = the name the company uses for it; reasoning = one sentence: why this quote means they offer it.
- If they do not: found = false, url = "none" and every other field empty.
A related or broader offering is not this capability. Do not guess.`;

export const LOOK_MAX_TOKENS = 1000;

export function lookTool(urls: string[]): Record<string, unknown> {
  return {
    name: "second_look",
    description: "Record whether the pages show that the company offers the capability.",
    input_schema: {
      type: "object" as const,
      properties: {
        found: { type: "boolean" },
        quote: { type: "string" },
        url: { type: "string", description: 'The address of the page the quote is on (one of the PAGE lines); "none" when not found.', ...(urls.length <= MAX_ENUM ? { enum: [NO_VALUE, ...urls] } : {}) },
        theirName: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["found", "quote", "url", "theirName", "reasoning"],
    },
  };
}

export function renderSecondLook(
  capability: { name: string; description: string; aliases: string[] },
  domain: { name: string; description: string },
  company: string,
  pages: PromptPage[],
): string {
  const head = [
    `CAPABILITY: ${capability.name}`,
    capability.description.trim() || null,
    capability.aliases.length ? `Also known as: ${capability.aliases.join(", ")}` : null,
    `DOMAIN: ${domain.name}`,
    domain.description.trim() || null,
  ].filter(Boolean).join("\n");
  const blocks = pages.map((p) => {
    const meta = pageMeta(p);
    return `### PAGE ${p.url}\nTitle: ${p.title}${meta ? `\nSource: ${meta}` : ""}\n${p.text}`;
  });
  return `${head}\n\nCOMPANY: ${company}\n\n${blocks.join("\n\n")}`;
}

export type SecondLookAnswer =
  | { found: true; pageId: string; quote: string; wording: string; reasoning: string }
  /** `quoteDropped`: the model said found, but its quote is not on the page it named. */
  | { found: false; quoteDropped: boolean };

/** "Found" counts only when the page is one of those given, the quote is on that page, and nothing names a person. */
export function parseSecondLook(value: unknown, pages: Array<{ id: string; url: string; text: string }>): SecondLookAnswer {
  const o = (value ?? {}) as Record<string, unknown>;
  if (o.found !== true) return { found: false, quoteDropped: false };
  const url = typeof o.url === "string" ? o.url.trim() : "";
  const page = pages.find((p) => p.url === url);
  if (!page) return { found: false, quoteDropped: false };
  const quote = typeof o.quote === "string" ? verifyQuote(o.quote, page.text) : null;
  if (!quote) return { found: false, quoteDropped: true };
  const wording = str(o.theirName, 80);
  const reasoning = str(o.reasoning, 300);
  if (piiIn(quote, wording, reasoning)) return { found: false, quoteDropped: false };
  return { found: true, pageId: page.id, quote, wording, reasoning };
}
