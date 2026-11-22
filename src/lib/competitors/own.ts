import type { OwnStatus } from "./config";

/**
 * The organization's OWN site — "the own source" (Capability Analysis, the setup run).
 *
 * The client's own website is stored like a competitor's site: a Competitor row flagged `isOwn`, with the same
 * page store, the same scanner, the same reading plan and the same research. It is NEVER shown or counted as a
 * competitor: every listing of competitors leaves it out (NOT_OWN / competitorsOnly below). One per workspace.
 *
 * What is found there is OURS: the own cell of a row (Capability.ourStatus / Feature.ourStatus) is "found" when an
 * item of the own source belongs to the row, "not found" otherwise — with no confidence — and the top evidence is
 * kept on the row (ourEvidence) for the hover. A value a PM set by hand is the truth and is never changed by a run.
 *
 * The organization's product lines (Settings → Product Lines) are part of the own material: before an analysis of
 * the own source they are written as ONE stored page of it, at a fixed internal address, in a source of its own
 * (so the scanner never tries to fetch it). The reading plan labels that page "product" in code.
 *
 * Pure: no database, no network.
 */

/** The `where` part every query that lists competitors carries. */
export const NOT_OWN = { isOwn: false } as const;

/** A listing of competitors without the own source. */
export function competitorsOnly<T extends { isOwn: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => !r.isOwn);
}

// ————— The product lines as a stored page —————

/**
 * CompetitorSource.type of the source that holds the own material that is not on the website (today: the
 * product-lines page). Deliberately NOT one of SOURCE_TYPES: nothing can import into it, no scan is ever queued
 * for it (the tick scans "website" sources only) and no picker offers it.
 */
export const OWN_MATERIAL_SOURCE_TYPE = "ownmaterial";
/** A host that can never be on the internet (.internal is reserved for private use): the page is ours, not fetched. */
export const PRODUCT_LINES_HOST = "product-lines.pm-os.internal";
/** The fixed internal address of the product-lines page. */
export const PRODUCT_LINES_PAGE_URL = `https://${PRODUCT_LINES_HOST}/`;
/** What the evidence link of a quote taken from the product-lines page says instead of an address. */
export const PRODUCT_LINES_PAGE_LABEL = "Product lines (Settings)";

export function isProductLinesPage(url: string | null | undefined): boolean {
  return url === PRODUCT_LINES_PAGE_URL;
}

export interface ProductLineText {
  name: string;
  description: string;
  position: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function productLinesPageTitle(orgName: string): string {
  const org = oneLine(orgName);
  return org ? `Product lines of ${org}` : "Product lines";
}

/**
 * The text of the product-lines page: the title, then one block per product line — its name, then its description
 * — in the order of Settings (position, then name). Null when the organization has no product line with a name:
 * there is no page then. The same lines always give the same text, so the page's hash moves exactly when a product
 * line is added, removed, renamed, reordered or described differently — and the page is due again.
 */
export function productLinesPageText(orgName: string, lines: ProductLineText[]): string | null {
  const blocks = [...lines]
    .map((l) => ({ name: oneLine(l.name), description: l.description.replace(/\r\n?/g, "\n").split("\n").map(oneLine).filter(Boolean).join("\n"), position: l.position }))
    .filter((l) => l.name)
    .sort((a, b) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => (l.description ? `${l.name}\n${l.description}` : l.name));
  if (!blocks.length) return null;
  return `${productLinesPageTitle(orgName)}\n\n${blocks.join("\n\n")}`;
}

// ————— The own cell —————

/** The top evidence of ours behind an own cell (Capability.ourEvidence / Feature.ourEvidence). */
export interface OwnEvidence {
  quote: string;
  sourceUrl: string;
  reasoning: string;
  /** Our own name for it, as our pages say it. */
  wording: string;
  /** One plain sentence of what it does, from our pages; null when they do not say. */
  description: string | null;
  /** Distinct pages of ours that carry evidence. */
  count: number;
}

/** What a run found of ours for one row: the best-ranked evidence (cells.ts), or none. */
export interface OwnFound {
  best: { quote: string; pageUrl: string; reasoning: string; wording: string } | null;
  count: number;
  description: string | null;
}

/** The stored evidence of an own cell: null when the run found none. */
export function ownEvidenceOf(found: OwnFound): OwnEvidence | null {
  if (!found.best) return null;
  return { quote: found.best.quote, sourceUrl: found.best.pageUrl, reasoning: found.best.reasoning, wording: found.best.wording, description: found.description, count: found.count };
}

/** ourEvidence as stored (a Json column), checked field by field; null for anything that is not evidence. */
export function readOwnEvidence(raw: unknown): OwnEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.quote !== "string" || !r.quote || typeof r.sourceUrl !== "string") return null;
  return {
    quote: r.quote,
    sourceUrl: r.sourceUrl,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    wording: typeof r.wording === "string" ? r.wording : "",
    description: typeof r.description === "string" && r.description ? r.description : null,
    count: typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 1,
  };
}

/**
 * The own cell after a run of the own source — the whole rule:
 *   - what the run says: evidence of ours on any page that is read → "found"; none → "not_found". No confidence:
 *     a page of ours that is read is ours, strong or weak.
 *   - a value a PM set by hand (`setByPm`) is the truth: the run never changes it, whatever it found.
 * Returns the value the row carries after the run and whether that is a change.
 */
export function ownStatusAfterRun(current: { ourStatus: string; setByPm: boolean }, found: Pick<OwnFound, "count">): { ourStatus: OwnStatus; changed: boolean } {
  const now: OwnStatus = current.ourStatus === "found" ? "found" : "not_found";
  if (current.setByPm) return { ourStatus: now, changed: false };
  const next: OwnStatus = found.count > 0 ? "found" : "not_found";
  return { ourStatus: next, changed: next !== current.ourStatus };
}
