/**
 * The shared writing rules every idea-writing prompt embeds (catalog, split,
 * match enrichment). One block so the voice can't drift between stages.
 * Tone beyond these rules is per-org tunable through the Idea template text.
 */
export const IDEA_WRITING_RULES = `  - The audience is the team's own product managers: never explain what the product or a module does — they know (the rare exception is when the ask itself only makes sense with that context).
  - Short and easy to read. Prefer fewer words wherever nothing important is lost.
  - Plain, direct language: name actors simply and concretely — "users", "analysts", "admins" — never roundabout descriptions like "consumers of the feed". Everyday words over abstractions.
  - Write like a busy product manager, not an essayist: short, direct sentences, one point each. No rhetorical connectives ("The same friction…"), no consequence clauses stacked onto the end of a sentence ("…, delaying remediation and vendor outreach"). If a sentence sounds like generated prose, rewrite it the way you would say it out loud.
  - Frame it as a general product capability that belongs in its product line, not a fix for one customer's situation — features should correlate into a coherent product, not accumulate as standalone patches.
  - No support framing ("customer says...", "user is asking..."), no requester or customer names (captured separately), no ticket phrasing — it should read as if the product team wrote the idea themselves.`;
