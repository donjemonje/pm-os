import type { StatusValue } from "../config";
import { KIND_RANK } from "./kinds";

/**
 * The cell rules (Capability Analysis, "How the analysis runs"). PMOS AI never decides a cell: the table is filled
 * in code, from the evidence, by these rules — the whole of it:
 *
 *   at least one finding from a strong page   → found
 *   findings, all from weak pages             → low (low confidence)
 *   none (after the second look found nothing) → not_found
 *
 * A finding's tier is computed when the cell is filled, from its page's address and source with the current page
 * kinds (kinds.ts) — editing the kind lists changes cells on the next run with no page read again.
 * A PM's correction wins at read time and is never touched here.
 *
 * Pure: no database, no network.
 */

export interface Evidence {
  findingId: string;
  pageUrl: string;
  tier: "strong" | "weak";
  /** The page's kind (kinds.ts): pricing, docs, product, content, news … */
  pageKind: string;
  origin: "research" | "second_look";
  quote: string;
  reasoning: string;
  /** The competitor's own name for it. */
  wording: string;
}

const kindRank = (kind: string) => {
  const i = KIND_RANK.indexOf(kind);
  return i < 0 ? KIND_RANK.length : i;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Best first: strong before weak; then the page kind (pricing, docs, product …); research before second look; then the address; then the finding. */
export function rankEvidence(list: Evidence[]): Evidence[] {
  return [...list].sort(
    (a, b) =>
      Number(a.tier === "weak") - Number(b.tier === "weak") ||
      kindRank(a.pageKind) - kindRank(b.pageKind) ||
      Number(a.origin === "second_look") - Number(b.origin === "second_look") ||
      cmp(a.pageUrl, b.pageUrl) ||
      cmp(a.findingId, b.findingId),
  );
}

export interface CellFromEvidence {
  value: StatusValue;
  /** The evidence shown on the cell. */
  best: Evidence | null;
  /** Distinct pages that carry evidence. */
  count: number;
}

export function cellFromEvidence(list: Evidence[]): CellFromEvidence {
  if (list.length === 0) return { value: "not_found", best: null, count: 0 };
  const ranked = rankEvidence(list);
  return { value: ranked[0].tier === "strong" ? "found" : "low", best: ranked[0], count: new Set(list.map((e) => e.pageUrl)).size };
}
