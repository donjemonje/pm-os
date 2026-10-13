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
  - No support framing ("customer says...", "user is asking..."), no ticket phrasing — it should read as if the product team wrote the idea themselves. Requester and customer names from support tickets are captured separately and stay out of the text; customer names the product team itself wrote into an existing idea or Jira issue ("requested by Kanuf") are facts of that text and stay (Additional Info).
  - Use bullet lists whenever you enumerate — several asks, cases, constraints, affected flows. Prose is for the one-sentence core of a section, lists for everything that is a list.
  - Never lose a concrete reference from the source: every URL, link, ticket or issue key (e.g. PG-1121), document name, version, number or named thing carries over verbatim — in the section it belongs to, else under Additional Info. A PM must never have to open the original ticket or issue to find something it contained.
  - The user pain is the core of every idea: "The Problem" must state the problem a user has and who has it, in a form that stays true whichever solution is chosen. Capabilities and asks are ways to resolve it, never the heading.
  - Section discipline (hard rules, checked):
    - "The Problem": the need and who has it. When several tickets ask for distinct things, list the distinct asks here as bullets — this is the only place asks are listed.
    - "Proposed Solution": one to three sentences describing the capability to build, nothing else. No lists. Never the words "ask", "asks", "request", "requested", "related asks"; never per-ticket or per-customer items; never evidence or context. Present only with high confidence that it is the right solution — otherwise omit the section entirely.
    - "Additional Info": real cases, references (links, keys, identifiers), constraints. Not a second list of asks.`;
