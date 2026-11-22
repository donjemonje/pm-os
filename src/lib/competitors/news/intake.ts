import { arr, str } from "../ai";
import { verifyQuote } from "../analysis/quotes";
import { SIZE_RULE } from "../analysis/reading";

/**
 * THE NEWS INTAKE — what a page that appeared (or changed) after a company's list was made adds to what we know
 * (News Feed & Notifications PRD, "Capabilities Updates").
 *
 * One request per page. PMOS AI gets the company's LIST (every capability and feature we hold for it, with codes)
 * and the page, and works in the PRD's order:
 *   1. What is this — an ability of the product, or something else (people, money, a deal, prices, vision)?
 *   2. For an ability: understand it — what it is, the problem it solves, the workflows it helps, who it is for.
 *   3. Is it already on the list? By what it does, not by its name.
 * The verdict of each piece of news is decided HERE, in code, from the answer:
 *   other   — not an ability: stored, notified, nothing else runs on it;
 *   covered — an ability the list already holds: notified, nothing else;
 *   new     — an ability the list does not hold: news feed + notification (and, later, the table).
 *
 * The list is a closed set: the answer names an item by its code; a code that is not in the list is dropped with
 * its piece (counted). The quote is checked in code against the page's text; a piece whose quote is not on the page
 * is kept but marked (quoteOk = false) and never reaches the feed.
 *
 * Pure: no database, no network.
 */

export const NEWS_VERSION = "news-1";
/** Visible output tokens of one page's answer. */
export const NEWS_MAX_TOKENS = 6_000;
/** A page's text is sent up to this many characters (a release-notes page can be long; the newest entries are on top). */
export const NEWS_PAGE_MAX_CHARS = 60_000;
/** "No value" in a closed set (an enum may not hold an empty string — see analysis/prompts.ts NO_VALUE). */
export const NONE = "none";
export const NOT_STATED = "not stated";

export const OTHER_TYPES = ["hr", "finance", "partnership", "pricing", "event", "marketing", "other"] as const;
export type OtherType = (typeof OTHER_TYPES)[number];
export type NewsVerdict = "new" | "covered" | "other";
export type NewsSize = "capability" | "feature";

export const NEWS_SYSTEM_PROMPT = `A product team follows one company to learn what its product can newly do. You get the company's LIST — every capability and feature the team already knows the product has, each with a code — and ONE page that was published or changed after the list was made. Go through the page in three steps, in this order.

STEP 1 — WHAT IS THIS? Split the page into its separate pieces of news and say what each one is:
- "ability": something the PRODUCT can now do for its users — a capability or a feature a user can use today, or one with a stated release (beta, early access, a date).
- "other": everything else. Say which: people, hiring, leadership (hr); funding, revenue, an acquisition (finance); a partnership or reseller deal that gives the product no new ability (partnership); prices and plans (pricing); an event, a webinar, an award (event); vision, opinion, or a promise with nothing a user can do and no release stated (marketing); anything else (other).
A page can hold several pieces: list each one once. A page that holds no news gives an empty list.

STEP 2 — UNDERSTAND IT. For every "ability", from the page alone, in plain words:
- name: the company's own name for it, as short as the page allows.
- what: one plain sentence of at most 20 words — what the product does. It is the bottom line a busy product manager reads first: the one main thing, not the list of details.
- problem: one short sentence of at most 20 words — the problem it solves for its user.
- workflows: the user workflow or workflows it helps with.
- who: who uses it — job titles; or, when it is made for AI agents and not for people, the type of agent.
- quote: one passage of the page that proves it, copied exactly, character by character.
Write only what the page says. When the page does not say one of them, write "${NOT_STATED}".
For "other" news: name is a short title, what is one sentence of what happened, quote is one passage of the page; problem, workflows and who are "${NOT_STATED}".

STEP 3 — DO WE ALREADY HAVE IT? For every "ability", search the LIST for the same thing — by what it does, never by its name: companies rename, repackage and re-announce what they already have.
- The list already holds it, under any name or wording: covered_by is the code of that item.
- It is only a detail of an item of the list that would not be a line of its own next to the lines that are there (one more option, a higher limit, a new look): it is covered — covered_by is that item's code.
- Nothing on the list holds it: covered_by is "${NONE}". Then say its size and its place:

${SIZE_RULE}

  A new capability: size "capability", parent "${NONE}". A new feature: size "feature", parent = the code of the capability of the LIST it is a detail of. A feature whose capability is not on the list is a new capability.
- reason: one short sentence — why that item of the list already holds it, or why nothing on the list does.
For "other" news: covered_by, size and parent are "${NONE}", and reason says in a few words why it is not an ability.

Be strict about what is new. A product manager who gets one false "new" stops reading; one who misses a real one finds out in a meeting.`;

export interface NewsListItem {
  /** K3 for a capability, K3.2 for a feature. */
  code: string;
  kind: NewsSize;
  /** The stored CompetitorItem. */
  id: string;
  name: string;
  description: string;
  /** A feature's capability code; null for a capability. */
  parentCode: string | null;
}

export interface NewsPage {
  url: string;
  title: string;
  /** The kind of page: release_notes | help | api_docs | product | news | blog … */
  kind: string;
  /** The date the page states, ISO, or null. */
  publishedAt: string | null;
  text: string;
}

/** The company's list with codes, in its order: capabilities K1…, each followed by its features K1.1… */
export function codeItems(capabilities: Array<{ id: string; name: string; description: string | null; features: Array<{ id: string; name: string; description: string | null }> }>): NewsListItem[] {
  const out: NewsListItem[] = [];
  capabilities.forEach((k, i) => {
    const code = `K${i + 1}`;
    out.push({ code, kind: "capability", id: k.id, name: k.name, description: k.description ?? "", parentCode: null });
    k.features.forEach((f, j) => out.push({ code: `${code}.${j + 1}`, kind: "feature", id: f.id, name: f.name, description: f.description ?? "", parentCode: code }));
  });
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderList(items: NewsListItem[]): string {
  return items.map((i) => `${i.kind === "feature" ? "  " : ""}${i.code} | ${oneLine(i.name)}${i.description ? ` — ${oneLine(i.description)}` : ""}`).join("\n");
}

export function renderNews(company: string, items: NewsListItem[], page: NewsPage): string {
  const text = page.text.length > NEWS_PAGE_MAX_CHARS ? page.text.slice(0, NEWS_PAGE_MAX_CHARS) : page.text;
  return `COMPANY: ${oneLine(company)}\n\nLIST (what we already know the product has):\n${renderList(items)}\n\nPAGE\nkind: ${page.kind}\naddress: ${page.url}\ntitle: ${oneLine(page.title)}${page.publishedAt ? `\ndate: ${page.publishedAt.slice(0, 10)}` : ""}\n\n${text}`;
}

/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
const MAX_ENUM = 120;

/** Every field is required (a schema with optional fields lets the model close its answer early — found 2026-11-20). */
export function newsTool(items: NewsListItem[]): Record<string, unknown> {
  const closed = (values: string[]) => (values.length <= MAX_ENUM ? { enum: values } : {});
  const all = [NONE, ...items.map((i) => i.code)];
  const capabilities = [NONE, ...items.filter((i) => i.kind === "capability").map((i) => i.code)];
  const piece = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["ability", "other"], description: "Step 1." },
      other_type: { type: "string", enum: [NONE, ...OTHER_TYPES], description: `For "other" news: which kind. "${NONE}" for an ability.` },
      name: { type: "string", description: "The company's own name for the ability, or a short title of other news." },
      what: { type: "string", description: "One plain sentence of at most 20 words: what the product does, or what happened." },
      problem: { type: "string", description: `The problem it solves, one sentence, or "${NOT_STATED}".` },
      workflows: { type: "string", description: `The user workflows it helps with, or "${NOT_STATED}".` },
      who: { type: "string", description: `Job titles or the type of agent it is for, or "${NOT_STATED}".` },
      quote: { type: "string", description: "One passage of the page, copied exactly." },
      covered_by: { type: "string", description: `Step 3: the code of the item of the LIST that already holds it, or "${NONE}".`, ...closed(all) },
      size: { type: "string", enum: [NONE, "capability", "feature"], description: `For an ability the list does not hold. "${NONE}" otherwise.` },
      parent: { type: "string", description: `For a new feature: the code of its capability on the LIST. "${NONE}" otherwise.`, ...closed(capabilities) },
      reason: { type: "string", description: "One short sentence: why it is covered, why it is new, or why it is not an ability." },
    },
    required: ["type", "other_type", "name", "what", "problem", "workflows", "who", "quote", "covered_by", "size", "parent", "reason"],
  };
  return {
    name: "report_news",
    description: "Report every separate piece of news on the page: what it is, what it means, and whether the list already holds it.",
    input_schema: {
      type: "object" as const,
      properties: { page_is_about: { type: "string", description: "One line: what this page is." }, pieces: { type: "array", items: piece } },
      required: ["page_is_about", "pieces"],
    },
  };
}

export interface NewsPiece {
  verdict: NewsVerdict;
  otherType: OtherType | null;
  size: NewsSize | null;
  name: string;
  what: string;
  problem: string | null;
  workflows: string | null;
  audience: string | null;
  /** The quote as it is on the page; null when the claimed passage is not there. */
  quote: string | null;
  quoteOk: boolean;
  reason: string;
  /** verdict "covered": the item of the list that holds it. */
  covered: NewsListItem | null;
  /** verdict "new", size "feature": its capability on the list. */
  parent: NewsListItem | null;
}

export interface ParsedNews {
  pageIsAbout: string;
  pieces: NewsPiece[];
  /** Pieces left out: no name, or a code that is not in the list. */
  dropped: number;
}

const stated = (v: unknown, max: number): string | null => {
  const s = str(v, max);
  return !s || s.toLowerCase() === NOT_STATED || s.toLowerCase() === NONE ? null : s;
};

/** The answer, checked field by field. A parser never throws on a bad piece: it drops it and counts it. */
export function parseNews(value: unknown, items: NewsListItem[], page: NewsPage): ParsedNews {
  const v = (value ?? {}) as Record<string, unknown>;
  const byCode = new Map(items.map((i) => [i.code, i]));
  const pieces: NewsPiece[] = [];
  let dropped = 0;
  for (const raw of arr(v.pieces)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = str(p.name, 120);
    const what = str(p.what, 400);
    if (!name || !what) { dropped++; continue; }
    const claimed = str(p.quote, 600);
    const quote = claimed ? verifyQuote(claimed, page.text) : null;
    const base = { name, what, quote, quoteOk: quote !== null, reason: str(p.reason, 300) };
    if (p.type !== "ability") {
      const t = str(p.other_type, 20);
      pieces.push({ ...base, verdict: "other", otherType: (OTHER_TYPES as readonly string[]).includes(t) ? (t as OtherType) : "other", size: null, problem: null, workflows: null, audience: null, covered: null, parent: null });
      continue;
    }
    const understood = { problem: stated(p.problem, 400), workflows: stated(p.workflows, 400), audience: stated(p.who, 300) };
    const coveredCode = str(p.covered_by, 20);
    if (coveredCode && coveredCode !== NONE) {
      const covered = byCode.get(coveredCode);
      if (!covered) { dropped++; continue; }
      pieces.push({ ...base, ...understood, verdict: "covered", otherType: null, size: null, covered, parent: null });
      continue;
    }
    const parentCode = str(p.parent, 20);
    const parent = parentCode && parentCode !== NONE ? byCode.get(parentCode) ?? null : null;
    if (parentCode && parentCode !== NONE && (!parent || parent.kind !== "capability")) { dropped++; continue; }
    // The size follows the place: a feature has a capability of the list; anything else that is new is a capability.
    pieces.push({ ...base, ...understood, verdict: "new", otherType: null, size: parent ? "feature" : "capability", covered: null, parent });
  }
  return { pageIsAbout: str(v.page_is_about, 300), pieces, dropped };
}
