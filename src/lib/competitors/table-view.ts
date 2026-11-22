/**
 * How the Competitors table opens and marks its cells (Daniel 2026-11-22). Pure: no React, no database — the view and
 * the tests share one definition.
 */

/** When the page loads only the first domain's group is open; every other domain is closed (and no capability shows its features). */
export function defaultOpenDomains(domainIds: readonly string[]): string[] {
  return domainIds.slice(0, 1);
}

/** Every one of `ids` is open (false for an empty list). */
export function allOpen(ids: readonly string[], open: ReadonlySet<string>): boolean {
  return ids.length > 0 && ids.every((id) => open.has(id));
}

/**
 * "Close all / open all" over `ids`, leaving every other id of `open` as it is: when all of them are open they all
 * close, otherwise they all open.
 */
export function toggleAll(ids: readonly string[], open: ReadonlySet<string>): Set<string> {
  const next = new Set(open);
  if (allOpen(ids, open)) for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/**
 * The top cells of a scored row: the highest score among the companies shown (the organization included). Ties are
 * all top. A row whose highest score is 0 has no top, and a cell with no score is never one.
 */
export function topScoreKeys(cells: ReadonlyArray<{ key: string; score: number | null | undefined }>): Set<string> {
  const scored = cells.filter((c): c is { key: string; score: number } => typeof c.score === "number");
  const max = Math.max(0, ...scored.map((c) => c.score));
  return new Set(max > 0 ? scored.filter((c) => c.score === max).map((c) => c.key) : []);
}

/** The colour of a score's number and of its bar: six steps from gray (0) to green (5). */
export const SCORE_COLORS = ["#9aa8be", "#8aa69a", "#6fa287", "#4a9a70", "#27905c", "#0f7a47"] as const;

/** The step of a score on that scale: whole steps, never outside 0-5 (a domain's average is rounded to its nearest step). */
export function scoreStep(score: number): number {
  return Math.min(SCORE_COLORS.length - 1, Math.max(0, Math.round(score)));
}

export function scoreColor(score: number): string {
  return SCORE_COLORS[scoreStep(score)];
}

/**
 * While a card that was opened by a click is open, scrolling is caught: the page and the table do not move under it.
 * Scrolling INSIDE the card still works: this says whether a scrolling box of the card can still move by `deltaY`
 * (down when positive). At its end it cannot, and the scroll is caught there too, so it never passes on to the page.
 */
export function boxCanScroll(box: { scrollTop: number; clientHeight: number; scrollHeight: number }, deltaY: number): boolean {
  if (box.scrollHeight <= box.clientHeight) return false;
  return deltaY < 0 ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1;
}
