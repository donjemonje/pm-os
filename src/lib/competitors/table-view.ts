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
 * The winners of a scored row — their numbers are underlined: the highest score among the companies shown (the
 * organization included). Ties are all winners. A row whose highest score is 0 has none, and a cell with no score is never one.
 */
export function topScoreKeys(cells: ReadonlyArray<{ key: string; score: number | null | undefined }>): Set<string> {
  const scored = cells.filter((c): c is { key: string; score: number } => typeof c.score === "number");
  const max = Math.max(0, ...scored.map((c) => c.score));
  return new Set(max > 0 ? scored.filter((c) => c.score === max).map((c) => c.key) : []);
}

/** The colour of a score's number: six steps from gray (0) to green (5). */
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

/**
 * What a domain's header says about its rows: how many are gaps and how many only the organization has. The kind of
 * each row is the row's own rule (a scored row: scores.ts scoreRowKind; a row without scores: found / not found).
 */
export function rowKindCounts(kinds: ReadonlyArray<"gap" | "only" | "level" | "none">): { gaps: number; only: number } {
  return { gaps: kinds.filter((k) => k === "gap").length, only: kinds.filter((k) => k === "only").length };
}

/**
 * A feature row is a DIFFERENTIATOR when only the organization has the feature: its own mark is found and no
 * competitor's is — not found, not even with low confidence (a competitor with no cell on the row has not got it).
 * The same companies as the capability-level "only" rule: every competitor of the organization. Never with no
 * competitors: there is nobody to differ from.
 */
export function featureIsDifferentiator(own: string, theirs: ReadonlyArray<string | null | undefined>): boolean {
  return theirs.length > 0 && own === "found" && theirs.every((v) => v !== "found" && v !== "low");
}

/** Where a floating card goes: its corner, the height it may take, and the side of its anchor it opened on. */
export interface CardPlacement {
  top: number;
  left: number;
  /** The card is never taller than this; a longer card scrolls inside. */
  maxHeight: number;
  side: "below" | "above";
}

/**
 * The place of a floating card (Floating.tsx), from what is on screen now — all in window (viewport) pixels, so "the
 * bottom" is the bottom of the visible window, however far the table or the page is scrolled:
 *   - below its anchor when the WHOLE card fits there;
 *   - else above it when the whole card fits there;
 *   - else on the side with more room, its height capped to that room (it scrolls inside).
 * `card.height` is the card's real, uncapped height, measured after it is drawn — and measured again whenever it
 * grows ("Show more", an editor opening), so a card that no longer fits below moves above.
 * Left-aligned with the anchor or centred on it, and kept inside the window sideways.
 */
export function placeCard(anchor: { top: number; bottom: number; left: number; width: number }, card: { width: number; height: number }, win: { width: number; height: number }, align: "left" | "center" = "left", gap = 6, margin = 8): CardPlacement {
  const roomBelow = win.height - margin - (anchor.bottom + gap);
  const roomAbove = anchor.top - gap - margin;
  const side: "below" | "above" = card.height <= roomBelow ? "below" : card.height <= roomAbove ? "above" : roomAbove > roomBelow ? "above" : "below";
  // Never taller than the room on its side; and never taller than the window, also when the anchor itself is off screen.
  const maxHeight = Math.max(0, Math.min(side === "below" ? roomBelow : roomAbove, win.height - 2 * margin));
  const shown = Math.min(card.height, maxHeight);
  const wanted = side === "below" ? anchor.bottom + gap : anchor.top - gap - shown;
  const top = Math.max(margin, Math.min(wanted, win.height - margin - shown));
  const left = Math.max(margin, Math.min(align === "center" ? anchor.left + anchor.width / 2 - card.width / 2 : anchor.left, win.width - card.width - margin));
  return { top, left, maxHeight, side };
}
