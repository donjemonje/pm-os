import { arr, str } from "../ai";
import { verifyQuote } from "../analysis/quotes";
import { FEATURE_FIELDS, FEATURE_IS, FOUND_MEANS_UNDERSTOOD, INTEGRATIONS_BY_NAME, NOT_A_FEATURE, PAGE_KINDS, promptText, promptVersion, type PromptDef } from "../prompts/blocks";
import { changedText } from "./changed";

/**
 * THE NEWS INTAKE — what the pages that appeared or changed after a company's feature list was made add to what we
 * know (News Feed & Notifications PRD, "Capabilities Updates").
 *
 * The list is the company's knowledge base: a flat list of features (no capabilities, no sizes — those belong to
 * the table). ONE request holds SEVERAL pages. A new page is sent whole; of a changed page only the text that
 * changed is sent, under the nearest heading above it (news/changed.ts).
 *
 * The prompt is built from the same blocks as the prompt that builds the list (prompts/blocks.ts): what a feature
 * is, how a feature is understood (name, problem, how it works, users, workflows, evidence), what is not a feature.
 * Its own text is only what the list-building prompt does not need: the list, the changed pages, and the question
 * "does the list already hold it".
 *
 * Each thing the answer names gets a verdict, decided HERE, in code, from the place it came back in:
 *   new     — a feature the list does not hold: news feed + notification (and, later, the table);
 *   covered — a feature the list already holds: stored, nothing else;
 *   other   — not a feature (people, money, a deal, prices…), a tool name, or a name the pages do not explain:
 *             stored, nothing else runs on it.
 *
 * The list and the pages are closed sets: the answer names them by code; a code that was not given is dropped
 * (counted). Every quote is checked in code against its page's text; a new feature with no quote on its page is
 * kept but marked (quoteOk = false) and never reaches the feed or the email.
 *
 * Pure: no database, no network.
 */

/** Visible output tokens of one request's answer. */
export const NEWS_MAX_TOKENS = 30_000;
/** A page's text is sent up to this many characters (a release-notes page can be long; the newest entries are on top). */
export const NEWS_PAGE_MAX_CHARS = 60_000;
/** One request holds pages up to this many characters of text in all, and at most this many pages. */
export const NEWS_REQUEST_MAX_CHARS = 160_000;
export const NEWS_REQUEST_MAX_PAGES = 30;
/** "No value" in a closed set (an enum may not hold an empty string). */
export const NONE = "none";

export const LEFT_OUT_TYPES = ["hr", "finance", "partnership", "pricing", "event", "training", "marketing", "other"] as const;
export type NewsVerdict = "new" | "covered" | "other";

export const NEWS_INTAKE_PROMPT: PromptDef = {
  name: "news-intake",
  title: "News intake (what is new on new and changed pages)",
  paragraphs: [
    [
      "We hold the list of what one company's product does for its users: every feature we know of. Since the list was made, pages of the company's website were added or changed. We want to know what the product can do now that the list does not hold.",
    ],
    [
      "Below are:",
      "- LIST: the features we hold. Each has a code, a name, what the company calls it, and what it does.",
      "- KNOWN INTEGRATIONS: the tools we already know the product connects to.",
      "- PAGES: the new and the changed pages. Each page has a code, its status, its kind, its title, its address and its text. A new page is given whole. Of a changed page only the text that changed is given, each part under the nearest heading above it on the page (\"[under: …]\"); the rest of that page is as it was and is not news.",
      "The kinds are:",
      PAGE_KINDS,
      "- blog post, news item: says what the company wants to be known for. Often it is not about what the product does.",
    ],
    ["Step 1. Find every feature the pages describe."],
    [FEATURE_IS],
    [
      "Step 2. For every feature found, search the LIST for the same feature: by what it does, never by its name. Companies rename, repackage and announce again what they already have.",
      "- The LIST holds it, under any name or wording: write it under on_the_list with the code of the item that holds it. Do not describe it.",
      "- It is only a detail of an item of the LIST, one that would not be a line of its own next to the lines that are there (one more option, a higher limit, a new look): it is on the list too, under that item.",
      "- Nothing on the LIST holds it: it is new. Write it under new_features.",
      "- It is only announced for the future, with no release stated (no date, no beta, no early access): it is not new yet. Put it under left_out.",
      "Be strict about what is new. A product manager who gets one false \"new\" stops reading; one who misses a real one finds out in a meeting.",
    ],
    ["Step 3. Describe every new feature in full, the way the features of the LIST were described."],
    [FEATURE_FIELDS, "- reason: one short sentence: why nothing on the LIST holds it. Name the closest item of the LIST and say what differs."],
    [
      NOT_A_FEATURE,
      "- News about people and hiring, about money (funding, revenue, an acquisition), about a partnership or a reseller deal, about an event; vision or opinion with nothing a user can do.",
      "For everything left out also write its type: hr, finance, partnership, pricing, event, training, marketing or other.",
    ],
    [INTEGRATIONS_BY_NAME, "List only the tools that are not among the KNOWN INTEGRATIONS."],
    [FOUND_MEANS_UNDERSTOOD],
    ["Under pages write one line for every page given: its code and, in a few words, what its text is about. Every page code comes back exactly once, also when the page holds nothing new."],
    ["Use only the page codes and the list codes given."],
  ],
};
export const NEWS_SYSTEM_PROMPT = promptText(NEWS_INTAKE_PROMPT);
/** Moves whenever the prompt's text moves, a shared block included. */
export const NEWS_VERSION = promptVersion(NEWS_INTAKE_PROMPT);

// ————— The list —————

export interface NewsListItem {
  /** F1, F2 … */
  code: string;
  /** The stored CompetitorItem, or null for a list that came from a file. */
  id: string | null;
  name: string;
  /** What the company calls it; "" when the list does not say. */
  companyName: string;
  /** What it does. */
  description: string;
}

export interface NewsList {
  features: NewsListItem[];
  /** Tool names we already know the product connects to. */
  integrations: string[];
}

export function codeList(features: Array<{ id: string | null; name: string; companyName?: string | null; description?: string | null }>, integrations: string[] = []): NewsList {
  return { features: features.map((f, i) => ({ code: `F${i + 1}`, id: f.id, name: f.name, companyName: f.companyName ?? "", description: f.description ?? "" })), integrations };
}

// ————— The pages —————

export interface NewsPage {
  url: string;
  title: string;
  /** The kind of page: release_notes | help | api_docs | product | pricing | news | blog … */
  kind: string;
  /** The date the page states, ISO, or null. */
  publishedAt: string | null;
  /** The page's current text, whole. */
  text: string;
  /** A CHANGED page: its text before the change. Not given (or null) = a new page. */
  previousText?: string | null;
}

export interface SentPage {
  /** P1, P2 … — one numbering for the whole batch. */
  code: string;
  status: "new" | "changed";
  page: NewsPage;
  /** What is sent: the whole text of a new page, the changed parts of a changed one. */
  sent: string;
}

const KIND_WORDS: Record<string, string> = { product: "product page", pricing: "pricing page", help: "help center", api_docs: "API docs", release_notes: "release note", blog: "blog post", news: "news item" };

/** The batch as requests: what is sent of each page, and which pages go together. A changed page with no new line is not sent. */
export function planRequests(pages: NewsPage[]): { requests: SentPage[][]; nothingNew: NewsPage[] } {
  const sent: SentPage[] = [];
  const nothingNew: NewsPage[] = [];
  for (const page of pages) {
    const changed = page.previousText != null;
    const part = changed ? changedText(page.previousText!, page.text)?.text ?? null : page.text;
    if (!part || !part.trim()) { nothingNew.push(page); continue; }
    sent.push({ code: `P${sent.length + 1}`, status: changed ? "changed" : "new", page, sent: part.length > NEWS_PAGE_MAX_CHARS ? part.slice(0, NEWS_PAGE_MAX_CHARS) : part });
  }
  const requests: SentPage[][] = [];
  let size = 0;
  for (const p of sent) {
    const last = requests[requests.length - 1];
    if (!last || last.length >= NEWS_REQUEST_MAX_PAGES || size + p.sent.length > NEWS_REQUEST_MAX_CHARS) { requests.push([p]); size = p.sent.length; }
    else { last.push(p); size += p.sent.length; }
  }
  return { requests, nothingNew };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The part of a request that every request of the batch repeats: the company and its list. */
export function renderList(company: string, list: NewsList): string {
  const lines = list.features.map((f) => `${f.code} | ${oneLine(f.name)}${f.companyName ? ` | ${oneLine(f.companyName)}` : ""}${f.description ? ` — ${oneLine(f.description)}` : ""}`);
  return `COMPANY: ${oneLine(company)}\n\nLIST (${list.features.length} features):\n${lines.join("\n")}\n\nKNOWN INTEGRATIONS: ${list.integrations.length ? list.integrations.map(oneLine).join(", ") : NONE}`;
}

export function renderPages(pages: SentPage[]): string {
  return `PAGES (${pages.length}):\n\n${pages.map((p) => `=== ${p.code} | ${p.status} | ${KIND_WORDS[p.page.kind] ?? p.page.kind} | ${oneLine(p.page.title)} | ${p.page.url}${p.page.publishedAt ? ` | dated ${p.page.publishedAt.slice(0, 10)}` : ""}\n${p.sent}`).join("\n\n")}`;
}

// ————— The answer form —————

/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
const MAX_ENUM = 120;
const S = { type: "string" };
const list = (items: unknown) => ({ type: "array", items });
/** Every field is required (a schema with optional fields lets the model close its answer early — found 2026-11-20). */
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });

export function newsTool(features: NewsListItem[], pages: SentPage[]): Record<string, unknown> {
  const closed = (values: string[]) => (values.length <= MAX_ENUM ? { type: "string", enum: values } : S);
  const page = closed(pages.map((p) => p.code));
  const item = closed(features.map((f) => f.code));
  const feature = obj({
    name: S,
    company_name: S,
    problem: S,
    problem_source: { type: "string", enum: ["stated", "worked out"] },
    how_it_works: S,
    users: list(obj({ name: S, kind: { type: "string", enum: ["person", "agent"] } })),
    workflows: list(obj({ workflow: S, step: S })),
    evidence: list(obj({ quote: S, page, strength: { type: "string", enum: ["explains", "describes", "names"] } })),
    reason: S,
  });
  return {
    name: "report_news",
    description: "What the pages add to the list, and what was left out. Every field is required: write an empty list where a list does not apply.",
    input_schema: obj({
      pages: list(obj({ page, about: S })),
      new_features: list(feature),
      on_the_list: list(obj({ label: S, item, page, reason: S })),
      integrations: list(obj({ tool: S, page })),
      not_understood: list(obj({ label: S, page, missing: S })),
      left_out: list(obj({ label: S, page, reason: S, type: { type: "string", enum: [...LEFT_OUT_TYPES] } })),
    }),
  };
}

// ————— The answer, checked —————

export interface NewsEvidence {
  /** The quote as it is on the page. */
  quote: string;
  url: string;
  title: string;
  kind: string;
  /** "explains" | "describes" | "names" */
  strength: string;
}

export interface NewsPiece {
  verdict: NewsVerdict;
  /** verdict "other": a left-out type, "integration" (a tool name) or "not_understood" (named, not explained). */
  otherType: string | null;
  /** A feature: the plain name any company could use. Other news: its label. */
  name: string;
  /** A new feature: what this company calls it. */
  companyName: string | null;
  /** A new feature: how it works. Other news: why it was left out, or what is missing. */
  what: string;
  /** A new feature: the user's problem it solves ("Without it, …"), and whether a page states it. */
  problem: string | null;
  problemSource: string | null;
  /** Users as one line (an agent is marked), workflows as one line ("workflow — step; …"). */
  audience: string | null;
  workflows: string | null;
  /** A new feature: every quote that is on its page, the strongest first. */
  evidence: NewsEvidence[];
  /** The strongest quote, or null when none of the claimed quotes is on its page. */
  quote: string | null;
  quoteOk: boolean;
  reason: string;
  /** verdict "covered": the item of the list that holds it. */
  covered: NewsListItem | null;
  /** The page it stands on (a new feature: the page of its strongest evidence). */
  page: SentPage;
}

export interface ParsedNews {
  pieces: NewsPiece[];
  /** What each page's text is about, by page code. */
  about: Map<string, string>;
  /** Page codes given that the answer did not report: the answer is not complete. */
  unanswered: string[];
  /** Things left out: no name, a page code or a list code that was not given. */
  dropped: number;
}

const STRENGTH: Record<string, number> = { explains: 3, describes: 2, names: 1 };

/** The answer, checked field by field. A parser never throws on a bad piece: it drops it and counts it. */
export function parseNews(value: unknown, list: NewsList, pages: SentPage[]): ParsedNews {
  const v = (value ?? {}) as Record<string, unknown>;
  const pageOf = new Map(pages.map((p) => [p.code, p]));
  const itemOf = new Map(list.features.map((f) => [f.code, f]));
  const known = new Set(list.integrations.map((t) => t.trim().toLowerCase()));
  const pieces: NewsPiece[] = [];
  const about = new Map<string, string>();
  let dropped = 0;
  const rec = (raw: unknown) => (raw ?? {}) as Record<string, unknown>;
  const blank = { companyName: null, problem: null, problemSource: null, audience: null, workflows: null, evidence: [] as NewsEvidence[], quote: null, quoteOk: true, covered: null };

  for (const raw of arr(v.pages)) {
    const p = rec(raw);
    const code = str(p.page, 12);
    if (pageOf.has(code) && !about.has(code)) about.set(code, str(p.about, 200));
  }

  for (const raw of arr(v.new_features)) {
    const p = rec(raw);
    const name = str(p.name, 120);
    const what = str(p.how_it_works, 500);
    if (!name || !what) { dropped++; continue; }
    const claimed = arr(p.evidence).map(rec).map((e) => ({ quote: str(e.quote, 600), page: pageOf.get(str(e.page, 12)), strength: str(e.strength, 12) })).filter((e) => e.page);
    if (claimed.length === 0) { dropped++; continue; }
    const evidence: NewsEvidence[] = [];
    for (const e of claimed) {
      // A quote is on the page when the page's whole current text holds it (of a changed page only a part was sent).
      const quote = e.quote ? verifyQuote(e.quote, e.page!.page.text) : null;
      if (quote) evidence.push({ quote, url: e.page!.page.url, title: e.page!.page.title, kind: e.page!.page.kind, strength: e.strength in STRENGTH ? e.strength : "names" });
    }
    evidence.sort((a, b) => (STRENGTH[b.strength] ?? 0) - (STRENGTH[a.strength] ?? 0));
    const users = arr(p.users).map(rec).map((u) => ({ name: str(u.name, 80), agent: u.kind === "agent" })).filter((u) => u.name);
    const workflows = arr(p.workflows).map(rec).map((w) => ({ workflow: str(w.workflow, 160), step: str(w.step, 160) })).filter((w) => w.workflow);
    const first = evidence[0];
    pieces.push({
      verdict: "new",
      otherType: null,
      name,
      companyName: str(p.company_name, 200) || null,
      what,
      problem: str(p.problem, 400) || null,
      problemSource: p.problem_source === "stated" ? "stated" : "worked out",
      audience: users.length ? users.map((u) => (u.agent ? `${u.name} (agent)` : u.name)).join(", ") : null,
      workflows: workflows.length ? workflows.map((w) => (w.step ? `${w.workflow} — ${w.step}` : w.workflow)).join("; ") : null,
      evidence,
      quote: first?.quote ?? null,
      quoteOk: evidence.length > 0,
      reason: str(p.reason, 300),
      covered: null,
      page: first ? pages.find((x) => x.page.url === first.url)! : claimed[0].page!,
    });
  }

  for (const raw of arr(v.on_the_list)) {
    const p = rec(raw);
    const name = str(p.label, 120);
    const page = pageOf.get(str(p.page, 12));
    const covered = itemOf.get(str(p.item, 12));
    if (!name || !page || !covered) { dropped++; continue; }
    pieces.push({ ...blank, verdict: "covered", otherType: null, name, what: "", reason: str(p.reason, 300), covered, page });
  }

  for (const raw of arr(v.left_out)) {
    const p = rec(raw);
    const name = str(p.label, 120);
    const page = pageOf.get(str(p.page, 12));
    if (!name || !page) { dropped++; continue; }
    const type = str(p.type, 20);
    const reason = str(p.reason, 300);
    pieces.push({ ...blank, verdict: "other", otherType: (LEFT_OUT_TYPES as readonly string[]).includes(type) ? type : "other", name, what: reason, reason, page });
  }

  for (const raw of arr(v.integrations)) {
    const p = rec(raw);
    const name = str(p.tool, 120);
    const page = pageOf.get(str(p.page, 12));
    if (!name || !page) { dropped++; continue; }
    // A tool we already know of is not news of any kind.
    if (known.has(name.toLowerCase())) continue;
    pieces.push({ ...blank, verdict: "other", otherType: "integration", name, what: "", reason: "", page });
  }

  for (const raw of arr(v.not_understood)) {
    const p = rec(raw);
    const name = str(p.label, 120);
    const page = pageOf.get(str(p.page, 12));
    if (!name || !page) { dropped++; continue; }
    const missing = str(p.missing, 300);
    pieces.push({ ...blank, verdict: "other", otherType: "not_understood", name, what: missing, reason: missing, page });
  }

  return { pieces, about, unanswered: pages.filter((p) => !about.has(p.code)).map((p) => p.code), dropped };
}

/** A new ability in one phrase, no label: the problem it solves, then how it solves it (the email and the feed). */
export function abilityPhrase(r: { problem: string | null; what: string }): string {
  const problem = (r.problem ?? "").trim();
  return [problem && !/[.!?]$/.test(problem) ? `${problem}.` : problem, r.what.trim()].filter(Boolean).join(" ");
}
