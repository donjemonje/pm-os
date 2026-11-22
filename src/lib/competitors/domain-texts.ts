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

// ————— A capability's two texts (Settings → Competitors → Capabilities) —————
// "What it covers" (Capability.description) is what people read in the table; the PMOS AI text
// (Capability.aiDefinition) is what PMOS AI uses for the capability. Empty = PMOS AI uses "What it covers".

/** PMOS AI uses the same text as "What it covers": its own text is empty, or the same words (both trimmed). */
export function aiTextSameAsCovers(covers: string, aiText: string | null | undefined): boolean {
  const ai = (aiText ?? "").trim();
  return ai === "" || ai === covers.trim();
}

/** What a save stores as the PMOS AI text: nothing when it is the same as "What it covers" (so the two never drift), else what the user wrote. */
export function aiTextToSave(o: { covers: string; aiText: string; same: boolean }): string {
  return o.same || aiTextSameAsCovers(o.covers, o.aiText) ? "" : o.aiText.trim();
}

/** The text PMOS AI gets for a capability: its own text when one is set, else "What it covers". */
export function capabilityTextForAI(covers: string, aiText: string | null | undefined): string {
  return (aiText ?? "").trim() || covers;
}

/** A capability as the settings form edits it. */
export interface CapabilityDraft { name: string; domainId: string; description: string; aiDefinition: string; same: boolean; productLines: string[]; ownProduct: string }

/**
 * What a save of an open capability row sends: only the fields that differ from the row, so an untouched field
 * records no change. The PMOS AI text follows aiTextToSave. {} = nothing changed.
 */
export function capabilityChanges(row: { name: string; domainId: string; description: string; aiDefinition: string; productLines: readonly string[]; ownProduct: string }, draft: CapabilityDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draft.name.trim() !== row.name) out.name = draft.name.trim();
  if (draft.domainId !== row.domainId) out.domainId = draft.domainId;
  if (draft.description.trim() !== row.description.trim()) out.description = draft.description.trim();
  const ai = aiTextToSave({ covers: draft.description, aiText: draft.aiDefinition, same: draft.same });
  // Compared with what is stored, so a stored copy of the covers text is cleared the first time the row is saved "same" (it could not follow a later change of the covers text).
  if (ai !== row.aiDefinition.trim()) out.aiDefinition = ai;
  if (draft.productLines.length !== row.productLines.length || draft.productLines.some((l) => !row.productLines.includes(l))) out.productLines = draft.productLines;
  if (draft.ownProduct.trim() !== row.ownProduct.trim()) out.ownProduct = draft.ownProduct.trim();
  return out;
}
