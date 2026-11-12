/**
 * What the analysis never reads, and how evidence ranks (Capability Analysis, "How the analysis runs").
 *
 * Which pages ARE read is no longer decided here by words in the address: the run's map step labels the sections
 * of the site and the reading plan decides (analysis/sections.ts). What stays here is what code knows with
 * certainty, without asking PMOS AI — it saves tokens, and these pages never reach the map:
 *   - a collector's source of jobs or events,
 *   - careers, legal, account and listing pages,
 *   - a localized copy of the site (another language says nothing new).
 *
 * Three tiers:
 *   strong — read; evidence from it makes a cell "found"
 *   weak   — read only when the workspace setting readWeakPages is on; evidence from weak pages alone = "low confidence"
 *   skip   — never read
 *
 * Pure: no database, no network.
 */

export type PageTier = "strong" | "weak" | "skip";

/** A site that lives under one of these prefixes is read as if the prefix were not there (/en/products/x = /products/x). */
export const ENGLISH_PREFIXES: readonly string[] = ["en", "en-us", "en-gb"];

/** Other languages: a localized copy of the site says nothing new. */
const LOCALES = "de|fr|es|it|pt|pt-br|nl|sv|da|no|fi|pl|cs|tr|ru|uk|he|ar|ja|jp|ko|zh|zh-cn|zh-tw|cn";

/** A collector's source of these types is never read, whatever its pages' addresses. */
export const SKIPPED_SOURCE_TYPES: readonly string[] = ["jobs", "events"];

/** Skipped by the first path segment (lower case, file extension dropped): data, first match wins, no logic in a rule. */
export const SKIP_RULES: ReadonlyArray<{ kind: string; first: RegExp }> = [
  // Careers, legal, account and listing pages.
  { kind: "legal", first: /^(careers?|jobs|legal|terms|privacy|cookies?|gdpr|disclaimer|login|signin|sign-in|signup|register|thank-you|search|tags?|authors?|category|events?|cart|checkout|account)$/ },
  // Localized duplicates.
  { kind: "localized", first: new RegExp(`^(${LOCALES})$`) },
];

/** Evidence rank of a page kind: its index in this list (lower = stronger). The reading plan maps each section label to one of these (sections.ts LABEL_RULES). */
export const KIND_RANK: readonly string[] = ["pricing", "docs", "product", "content", "news"];

/** The path of an address as lower-case segments: file extension dropped, a trailing "index" dropped, an English prefix dropped. */
export function segmentsOf(url: string): string[] {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0];
  }
  const segs = path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/\.(html?|php|aspx?|jsp)$/, ""));
  // "index" is the folder's own page.
  if (segs.length && segs[segs.length - 1] === "index") segs.pop();
  if (segs.length && ENGLISH_PREFIXES.includes(segs[0])) segs.shift();
  return segs;
}

/** The skip rule that names the page's folder with certainty ("legal", "localized"), or null. */
export function folderSkip(url: string): string | null {
  const first = segmentsOf(url)[0] ?? "";
  return SKIP_RULES.find((r) => r.first.test(first))?.kind ?? null;
}

/** True when the page's source is of a type that is never read (jobs, events). */
export function sourceSkip(sourceType: string): boolean {
  return SKIPPED_SOURCE_TYPES.includes(sourceType);
}
