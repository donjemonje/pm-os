import { createHash } from "node:crypto";
import { normalizeForQuote } from "./quotes";
import { LOOK_VERSION } from "./prompts";

/**
 * The second look (Capability Analysis, "How the analysis runs"): for a capability of ours that got no match at a
 * competitor, PMOS AI is shown the pages most likely to mention it and asked once. Only after it finds nothing
 * does the cell say not found. Which pages are shown is decided here, in code.
 *
 * Pure: no database, no network.
 */

export const LOOK_MAX_PAGES = 4;
export const LOOK_MAX_CHARS = 80_000;

/** Words that say nothing about which capability it is. */
const STOP_WORDS = new Set(["and", "the", "for", "with", "of", "to", "in", "a", "an", "management", "platform", "solution", "service"]);

export interface LookPage {
  id: string;
  url: string;
  title: string;
  text: string;
  hash: string;
}

/** A page with its title, address path and text normalized once (many capabilities are scored against the same pages). */
export interface IndexedPage extends LookPage {
  nTitle: string;
  nPath: string;
  nText: string;
}

function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

export function indexPages(pages: LookPage[]): IndexedPage[] {
  return pages.map((p) => ({ ...p, nTitle: normalizeForQuote(p.title), nPath: normalizeForQuote(pathOf(p.url).replace(/[-_/.]+/g, " ")), nText: normalizeForQuote(p.text) }));
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** How likely a page is to mention the capability: its name or an alias as a whole (title 20, address 15, text 10), and each of their words (title 3, address 2, text 1 per occurrence up to 5). */
export function scorePage(terms: string[], page: IndexedPage): number {
  let score = 0;
  const words = new Set<string>();
  for (const term of terms) {
    const t = normalizeForQuote(term);
    if (!t) continue;
    if (page.nTitle.includes(t)) score += 20;
    if (page.nPath.includes(t.replace(/[-_/.]+/g, " "))) score += 15;
    if (page.nText.includes(t)) score += 10;
    for (const w of t.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !STOP_WORDS.has(w)) words.add(w);
  }
  for (const w of words) {
    if (page.nTitle.includes(w)) score += 3;
    if (page.nPath.includes(w)) score += 2;
    score += Math.min(5, occurrences(page.nText, w));
  }
  return score;
}

/**
 * The pages shown for a capability: scored in code, best first (ties by address); pages are taken in that order
 * while their text fits 80,000 characters in all, at most 4. The first page is always taken, cut when it alone is
 * larger. No page scores → no page (and no call).
 */
export function pagesFor(capability: { name: string; aliases: string[] }, pages: IndexedPage[], opts: { maxPages?: number; maxChars?: number } = {}): LookPage[] {
  return selectLookPages(capability, pages, opts).pages;
}

export interface LookSelection {
  /** The pages shown. */
  pages: LookPage[];
  /** Pages that scored above zero: the candidates. */
  candidates: number;
  /** Candidates not shown because the look already had its most pages (LOOK_MAX_PAGES). */
  leftByPages: number;
  /** Candidates not shown because their text did not fit (LOOK_MAX_CHARS) — and the first page, when it alone was larger and was cut. */
  leftByChars: number;
}

/** pagesFor, with what its two limits left out — a look that could not show every candidate page hit a cap (caps.ts). */
export function selectLookPages(capability: { name: string; aliases: string[] }, pages: IndexedPage[], opts: { maxPages?: number; maxChars?: number } = {}): LookSelection {
  const maxPages = opts.maxPages ?? LOOK_MAX_PAGES;
  const maxChars = opts.maxChars ?? LOOK_MAX_CHARS;
  const terms = [capability.name, ...capability.aliases];
  const scored = pages
    .map((p) => ({ p, score: scorePage(terms, p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.p.url < b.p.url ? -1 : a.p.url > b.p.url ? 1 : 0));
  const out: LookPage[] = [];
  let chars = 0;
  let leftByPages = 0;
  let leftByChars = 0;
  for (let i = 0; i < scored.length; i++) {
    const { p } = scored[i];
    if (out.length >= maxPages) {
      leftByPages = scored.length - i;
      break;
    }
    if (out.length === 0) {
      out.push({ id: p.id, url: p.url, title: p.title, hash: p.hash, text: p.text.length > maxChars ? p.text.slice(0, maxChars) : p.text });
      if (p.text.length > maxChars) leftByChars++;
      chars = Math.min(p.text.length, maxChars);
      continue;
    }
    if (chars + p.text.length > maxChars) {
      leftByChars += scored.length - i;
      break;
    }
    out.push({ id: p.id, url: p.url, title: p.title, hash: p.hash, text: p.text });
    chars += p.text.length;
  }
  return { pages: out, candidates: scored.length, leftByPages, leftByChars };
}

/**
 * What a second look was asked with. The same key = the same question about the same pages: it is not asked again.
 * It changes with the prompt version, the model, the capability's name, description or aliases, its domain's name
 * or definition, and which pages were chosen — not with their order, and not with their text: a page whose text
 * changed is read again by the research step, which finds what the new text offers; asking every look that showed
 * the page once more would cost a call per capability for every edited page.
 */
export function lookKey(
  capability: { name: string; description: string; aliases: string[] },
  domain: { name: string; description: string },
  pages: Array<{ id: string }>,
  model: string,
): string {
  const payload = JSON.stringify([LOOK_VERSION, model, capability.name, capability.description, [...capability.aliases].sort(), domain.name, domain.description, pages.map((p) => p.id).sort()]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * The limit on second looks per run (CompetitorsConfig.secondLooksPerRun): the to-do in its order, cut at what the
 * run may still ask. `asked` = the looks this run already made (a run that continues counts what it did before it
 * stopped). What is left over waits for the competitor's next run — its cell is not written until it was looked at.
 */
export function capLooks<T>(todo: T[], asked: number, perRun: number): { now: T[]; later: T[] } {
  const room = Math.max(0, Math.floor(perRun) - Math.max(0, asked));
  return { now: todo.slice(0, room), later: todo.slice(room) };
}
