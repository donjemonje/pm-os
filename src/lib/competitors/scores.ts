/**
 * The coverage model of the Competitors table (Daniel 2026-11-22). A capability is a sub-domain; every company gets a
 * score 0-5 for how well it covers the capability's area — 0 = it has nothing there, 1-5 compares the companies with
 * one another — with a reasoning of at most 350 characters. A domain's score of a company is the average of its
 * capability scores. A feature cell keeps its evidence: every piece, the strongest first.
 *
 * Pure: no database, no network. The rules here are what the table, the top strip and the write routes share.
 */
import type { OwnStatus } from "./config";

export const MAX_SCORE = 5;
/** A score's reasoning, a PM's own reasoning and a feature's "how it works" are at most this long. */
export const REASONING_MAX = 350;

/** A score a request carries: a whole number 0-5, else undefined. */
export function parseScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SCORE ? value : undefined;
}

/** The found / not-found value a scored cell carries, so everything that reads values (filters, coverage, exports) stays right: any score above 0 is "found". */
export function valueOfScore(score: number): OwnStatus {
  return score > 0 ? "found" : "not_found";
}

/**
 * A company's score of a domain: the average of its capability scores there, one decimal. A capability the company
 * does not cover counts 0; capabilities with no score at all (rows of the earlier model) are left out. Null when the
 * domain has no scored capability.
 */
export function domainScore(scores: ReadonlyArray<number | null | undefined>): number | null {
  const given = scores.filter((s): s is number => typeof s === "number");
  if (!given.length) return null;
  return Math.round((given.reduce((a, b) => a + b, 0) / given.length) * 10) / 10;
}

/**
 * What a scored capability row is for the organization: a GAP when its own score is 0 and at least one competitor is
 * above 0; ONLY the organization when its own score is above 0 and no competitor is; else level. "none" with no
 * competitors. Null when the own score is missing: the row is of the earlier model and the earlier rule applies.
 */
export function scoreRowKind(own: number | null | undefined, theirs: ReadonlyArray<number | null | undefined>): "gap" | "only" | "level" | "none" | null {
  if (typeof own !== "number") return null;
  if (theirs.length === 0) return "none";
  const anyAbove = theirs.some((s) => typeof s === "number" && s > 0);
  if (own === 0 && anyAbove) return "gap";
  if (own > 0 && !anyAbove) return "only";
  return "level";
}

/** Offering Proximity from scores: the average score across the scored capabilities, on the card's 0-100 scale. Null with no score. */
export function proximityOfScores(scores: ReadonlyArray<number | null | undefined>): number | null {
  const given = scores.filter((s): s is number => typeof s === "number");
  if (!given.length) return null;
  return Math.round((given.reduce((a, b) => a + b, 0) / given.length / MAX_SCORE) * 100);
}

/**
 * The score and the main features must agree (prompt 3, part 3): with four or more main features, a company that has
 * at most one of them cannot get 5; with three or more, a company that has all of them cannot get 1; and a score of
 * 0 means it has none of them.
 */
export function scoreAgreesWithFeatures(score: number, had: number, total: number): boolean {
  if (score === MAX_SCORE && total >= 4 && had <= 1) return false;
  if (score === 1 && total >= 3 && had === total) return false;
  if (score === 0 && had > 0) return false;
  return true;
}

/** One piece of evidence behind a feature cell. */
export interface EvidenceRef {
  quote: string;
  url: string | null;
  /** "help center" | "API docs" | "release note" | "product page" | "pricing page" | "" */
  pageKind: string;
  /** "explains" | "describes" | "names" | "" */
  strength: string;
  /** The quote was found word for word in the stored page. */
  checked: boolean;
}

/** The evidence list as stored (a Json column), checked field by field; [] for anything else. Order is kept: the strongest first. */
export function readEvidenceList(raw: unknown): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceRef[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.quote !== "string" || !r.quote) continue;
    out.push({ quote: r.quote, url: typeof r.url === "string" && r.url ? r.url : null, pageKind: typeof r.pageKind === "string" ? r.pageKind : "", strength: typeof r.strength === "string" ? r.strength : "", checked: r.checked === true });
  }
  return out;
}
