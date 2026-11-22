/**
 * A domain's texts as Settings → Competitors → Domains shows and edits them (Daniel 2026-11-22). Three things a user
 * edits: the name; the info section people read in the table's (i) card — "What it covers" (CompetitorDomain.summary)
 * and "Who does the work" (doneBy); and the PMOS AI definition (CompetitorDomain.description), the text PMOS AI uses
 * to decide what belongs to the domain. Pure.
 */

/** The card never says the same words twice: true when the PMOS AI definition is the same text as "What it covers" (both trimmed, and not empty). */
export function definitionSameAsCovers(covers: string, definition: string): boolean {
  const a = covers.trim();
  return a !== "" && a === definition.trim();
}

/**
 * What a save sends for the two texts. With "Same as what it covers" ticked the PMOS AI definition is the covers
 * text, so the two never drift; otherwise each is what the user wrote.
 */
export function domainTextsToSave(o: { covers: string; definition: string; same: boolean }): { summary: string; description: string } {
  return { summary: o.covers, description: o.same ? o.covers : o.definition };
}
