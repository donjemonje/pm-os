import { arr, str } from "../ai";
import { checkPii } from "../pii";
import type { Incident } from "./incidents";
import { wordingKey } from "./items";
import { quoteChecker } from "./quotes";

/**
 * THE READING — a company is read in a few large chunks of related pages (Capability Analysis, "How the analysis
 * runs"; rebuilt 2026-11-16 after the per-page reading asked 1,005 times about six companies and listed the same
 * capabilities over and over).
 *
 * The first request of a company returns its LIST: its capabilities and the features under each, each one once,
 * with a one-sentence description, an exact quote and the page the quote is on. A later request gets the list so
 * far and more pages, and answers only with what those pages CHANGE: new capabilities, new features under a
 * capability of the list, corrections, removals. (A full list again was tried by hand: the answer grew long and
 * was cut by a timeout.) Chunks are read strongest source first (sections.ts READ_ORDER), so the list is built
 * from release notes, the help center and the developer docs, and marketing pages only add.
 *
 * What a finding carries: name, description (one plain sentence of what it does), quote, page. No "reasoning".
 * The quote is checked in code against the stored text of the page it names. A quote that is not there is an
 * INCIDENT (incidents.ts): the finding does not reach the table and the case is kept on the run.
 *
 * The list so far is shown with codes (K1 a capability, K1.2 a feature): an answer names an item of the list by
 * its code — a closed set, checked here. A code that is not in the list is an incident too.
 *
 * This file is the prompts, the answer shapes, the parsers and the rule that applies a changes-answer to a list.
 * The database side is analysis/read-step.ts; what a chunk is, analysis/chunks.ts.
 *
 * Pure: no database, no network.
 */

/** Bumping READ_VERSION makes every page of every company due again (it is part of SourcePage.analyzedKey), and a company whose pages are all due starts its list over. */
export const READ_VERSION = "read-1";
/** Visible output tokens of the first request of a company (its whole list) and of a later one (changes only). */
export const READ_MAX_TOKENS = 48_000;
export const READ_CHANGES_MAX_TOKENS = 32_000;
/** A name, a description and a label are cut to this many characters. */
export const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 300;

// ————— The prompts —————

/**
 * The "where a PM looks" guide (Daniel 2026-11-16) — short, explicit, and shown in Administration → Competitors →
 * AI prompts so it can be improved run by run. The same order decides the order chunks are read in (sections.ts
 * READ_ORDER): keep the two in step.
 */
export const WHERE_A_PM_LOOKS = `WHERE A PM LOOKS. What a product really does is written where its users and developers read, not where the company advertises. Every page below says its kind. From the strongest proof to the weakest:
1. Release notes and changelog (kind release_notes) — what was really shipped, release after release.
2. Help center and user guides (kind help) — how the product really works.
3. API and developer documentation (kind api_docs) — what the product can do, exactly.
4. The pricing page's plan table (kind pricing) — what is sold, by name; often a bare label and nothing more.
5. Product and feature pages (kind product, kind document).
6. Marketing pages — the home page, enterprise and solutions pages (also kind product), comparison pages (kind compare), news (kind news): how the company wants to look.
Build the list from the strongest pages. A weaker page may add what no stronger page shows; it never outweighs one. When several pages show the same thing, take the quote from the strongest page that says it clearly.`;

/**
 * An area is not a capability: it is split. Shared with the prompt that adds a newly found ability to the table
 * (news/table-prompt-new-intake.ts), which asks the same of a row that grew too wide.
 */
export const AREA_SPLIT_RULE = `An item with many unrelated things under it is an area, not a capability: split it into the capabilities it holds. "Car entertainment" with Bluetooth, radio, navigation and rear-seat screens under it is an area; "Bluetooth connection", "Radio", "Navigation" and "Rear-seat screens" are the capabilities, each with its own features.`;

/** The rule of capability size, with Daniel's own example. */
export const SIZE_RULE = `THE THREE SIZES. Take a car:
- A domain is an area: "Car entertainment". Do not list domains.
- A capability is ONE thing the product can do: "Bluetooth connection". It is one line a buyer would write in a list of requirements.
- A feature is a detail of that one capability: "iPhone support".
${AREA_SPLIT_RULE} A broad product has tens of capabilities, each with a few features — never a handful of big ones with long lists under them.`;

/** No invented umbrella: names are the company's own. */
export const NAMES_RULE = `Names are the company's own. A capability's name is the company's own term for that one thing, as short as its pages allow. Never coin a name to hold what is left over: there is no "Other", "General", "Platform", "Administration" or "Operations & Reporting". When a feature fits none of the capabilities you listed, the capability it belongs to is missing from your list: find it on the pages and list it under the company's term for it.`;

/** Every feature says its object. */
export const OBJECT_RULE = `Every feature says what it is about. "Custom fields", "Reports", "Templates", "Search" or "Archive" alone say nothing: custom fields ON WHAT, reports ABOUT WHAT, templates FOR WHAT — say it as the pages say it ("Custom fields on ideas", "Capacity reports per team"). When no page says what it is about, it is not a feature: see the next rule.`;

/** A bare label is reported as such, not dressed up. */
export const UNEXPLAINED_RULE = `Seen but not explained. A bare label — a line of a plan table or of a list that names something no page explains — is not a feature. Do not dress it up with a description of your own. Put it under "unexplained": the label as written, and the page it is on.`;

export const READ_SYSTEM_PROMPT = `You study one company for a product team that compares the companies of one market. Below are pages of the company's own material — its website, its help center, its release notes, its developer documentation. Each page has a code, its address, its kind, its title and its text. Read them all, then list what the company's product does: its capabilities, and under each capability its features.

${SIZE_RULE}

${WHERE_A_PM_LOOKS}

Rules:
- List each capability once and each feature once, however many pages mention it. Put a feature under the one capability it is a detail of.
- ${NAMES_RULE}
- ${OBJECT_RULE}
- ${UNEXPLAINED_RULE}
- Description: one plain sentence saying what it does, taken only from these pages.
- Quote: one exact passage that shows it, copied character for character from ONE page — one continuous passage of at most 300 characters, nothing added, no ellipsis. Page: the code of the page the quote is on.
- A page of kind "compare" compares the company with another company: take only what it says the company itself offers, never anything about the other company.
- A help article shows how the product really works: take the capabilities and features it shows; a single step of a how-to is not a feature.
- Only what the product does today. Not a marketing headline that names the whole product, not a pricing term (price, seats, contract, support hours), not what customers do, not plans or roadmaps, nothing about people.
- A block marked SITE FRAME holds the lines a site repeats on most of its pages (menu, table of contents, footer), shown once. It is not a page: take no quote from it.`;

/** Added to the system prompt of every request after the first of a company. */
export const READ_CHANGES_RULES = `THE LIST SO FAR was made from other pages of the same company — pages at least as strong as these in the guide above. Every item of it has a code: K1 is a capability, K1.2 a feature under it. After it come more pages. Do NOT repeat the list. Answer only with what these pages change in it:
- new_capabilities: capabilities the list does not have yet, each with its features. The rules of size and of names hold: one thing the product can do, under the company's own term.
- new_features: features the list does not have yet, each with the code of the capability of the list it is a detail of.
- corrections: an item of the list, by its code, whose name, description or quote these pages show to be wrong, or show more clearly. Give only what changes and leave the other fields empty; a new quote comes with its page.
- removed: an item of the list, by its code, that these pages show the company does not offer, with why.
- unexplained: bare labels on these pages that neither the list nor these pages explain.
An item marked PROOF LOST had its quote on a page that has changed or is gone. When these pages show it, give a correction with a new quote and its page. When they do not, leave it out: it is dropped after the reading.
A page that changes nothing adds nothing. Empty lists are a correct answer.`;

const ITEM_PROPS = {
  name: { type: "string", description: "The company's own term, at most 80 characters." },
  description: { type: "string", description: "One plain sentence: what it does, from these pages only." },
  quote: { type: "string", description: "One exact, continuous passage from ONE page, at most 300 characters." },
  page: { type: "string", description: "The code of the page the quote is on, e.g. P12." },
};
const ITEM_REQUIRED = ["name", "description", "quote", "page"];
const UNEXPLAINED_SCHEMA = {
  type: "array",
  description: "Bare labels no page explains: seen, not explained.",
  items: { type: "object", properties: { label: { type: "string" }, page: { type: "string", description: "The code of the page the label is on." } }, required: ["label", "page"] },
};
const CAPABILITY_SCHEMA = {
  type: "object",
  properties: { ...ITEM_PROPS, features: { type: "array", items: { type: "object", properties: ITEM_PROPS, required: ITEM_REQUIRED } } },
  required: [...ITEM_REQUIRED, "features"],
};

/** The tool of the first request of a company: its whole list. */
export const READ_TOOL = {
  name: "list_offering",
  description: "Record the company's capabilities and the features under each, each one once, and the labels that are seen but not explained.",
  input_schema: {
    type: "object" as const,
    properties: { capabilities: { type: "array", items: CAPABILITY_SCHEMA }, unexplained: UNEXPLAINED_SCHEMA },
    required: ["capabilities", "unexplained"],
  },
};

/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
const MAX_ENUM = 120;

/** The tool of a later request: only what its pages change. `capabilityCodes` and `itemCodes` are the codes of the list so far. */
export function readChangesTool(capabilityCodes: string[], itemCodes: string[]): Record<string, unknown> {
  const closed = (values: string[]) => (values.length && values.length <= MAX_ENUM ? { enum: values } : {});
  return {
    name: "update_offering",
    description: "Record only what these pages change in the list so far.",
    input_schema: {
      type: "object" as const,
      properties: {
        new_capabilities: { type: "array", items: CAPABILITY_SCHEMA },
        new_features: {
          type: "array",
          items: { type: "object", properties: { capability: { type: "string", description: "The code of the capability of the list it belongs under, e.g. K3.", ...closed(capabilityCodes) }, ...ITEM_PROPS }, required: ["capability", ...ITEM_REQUIRED] },
        },
        corrections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "The code of the item of the list, e.g. K3 or K3.2.", ...closed(itemCodes) },
              new_name: { type: "string", description: "Its right name; empty when the name stays." },
              description: { type: "string", description: "Its right description; empty when it stays." },
              quote: { type: "string", description: "A clearer quote; empty when the quote stays." },
              page: { type: "string", description: "The code of the page the new quote is on; empty when the quote stays." },
            },
            required: ["item", "new_name", "description", "quote", "page"],
          },
        },
        removed: { type: "array", items: { type: "object", properties: { item: { type: "string", ...closed(itemCodes) }, why: { type: "string" } }, required: ["item", "why"] } },
        unexplained: UNEXPLAINED_SCHEMA,
      },
      required: ["new_capabilities", "new_features", "corrections", "removed", "unexplained"],
    },
  };
}

// ————— The list of a company —————

/** The proof of an item: the page its quote is on, the text that page had (its hash), and the quote as stored. */
export interface Proof {
  pageId: string;
  pageHash: string;
  quote: string;
}

export interface ListEntry {
  /** The stored item; null for one an answer just made. */
  id: string | null;
  name: string;
  description: string;
  /** Null = no proof: its quote failed the check (a capability kept only to hold its features), or the page it was on changed or is gone. */
  proof: Proof | null;
}

export interface ListCapability extends ListEntry {
  features: ListEntry[];
}

export interface CodedEntry {
  code: string;
  kind: "capability" | "feature";
  entry: ListEntry;
  /** For a feature: the capability it is under. */
  parent: ListCapability | null;
}

/** The codes of a list, in its order: K1, K1.1, K1.2, K2 … */
export function codeList(list: ListCapability[]): CodedEntry[] {
  const out: CodedEntry[] = [];
  list.forEach((k, i) => {
    out.push({ code: `K${i + 1}`, kind: "capability", entry: k, parent: null });
    k.features.forEach((f, j) => out.push({ code: `K${i + 1}.${j + 1}`, kind: "feature", entry: f, parent: k }));
  });
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The list so far as a later request sees it: one line per item — code, name, description; an item with no proof is marked. */
export function renderListSoFar(coded: CodedEntry[]): string {
  return coded
    .map((c) => `${c.kind === "feature" ? "  " : ""}${c.code} | ${oneLine(c.entry.name)}${c.entry.description ? ` — ${oneLine(c.entry.description)}` : ""}${c.entry.proof ? "" : " | PROOF LOST"}`)
    .join("\n");
}

/** The user content of a reading request: the company, the list so far (a later request only), the pages. */
export function renderReading(company: string, listSoFar: string | null, pagesText: string): string {
  return `COMPANY: ${oneLine(company)}\n\n${listSoFar ? `LIST SO FAR:\n${listSoFar}\n\n` : ""}${pagesText}`;
}

// ————— Parsing —————

/** A page of the request as the check needs it: its code in the request and its stored text, whole. */
export interface RequestPage {
  code: string;
  id: string;
  url: string;
  hash: string;
  /** The stored text of the page — the quote is checked against this, never against what was sent. */
  text: string;
}

/** What the step adds to make an Incident of it: when, where, which company, which request. */
export type IncidentDraft = Omit<Incident, "at" | "step" | "competitorId" | "company" | "request">;

export interface ReadDropped {
  /** Items left out because a name, a quote or a description names a person. */
  pii: number;
  /** Items with no usable name. */
  unnamed: number;
  /** Items the answer listed twice (the first stays). */
  repeated: number;
  /** Renames refused: another item of the list has that name. */
  renameRefused: number;
}

const emptyDropped = (): ReadDropped => ({ pii: 0, unnamed: 0, repeated: 0, renameRefused: 0 });
const piiIn = (...texts: string[]) => texts.some((t) => checkPii(t).hit);
const cleanText = (text: string): string => (checkPii(text).hit ? "" : text);

/** The quote check of one request: each page's text is normalized once, when a quote first names it. */
class Checker {
  private readonly pages: RequestPage[];
  private readonly byCode: Map<string, RequestPage>;
  private readonly checks = new Map<string, (quote: string) => string | null>();
  // No parameter property here: the scanner CLI runs these files with Node's type stripping, which does not take them.
  constructor(pages: RequestPage[]) {
    this.pages = pages;
    this.byCode = new Map(pages.map((p) => [p.code.toLowerCase(), p]));
  }
  page(code: string): RequestPage | null {
    return this.byCode.get(code.trim().toLowerCase()) ?? null;
  }
  private check(page: RequestPage, quote: string): string | null {
    let c = this.checks.get(page.id);
    if (!c) {
      c = quoteChecker(page.text);
      this.checks.set(page.id, c);
    }
    return c(quote);
  }
  /** The proof, or the incident: the page code is not one of the request's, or the quote is not on that page (then: is it on another page of the request?). */
  prove(itemKind: string, item: string, parent: string | null, quote: string, pageCode: string): { proof: Proof } | { incident: IncidentDraft } {
    const page = this.page(pageCode);
    const base = { itemKind, item, parent, quote, pageCode: pageCode.trim() };
    if (!page) return { incident: { kind: "unknown_page", ...base, pageUrl: null, pageId: null, pageHash: null, foundOn: null } };
    const stored = this.check(page, quote);
    if (stored) return { proof: { pageId: page.id, pageHash: page.hash, quote: stored } };
    const other = this.pages.find((p) => p.id !== page.id && this.check(p, quote));
    return { incident: { kind: "quote_not_on_page", ...base, pageUrl: page.url, pageId: page.id, pageHash: page.hash, foundOn: other?.url ?? null } };
  }
}

export interface ParsedFeature {
  name: string;
  description: string;
  proof: Proof;
}
export interface ParsedCapability {
  name: string;
  description: string;
  /** Null when its own quote failed the check: it is kept only because it holds features that passed. */
  proof: Proof | null;
  features: ParsedFeature[];
}

export interface Unexplained {
  label: string;
  /** The address of the page it is on; null when the answer named no page of the request. */
  url: string | null;
}

function parseUnexplained(value: unknown, checker: Checker): Unexplained[] {
  const out: Unexplained[] = [];
  const seen = new Set<string>();
  for (const u of arr(value)) {
    const o = (u ?? {}) as Record<string, unknown>;
    const label = str(o.label, MAX_NAME_CHARS);
    const key = wordingKey(label);
    if (!key || seen.has(key) || piiIn(label)) continue;
    seen.add(key);
    out.push({ label, url: typeof o.page === "string" ? checker.page(o.page)?.url ?? null : null });
  }
  return out;
}

/** One item of an answer: null when it has no name or names a person; else its name, description and proof — or the incident its quote made. */
function parseItem(o: Record<string, unknown>, itemKind: "capability" | "feature", parent: string | null, checker: Checker, dropped: ReadDropped): { name: string; description: string; proof: Proof | null; incident: IncidentDraft | null } | null {
  const name = str(o.name, MAX_NAME_CHARS);
  if (!name || !wordingKey(name)) {
    dropped.unnamed++;
    return null;
  }
  const quote = typeof o.quote === "string" ? o.quote : "";
  const result = checker.prove(itemKind, name, parent, quote, typeof o.page === "string" ? o.page : "");
  if (piiIn(name, "proof" in result ? result.proof.quote : "")) {
    dropped.pii++;
    return null;
  }
  // A description that names a person is emptied; the item stays (its quote was checked).
  const description = cleanText(str(o.description, MAX_DESCRIPTION_CHARS));
  return "proof" in result ? { name, description, proof: result.proof, incident: null } : { name, description, proof: null, incident: result.incident };
}

/** The capabilities of an answer (a first list, or the new_capabilities of a changes-answer): each once, each feature once under it. */
function parseCapabilities(value: unknown, checker: Checker, dropped: ReadDropped, incidents: IncidentDraft[]): ParsedCapability[] {
  const out: ParsedCapability[] = [];
  const byKey = new Map<string, ParsedCapability>();
  const featureKeys = new Set<string>();
  for (const c of arr(value)) {
    const o = (c ?? {}) as Record<string, unknown>;
    const key = wordingKey(str(o.name, MAX_NAME_CHARS));
    let capability = key ? byKey.get(key) : undefined;
    if (capability) {
      // The same capability listed twice: the first stays; the features of the second join it.
      dropped.repeated++;
    } else {
      const item = parseItem(o, "capability", null, checker, dropped);
      if (!item) continue;
      if (item.incident) incidents.push(item.incident);
      capability = { name: item.name, description: item.description, proof: item.proof, features: [] };
      byKey.set(key, capability);
      out.push(capability);
    }
    for (const f of arr(o.features)) {
      const fo = (f ?? {}) as Record<string, unknown>;
      const fkey = `${key}>${wordingKey(str(fo.name, MAX_NAME_CHARS))}`;
      if (featureKeys.has(fkey)) {
        dropped.repeated++;
        continue;
      }
      const feature = parseItem(fo, "feature", capability.name, checker, dropped);
      if (!feature) continue;
      featureKeys.add(fkey);
      // A feature whose quote is not on its page does not reach the list: the case is kept.
      if (!feature.proof) {
        if (feature.incident) incidents.push(feature.incident);
        continue;
      }
      capability.features.push({ name: feature.name, description: feature.description, proof: feature.proof });
    }
  }
  // A capability with no proof of its own stays only to hold features that have theirs.
  return out.filter((k) => k.proof || k.features.length > 0);
}

export interface ParsedList {
  capabilities: ParsedCapability[];
  unexplained: Unexplained[];
  incidents: IncidentDraft[];
  dropped: ReadDropped;
}

/** The answer of the first request of a company. Never throws on a bad field: it drops it and counts it. */
export function parseList(value: unknown, pages: RequestPage[]): ParsedList {
  const o = (value ?? {}) as Record<string, unknown>;
  const checker = new Checker(pages);
  const dropped = emptyDropped();
  const incidents: IncidentDraft[] = [];
  const capabilities = parseCapabilities(o.capabilities, checker, dropped, incidents);
  return { capabilities, unexplained: parseUnexplained(o.unexplained, checker), incidents, dropped };
}

/** One change a later request makes to the list. `target` is an entry of the list the answer was parsed against. */
export type ChangeOp =
  | { op: "add_capability"; capability: ParsedCapability }
  | { op: "add_feature"; target: ListCapability; feature: ParsedFeature }
  | { op: "correct"; target: ListEntry; name: string | null; description: string | null; proof: Proof | null }
  | { op: "remove"; target: ListEntry; why: string };

export interface ParsedChanges {
  ops: ChangeOp[];
  unexplained: Unexplained[];
  incidents: IncidentDraft[];
  dropped: ReadDropped;
}

/**
 * The answer of a later request, against the list so far (`coded` = codeList(list)).
 *   - new_capabilities: as in a first list. One whose normalized name is a capability of the list IS that
 *     capability: its features are added under it, and its quote becomes the proof when that one had none.
 *   - new_features: `capability` must be the code of a capability of the list — any other code is an incident and
 *     the feature is left out. A feature the capability already has (same normalized name) is not added twice; its
 *     quote becomes the proof when that one had none.
 *   - corrections / removed: `item` must be a code of the list — any other code is an incident. A correction
 *     changes only the fields it gives; a new quote counts only with a page it is on (else an incident, and the old
 *     proof stays); a new name that another item of the same level already has is refused. An item that is
 *     both corrected and removed is removed.
 */
export function parseChanges(value: unknown, coded: CodedEntry[], pages: RequestPage[]): ParsedChanges {
  const o = (value ?? {}) as Record<string, unknown>;
  const checker = new Checker(pages);
  const dropped = emptyDropped();
  const incidents: IncidentDraft[] = [];
  const ops: ChangeOp[] = [];
  const byCode = new Map(coded.map((c) => [c.code.toLowerCase(), c]));
  const list = coded.filter((c) => c.kind === "capability").map((c) => c.entry as ListCapability);
  const capabilityByKey = new Map(list.map((k) => [wordingKey(k.name), k]));
  /** Names in use per capability (features) — the list's and the ones this answer adds. */
  const featureKeys = new Map<ListCapability, Set<string>>(list.map((k) => [k, new Set(k.features.map((f) => wordingKey(f.name)))]));
  const unknownItem = (code: string, itemKind: string) =>
    incidents.push({ kind: "unknown_item", itemKind, item: code || "(none)", parent: null, quote: "", pageCode: "", pageUrl: null, pageId: null, pageHash: null, foundOn: null });
  const addFeature = (target: ListCapability, feature: ParsedFeature) => {
    const keys = featureKeys.get(target)!;
    const key = wordingKey(feature.name);
    if (keys.has(key)) {
      const existing = target.features.find((f) => wordingKey(f.name) === key);
      if (existing && !existing.proof) ops.push({ op: "correct", target: existing, name: null, description: existing.description ? null : feature.description || null, proof: feature.proof });
      else dropped.repeated++;
      return;
    }
    keys.add(key);
    ops.push({ op: "add_feature", target, feature });
  };

  for (const k of parseCapabilities(o.new_capabilities, checker, dropped, incidents)) {
    const existing = capabilityByKey.get(wordingKey(k.name));
    if (!existing) {
      ops.push({ op: "add_capability", capability: k });
      continue;
    }
    if (!existing.proof && k.proof) ops.push({ op: "correct", target: existing, name: null, description: existing.description ? null : k.description || null, proof: k.proof });
    for (const f of k.features) addFeature(existing, f);
  }

  for (const f of arr(o.new_features)) {
    const fo = (f ?? {}) as Record<string, unknown>;
    const code = typeof fo.capability === "string" ? fo.capability.trim() : "";
    const target = byCode.get(code.toLowerCase());
    if (!target || target.kind !== "capability") {
      unknownItem(code, "capability");
      continue;
    }
    const item = parseItem(fo, "feature", target.entry.name, checker, dropped);
    if (!item) continue;
    if (!item.proof) {
      if (item.incident) incidents.push(item.incident);
      continue;
    }
    addFeature(target.entry as ListCapability, { name: item.name, description: item.description, proof: item.proof });
  }

  const removed = new Set<ListEntry>();
  const removals: ChangeOp[] = [];
  for (const r of arr(o.removed)) {
    const ro = (r ?? {}) as Record<string, unknown>;
    const code = typeof ro.item === "string" ? ro.item.trim() : "";
    const target = byCode.get(code.toLowerCase());
    if (!target) {
      unknownItem(code, "item");
      continue;
    }
    if (removed.has(target.entry)) continue;
    removed.add(target.entry);
    removals.push({ op: "remove", target: target.entry, why: cleanText(str(ro.why, MAX_DESCRIPTION_CHARS)) });
  }

  const corrected = new Set<ListEntry>();
  for (const c of arr(o.corrections)) {
    const co = (c ?? {}) as Record<string, unknown>;
    const code = typeof co.item === "string" ? co.item.trim() : "";
    const target = byCode.get(code.toLowerCase());
    if (!target) {
      unknownItem(code, "item");
      continue;
    }
    if (removed.has(target.entry) || (target.parent && removed.has(target.parent)) || corrected.has(target.entry)) continue;
    let name: string | null = str(co.new_name, MAX_NAME_CHARS) || null;
    if (name && (piiIn(name) || !wordingKey(name) || name === target.entry.name)) name = null;
    if (name && wordingKey(name) !== wordingKey(target.entry.name)) {
      // Another item of the same level already has the name: two items would be one. The rename is refused.
      const taken = target.kind === "capability" ? capabilityByKey.has(wordingKey(name)) : featureKeys.get(target.parent!)!.has(wordingKey(name));
      if (taken) {
        dropped.renameRefused++;
        name = null;
      } else if (target.kind === "capability") {
        capabilityByKey.set(wordingKey(name), target.entry as ListCapability);
      } else {
        featureKeys.get(target.parent!)!.add(wordingKey(name));
      }
    }
    const description = cleanText(str(co.description, MAX_DESCRIPTION_CHARS)) || null;
    let proof: Proof | null = null;
    const quote = typeof co.quote === "string" ? co.quote.trim() : "";
    if (quote) {
      const result = checker.prove(target.kind, name ?? target.entry.name, target.parent?.name ?? null, quote, typeof co.page === "string" ? co.page : "");
      if ("proof" in result) {
        if (piiIn(result.proof.quote)) dropped.pii++;
        else proof = result.proof;
      } else {
        incidents.push(result.incident);
      }
    }
    if (!name && !description && !proof) continue;
    corrected.add(target.entry);
    ops.push({ op: "correct", target: target.entry, name, description: description === target.entry.description ? null : description, proof });
  }
  ops.push(...removals);
  return { ops, unexplained: parseUnexplained(o.unexplained, checker), incidents, dropped };
}

// ————— Applying an answer to the list —————

/** A first list as a list: every entry is new (no stored item yet). */
export function listFrom(capabilities: ParsedCapability[]): ListCapability[] {
  return capabilities.map((k) => ({ id: null, name: k.name, description: k.description, proof: k.proof, features: k.features.map((f) => ({ id: null, name: f.name, description: f.description, proof: f.proof })) }));
}

export interface ChangeCounts {
  newCapabilities: number;
  newFeatures: number;
  corrections: number;
  removed: number;
}

/**
 * The list after the changes of one answer — a new list; the one given is not touched. Adds go to the end (a new
 * capability after the last, a new feature after the last of its capability); a correction changes only what it
 * gives; removing a capability removes its features with it.
 */
export function applyChanges(list: ListCapability[], ops: ChangeOp[]): { list: ListCapability[]; counts: ChangeCounts } {
  const counts: ChangeCounts = { newCapabilities: 0, newFeatures: 0, corrections: 0, removed: 0 };
  // Copies, each remembered by the entry it was made from: an op names the original.
  const copyOf = new Map<ListEntry, ListEntry>();
  let next: ListCapability[] = list.map((k) => {
    const features = k.features.map((f) => {
      const c: ListEntry = { ...f };
      copyOf.set(f, c);
      return c;
    });
    const c: ListCapability = { ...k, features };
    copyOf.set(k, c);
    return c;
  });
  for (const op of ops) {
    if (op.op === "add_capability") {
      next.push(...listFrom([op.capability]));
      counts.newCapabilities++;
      counts.newFeatures += op.capability.features.length;
    } else if (op.op === "add_feature") {
      const target = copyOf.get(op.target) as ListCapability | undefined;
      if (!target) continue;
      target.features.push({ id: null, name: op.feature.name, description: op.feature.description, proof: op.feature.proof });
      counts.newFeatures++;
    } else if (op.op === "correct") {
      const target = copyOf.get(op.target);
      if (!target) continue;
      if (op.name) target.name = op.name;
      if (op.description) target.description = op.description;
      if (op.proof) target.proof = op.proof;
      counts.corrections++;
    } else {
      const target = copyOf.get(op.target);
      if (!target) continue;
      const before = next.length + next.reduce((n, k) => n + k.features.length, 0);
      next = next.filter((k) => k !== target);
      for (const k of next) k.features = k.features.filter((f) => f !== target);
      if (before !== next.length + next.reduce((n, k) => n + k.features.length, 0)) counts.removed++;
    }
  }
  return { list: next, counts };
}

/**
 * The list without what has no proof — applied when a company's reading ended with nothing left to read: a feature
 * with no proof goes; a capability with no proof stays only while it holds a feature (the feature's quote is the
 * proof the table shows). Returns the new list and how many items went.
 */
export function dropUnproven(list: ListCapability[]): { list: ListCapability[]; dropped: number } {
  let dropped = 0;
  const next: ListCapability[] = [];
  for (const k of list) {
    const features = k.features.filter((f) => f.proof);
    dropped += k.features.length - features.length;
    if (!k.proof && features.length === 0) {
      dropped++;
      continue;
    }
    next.push({ ...k, features });
  }
  return { list: next, dropped };
}

/** "12 capabilities, 96 features" */
export function listSize(list: ListCapability[]): { capabilities: number; features: number } {
  return { capabilities: list.length, features: list.reduce((n, k) => n + k.features.length, 0) };
}

/** The labels that are still unexplained once the list is known: one a later page explained (it is an item of the list now) is not. One per normalized label. */
export function stillUnexplained(labels: Unexplained[], list: ListCapability[]): Unexplained[] {
  const known = new Set(list.flatMap((k) => [wordingKey(k.name), ...k.features.map((f) => wordingKey(f.name))]));
  const seen = new Set<string>();
  const out: Unexplained[] = [];
  for (const u of labels) {
    const key = wordingKey(u.label);
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}
