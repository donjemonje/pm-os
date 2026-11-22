/**
 * How close a competitor is to the org's capability list, from the matrix alone:
 * the share of the org's active capabilities found at the competitor (a
 * low-confidence find counts half). Pure, so the strip card and tests share one definition.
 */
import type { StatusValue } from "./config";
import { proximityOfScores } from "./scores";

export interface Closeness {
  /** 0–100, or null when the org has no capabilities. */
  score: number | null;
  found: number;
  low: number;
  total: number;
}

/**
 * `scoreOf` (the coverage model, scores.ts): when the capabilities carry scores 0-5 for this competitor, closeness is
 * the average score across the scored capabilities on the same 0-100 scale, instead of the share found. `found` then
 * counts the capabilities scored above 0. Capabilities with no score fall back to the found / low rule only when
 * none is scored.
 */
export function closenessOf(capabilityIds: readonly string[], valueOf: (capabilityId: string) => StatusValue | undefined, scoreOf?: (capabilityId: string) => number | null | undefined): Closeness {
  let found = 0;
  let low = 0;
  for (const id of capabilityIds) {
    const v = valueOf(id);
    if (v === "found") found++;
    else if (v === "low") low++;
  }
  const total = capabilityIds.length;
  const byScore = scoreOf ? proximityOfScores(capabilityIds.map((id) => scoreOf(id))) : null;
  if (byScore !== null) return { score: byScore, found, low, total };
  return { score: total ? Math.round(((found + low * 0.5) / total) * 100) : null, found, low, total };
}

/** Competitors ranked closest first; ties keep the given order (the matrix column order). */
export function rankByCloseness<T extends { id: string }>(competitors: readonly T[], capabilityIds: readonly string[], valueOf: (competitorId: string, capabilityId: string) => StatusValue | undefined, scoreOf?: (competitorId: string, capabilityId: string) => number | null | undefined): Array<{ competitor: T; closeness: Closeness }> {
  return competitors
    .map((competitor) => ({ competitor, closeness: closenessOf(capabilityIds, (k) => valueOf(competitor.id, k), scoreOf ? (k) => scoreOf(competitor.id, k) : undefined) }))
    .sort((a, b) => (b.closeness.score ?? -1) - (a.closeness.score ?? -1));
}

/** The Offering Proximity card shows at most this many companies. */
export const PROXIMITY_SHOWN = 6;

/**
 * The companies the Offering Proximity card shows, from a list ranked closest first (Daniel 2026-11-22): all of them
 * when there are six or fewer; with more, the two closest, the two in the middle of the ranking and the two farthest,
 * kept in ranking order.
 */
export function proximityPicks<T>(ranked: readonly T[]): T[] {
  if (ranked.length <= PROXIMITY_SHOWN) return [...ranked];
  const mid = Math.floor(ranked.length / 2);
  return [...ranked.slice(0, 2), ...ranked.slice(mid - 1, mid + 1), ...ranked.slice(-2)];
}
