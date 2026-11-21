/**
 * A company's own list (Capability Analysis, "How the analysis runs"): what it offers, in its own words — the
 * capabilities and the features under each that the reading lists, each once (analysis/reading.ts). This file is
 * what identifies an entry: the key two wordings of the same thing share, and an item's stable key.
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

/**
 * A CompetitorItem's stable key: "c:<wordingKey>" for a capability; "f:<its capability item's id>><wordingKey>" for a
 * feature — the capability's id, not its name, so a capability that is renamed keeps its features' keys.
 */
export function itemKey(kind: "capability" | "feature", parentItemId: string | null, name: string): string {
  return kind === "capability" ? `c:${wordingKey(name)}` : `f:${parentItemId ?? ""}>${wordingKey(name)}`;
}
