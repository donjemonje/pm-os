/**
 * What is due (Capability Analysis, "How the analysis runs"). An analysis run keeps no cursor: every step works on
 * a to-do list computed from the tables, so a run that stopped continues with exactly what is left.
 *
 * Pure: no database, no network.
 */

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
  return pages.filter((p) => p.state !== "removed" && p.hasText && p.factsKey !== readKey(version, p.hash)).sort(byUrl);
}

/**
 * The sources whose first facts read this is: a source with no page that was ever read for facts. What such a read
 * finds is the baseline, not news.
 */
export function factsBaselineSources(sourceIds: string[], pages: Array<{ sourceId: string; factsKey: string | null }>): string[] {
  const read = new Set(pages.filter((p) => p.factsKey != null).map((p) => p.sourceId));
  return sourceIds.filter((id) => !read.has(id));
}
