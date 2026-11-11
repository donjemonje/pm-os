/**
 * The competitor's own list (Capability Analysis, "How the analysis runs", step "merge"): what a competitor
 * offers, in their words, after the same thing on several pages was merged into one item.
 *
 * Pure: no database, no network.
 */

/** Trademark, service mark, registered and copyright signs. */
const MARKS = /[\u2122\u2120\u00AE\u00A9]/g;

/**
 * The key two wordings of the same thing share: the mark signs removed, NFKC, lower-case, "&" → "and", everything
 * that is not a letter or a digit → space, spaces collapsed.
 * "Threat-Intelligence Platform(TM)" → "threat intelligence platform".
 */
export function wordingKey(name: string): string {
  return name
    // Before NFKC: it would turn the trademark sign into the letters "TM".
    .replace(MARKS, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\((?:tm|r|c)\)/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
