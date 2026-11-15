/**
 * What is due (Capability Analysis, "How the analysis runs"). An analysis run keeps no cursor: every step works on
 * a to-do list computed from the tables, so a run that stopped continues with exactly what is left.
 *
 * Pure: no database, no network.
 */

import { isLlmsTxt } from "./sections";

/** "<version>:<hash>" — what SourcePage.analyzedKey / factsKey hold: the prompt version and the text that was read. */
export function readKey(version: string, hash: string): string {
  return `${version}:${hash}`;
}

const byUrl = <T extends { url: string }>(a: T, b: T) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);

/**
 * The picked pages the research step still has to read, in address order: those whose analyzedKey is not the key
 * of their current text under the current prompt version. A page whose answer was unusable carries the current
 * key too (it is asked again only when its text or the prompt changes).
 */
export function researchTodo<T extends { url: string; hash: string; analyzedKey: string | null }>(picked: T[], version: string): T[] {
  return picked.filter((p) => p.analyzedKey !== readKey(version, p.hash)).sort(byUrl);
}

/**
 * Unusable answers on a few pages are the pages' problem; on many they are the model's or the prompt's:
 * more than max(5, 5% of the to-do) fails the run.
 */
export function tooManyFailed(failed: number, todo: number): boolean {
  return failed > Math.max(5, todo * 0.05);
}

/** The stored pages the facts step still has to read (every tier), in address order. */
export function factsTodo<T extends { url: string; hash: string; factsKey: string | null; state: string; hasText: boolean }>(pages: T[], version: string): T[] {
  // The site's /llms.txt is stored for the map step only (sections.ts isLlmsTxt): it is never read as a page.
  return pages.filter((p) => p.state !== "removed" && p.hasText && !isLlmsTxt(p.url) && p.factsKey !== readKey(version, p.hash)).sort(byUrl);
}

/**
 * The sources whose first facts read this is: a source with no page that was ever read for facts. What such a read
 * finds is the baseline, not news.
 */
export function factsBaselineSources(sourceIds: string[], pages: Array<{ sourceId: string; factsKey: string | null }>): string[] {
  const read = new Set(pages.filter((p) => p.factsKey != null).map((p) => p.sourceId));
  return sourceIds.filter((id) => !read.has(id));
}

/**
 * The facts baseline a run inherits. A run that stopped in the middle of the facts step (it failed, it was
 * cancelled) left some pages of a first-read source unread — and the pages it did read now carry a factsKey, so
 * factsBaselineSources() alone would call the rest "news". The next run therefore takes the baseline over from the
 * competitor's last unfinished run: `earlier` is the competitor's other runs, newest first; the first one that
 * decided a baseline hands it on, unless a run that finished ("done": every page was read) comes before it.
 */
export function carriedFactsBaseline(earlier: Array<{ status: string; cursor: unknown }>): string[] {
  for (const run of earlier) {
    if (run.status === "done") return [];
    const cursor = run.cursor && typeof run.cursor === "object" && !Array.isArray(run.cursor) ? (run.cursor as Record<string, unknown>) : {};
    const list = cursor.factsBaselineSources;
    if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/** The baseline of a run: the sources never read for facts, plus the inherited ones that still exist. No source twice. */
export function factsBaseline(sourceIds: string[], pages: Array<{ sourceId: string; factsKey: string | null }>, carried: string[]): string[] {
  const known = new Set(sourceIds);
  return [...new Set([...factsBaselineSources(sourceIds, pages), ...carried.filter((id) => known.has(id))])];
}

/**
 * The rows of ours made from a competitor's items that the other competitors were not yet asked about: those made
 * after the competitor's last finished run (`since` = that run's appliedAt; null = it never finished one, so all of
 * them). Read from the tables at the end of every apply step — nothing is remembered in the process, so a run that
 * crashed or failed after making a row still gets its follow-up runs.
 */
export function rowsSince<T extends { createdAt: Date }>(rows: T[], since: Date | null): T[] {
  return since ? rows.filter((r) => r.createdAt.getTime() > since.getTime()) : rows;
}
