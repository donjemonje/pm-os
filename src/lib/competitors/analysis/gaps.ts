import { scorePage, type IndexedPage } from "./secondlook";

/**
 * Gaps, and going back for them (Capability Analysis, "Map, read, go back").
 *
 * The broad read covers the product, pricing and compare pages and the index pages of help, release notes and API
 * docs. After the match, code checks every capability item of the competitor that is in the table. It has a gap
 * when one of these is true — each a plain yes/no:
 *
 *   g1  it has no description, or every finding that gives it one is on a product or compare page (marketing only)
 *   g2  it has no feature
 *   g3  one of its features has no description
 *   (g4 a capability of OURS has no match at this competitor — that is the second look, analysis/secondlook.ts)
 *
 * For each item with a gap the run goes back: it picks the unread deep pages most likely to be about the item
 * (the second look's scoring, with the item's name and wordings), reads them with the normal research call, then
 * merges and matches again. At most GO_BACK_MAX_ROUNDS rounds per run, at most GO_BACK_PAGES_PER_ITEM pages per
 * item per round, a page is picked once. No unread deep page scores above zero → nothing to do for that item.
 * What is still open after the rounds stays as it is.
 *
 * Pure: no database, no network.
 */

/** Rounds of going back one run makes at most. */
export const GO_BACK_MAX_ROUNDS = 2;
/** Deep pages picked for one item in one round at most. */
export const GO_BACK_PAGES_PER_ITEM = 3;
/** Page kinds that are marketing (sections.ts LABEL_RULES: product → "product", compare → "content"): a description from these alone leaves gap g1 open. */
export const MARKETING_KINDS: readonly string[] = ["product", "content"];

export interface GapFinding {
  description: string | null;
  /** The kind of the finding's page (kinds.ts KIND_RANK: pricing, docs, product, content, news). */
  pageKind: string;
}

export interface GapItem {
  /** The findings of the capability item itself. */
  findings: GapFinding[];
  /** Its feature items, each with its findings. */
  features: Array<{ findings: GapFinding[] }>;
}

const described = (f: GapFinding) => Boolean(f.description?.trim());

/** g1: no description, or marketing pages only give it one. */
export function gapNoDescription(item: Pick<GapItem, "findings">): boolean {
  const withDescription = item.findings.filter(described);
  return withDescription.length === 0 || withDescription.every((f) => MARKETING_KINDS.includes(f.pageKind));
}

/** g2: no feature. */
export function gapNoFeature(item: Pick<GapItem, "features">): boolean {
  return item.features.length === 0;
}

/** g3: one of its features has no description (from any page). */
export function gapFeatureWithoutDescription(item: Pick<GapItem, "features">): boolean {
  return item.features.some((f) => !f.findings.some(described));
}

export function gapsOf(item: GapItem): { g1: boolean; g2: boolean; g3: boolean } {
  return { g1: gapNoDescription(item), g2: gapNoFeature(item), g3: gapFeatureWithoutDescription(item) };
}

export function hasGap(item: GapItem): boolean {
  const g = gapsOf(item);
  return g.g1 || g.g2 || g.g3;
}

/**
 * Is the run to go back for this item at all? Only when something about it is new since a run last went back for
 * its gaps to the end: it was never checked, or it (or one of its features) got a finding after that moment. So a
 * run with nothing new to read — a capability a PM added, another competitor's new row — reads nothing here, and
 * an item whose gap stayed open after the rounds is not read for again and again by every later run.
 */
export function dueForGoBack(item: { gapCheckedAt: Date | null; newestFindingAt: Date | null }): boolean {
  if (item.gapCheckedAt == null) return true;
  return item.newestFindingAt != null && item.newestFindingAt.getTime() > item.gapCheckedAt.getTime();
}

export interface GoBackItem {
  id: string;
  /** CompetitorItem.key — the order items pick in. */
  key: string;
  /** Its name and wordings: what the pages are scored against. */
  terms: string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The deep pages one item goes back to: the pages that score above zero for its terms (secondlook.ts scorePage),
 * best first (ties by address), at most `perItem`, never a page in `taken`. The pages it picks are added to `taken`.
 */
export function pickForItem(item: GoBackItem, pages: IndexedPage[], taken: Set<string>, perItem: number = GO_BACK_PAGES_PER_ITEM): string[] {
  return pickForItemCounted(item, pages, taken, perItem).picked;
}

/** pickForItem, with how many pages scored for the item: more than it may pick = the per-item limit left likely pages unread (caps.ts). */
export function pickForItemCounted(item: GoBackItem, pages: IndexedPage[], taken: Set<string>, perItem: number = GO_BACK_PAGES_PER_ITEM): { picked: string[]; candidates: number } {
  const scored: Array<{ id: string; url: string; score: number }> = [];
  for (const p of pages) {
    if (taken.has(p.id)) continue;
    const score = scorePage(item.terms, p);
    if (score > 0) scored.push({ id: p.id, url: p.url, score });
  }
  scored.sort((a, b) => b.score - a.score || cmp(a.url, b.url));
  const picked = scored.slice(0, Math.max(0, perItem)).map((s) => s.id);
  for (const id of picked) taken.add(id);
  return { picked, candidates: scored.length };
}

/**
 * One round of going back: the items in the order of their keys, each picking its pages from the unread deep pages
 * (`pages`); a page is picked once — the item that comes first keeps it, a later item takes its next best.
 * `taken` are pages earlier rounds already chose. Returns what each item picked (items that picked nothing are left
 * out) and all picked page ids in pick order.
 */
export function pickGoBackPages(items: GoBackItem[], pages: IndexedPage[], opts: { perItem?: number; taken?: Iterable<string> } = {}): { picks: Array<{ itemId: string; pageIds: string[] }>; pageIds: string[] } {
  const taken = new Set(opts.taken ?? []);
  const picks: Array<{ itemId: string; pageIds: string[] }> = [];
  for (const item of sortGoBackItems(items)) {
    const pageIds = pickForItem(item, pages, taken, opts.perItem ?? GO_BACK_PAGES_PER_ITEM);
    if (pageIds.length) picks.push({ itemId: item.id, pageIds });
  }
  return { picks, pageIds: picks.flatMap((p) => p.pageIds) };
}

/** The order items pick in: by key, then id. */
export function sortGoBackItems<T extends Pick<GoBackItem, "id" | "key">>(items: T[]): T[] {
  return [...items].sort((a, b) => cmp(a.key, b.key) || cmp(a.id, b.id));
}

/** The pages each round of a run chose, as saved in the run's cursor ({ goBack: { rounds: string[][] } }); [] when none was saved. */
export function savedGoBackRounds(cursor: Record<string, unknown>): string[][] {
  const goBack = cursor.goBack;
  if (!goBack || typeof goBack !== "object" || Array.isArray(goBack)) return [];
  const rounds = (goBack as Record<string, unknown>).rounds;
  if (!Array.isArray(rounds)) return [];
  return rounds.slice(0, GO_BACK_MAX_ROUNDS).map((r) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []));
}
