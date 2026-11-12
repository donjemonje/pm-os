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
 * A finding's tier and kind are computed when the cell is filled, from its page's place in the competitor's reading
 * plan (sections.ts: the section's label → tier and kind) — editing the label rules changes cells on the next run
 * with no page read again.
 * A PM's correction wins at read time and is never touched here.
 *
 * Pure: no database, no network.
 */

export interface Evidence {
  findingId: string;
  pageUrl: string;
  tier: "strong" | "weak";
  /** The page's kind (sections.ts LABEL_RULES): pricing, docs, product, content, news … */
  pageKind: string;
  origin: "research" | "second_look";
  quote: string;
  reasoning: string;
  /** The competitor's own name for it. */
  wording: string;
  /** One plain sentence of what it does, from the finding's page; null when the page did not say. */
  description: string | null;
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
  /** What it does: the description of the best-ranked evidence that has one. */
  description: string | null;
}

/** The description of the best-ranked finding that has one; null when none has. `ranked` is in rankEvidence order. */
export function bestDescription(ranked: Array<Pick<Evidence, "description">>): string | null {
  return ranked.find((e) => e.description?.trim())?.description?.trim() ?? null;
}

export function cellFromEvidence(list: Evidence[]): CellFromEvidence {
  if (list.length === 0) return { value: "not_found", best: null, count: 0, description: null };
  const ranked = rankEvidence(list);
  return { value: ranked[0].tier === "strong" ? "found" : "low", best: ranked[0], count: new Set(list.map((e) => e.pageUrl)).size, description: bestDescription(ranked) };
}
