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
 * Which findings are a cell's evidence (evidenceByRow): a company has a capability row when it has its OWN
 * capability on it OR ANY FEATURE under it — the cell's proof is that item's quote. A feature row's mark is the
 * company's own feature on it. A second look's finding answers the row it was asked about.
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
  /** "reading" = the proof of an item of the company's list; "second_look" = a row of ours a second look found. */
  origin: "reading" | "second_look";
  quote: string;
  /** No longer written (the description covers it): "" for every finding of the chunked reading; an old finding still carries one. */
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

/** A finding as the evidence rule sees it: what it proves (an item of the company's list, matched to a row of ours — or, for a second look, the row it answers) and the evidence it is. */
export interface RowFinding {
  evidence: Evidence;
  /** The saved match of the item it proves; null for a second look's finding. */
  item: { capabilityId: string | null; featureId: string | null } | null;
  /** A second look's finding: the capability of ours it answers. */
  lookCapabilityId: string | null;
}

export interface EvidenceMaps {
  byCapability: Map<string, Evidence[]>;
  byFeature: Map<string, Evidence[]>;
}

/**
 * The evidence of every row, from a company's findings — the cell rule's first half:
 *   - an item matched to a capability of ours proves that capability's cell;
 *   - an item matched to a feature of ours proves that feature's mark AND the cell of the capability the feature is
 *     under (`capabilityOfFeature`: active features only) — a company that has any feature of a row has the row;
 *   - a second look's finding proves the capability it was asked about.
 */
export function evidenceByRow(findings: RowFinding[], capabilityOfFeature: ReadonlyMap<string, string>): EvidenceMaps {
  const out: EvidenceMaps = { byCapability: new Map(), byFeature: new Map() };
  const add = (map: Map<string, Evidence[]>, id: string, e: Evidence) => map.set(id, [...(map.get(id) ?? []), e]);
  for (const f of findings) {
    if (f.evidence.origin === "second_look") {
      if (f.lookCapabilityId) add(out.byCapability, f.lookCapabilityId, f.evidence);
    } else if (f.item?.capabilityId) {
      add(out.byCapability, f.item.capabilityId, f.evidence);
    } else if (f.item?.featureId) {
      add(out.byFeature, f.item.featureId, f.evidence);
      const capabilityId = capabilityOfFeature.get(f.item.featureId);
      if (capabilityId) add(out.byCapability, capabilityId, f.evidence);
    }
  }
  return out;
}

/** Best first: strong before weak; then the page kind (pricing, docs, product …); the reading before a second look; then the address; then the finding. */
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
