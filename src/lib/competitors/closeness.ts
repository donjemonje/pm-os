/**
 * How close a competitor is to the org's capability list, from the matrix alone:
 * the share of the org's active capabilities the competitor has (a partial counts
 * half). Pure, so the strip card and tests share one definition.
 */
import type { StatusValue } from "./config";

export interface Closeness {
  /** 0–100, or null when the org has no capabilities. */
  score: number | null;
  has: number;
  partial: number;
  total: number;
}

export function closenessOf(capabilityIds: readonly string[], valueOf: (capabilityId: string) => StatusValue | undefined): Closeness {
  let has = 0;
  let partial = 0;
  for (const id of capabilityIds) {
    const v = valueOf(id);
    if (v === "has") has++;
    else if (v === "partial") partial++;
  }
  const total = capabilityIds.length;
  return { score: total ? Math.round(((has + partial * 0.5) / total) * 100) : null, has, partial, total };
}

/** Competitors ranked closest first; ties keep the given order (the matrix column order). */
export function rankByCloseness<T extends { id: string }>(competitors: readonly T[], capabilityIds: readonly string[], valueOf: (competitorId: string, capabilityId: string) => StatusValue | undefined): Array<{ competitor: T; closeness: Closeness }> {
  return competitors
    .map((competitor) => ({ competitor, closeness: closenessOf(capabilityIds, (k) => valueOf(competitor.id, k)) }))
    .sort((a, b) => (b.closeness.score ?? -1) - (a.closeness.score ?? -1));
}
