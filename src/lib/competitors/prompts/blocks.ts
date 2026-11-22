import { createHash } from "node:crypto";

/**
 * SHARED PROMPT BLOCKS — prompts are built like code (Daniel 2026-11-22): a rule that two prompts need is ONE named
 * block, and every prompt that needs it uses the block, never a second wording. A fix in a block reaches every prompt
 * that uses it.
 *
 * A prompt is a list of paragraphs; a paragraph is a list of parts; a part is a shared block or the prompt's own text.
 * PMOS AI gets the parts joined as plain text (promptText) and never sees a block's name. Printed for a person
 * (printPrompt), every shared block is marked with its name and the other prompts that use it.
 *
 * A prompt's version comes from its text (promptVersion): a block change shows which prompts changed and are due a
 * re-run. A test fails when a prompt holds a block's sentence in its own text (strayBlockText).
 *
 * The blocks below are the text of the prompt that builds a company's feature list (the knowledge base),
 * pmos-office/office/competitors/aha/prompts/1-read-the-pages.txt, character for character; READ_PAGES_PROMPT is that
 * prompt built from them. `npm run competitors:prompts -- --check=<that folder>` says when the file and this text differ.
 * OPEN (2026-11-22): the Capability Analysis session edits that file as text; which of the two is the one home is not agreed yet.
 *
 * Pure: no database, no network.
 */

export interface PromptBlock {
  name: string;
  text: string;
}
export type PromptPart = string | PromptBlock;
export interface PromptDef {
  /** Short id, used in versions and marks. */
  name: string;
  /** What a person calls it. */
  title: string;
  /** Paragraphs (joined by an empty line) of parts (joined by a line break). */
  paragraphs: PromptPart[][];
  /** The text file that holds the same prompt outside the app, when there is one (checked by competitors:prompts). */
  file?: string;
}

const textOf = (part: PromptPart) => (typeof part === "string" ? part : part.text);

/** The prompt as PMOS AI gets it. */
export function promptText(p: PromptDef): string {
  return p.paragraphs.map((parts) => parts.map(textOf).join("\n")).join("\n\n");
}

/** "<name>-<8 hex of its text>": moves whenever the text moves, whichever block or own line changed. */
export function promptVersion(p: PromptDef): string {
  return `${p.name}-${createHash("sha256").update(promptText(p)).digest("hex").slice(0, 8)}`;
}

export function blocksOf(p: PromptDef): PromptBlock[] {
  return p.paragraphs.flat().filter((x): x is PromptBlock => typeof x !== "string");
}

/** The prompt for a person: the same text, each shared block between two mark lines. `all` = every prompt of the app. */
export function printPrompt(p: PromptDef, all: PromptDef[]): string {
  const others = (b: PromptBlock) => all.filter((o) => o.name !== p.name && blocksOf(o).some((x) => x.name === b.name)).map((o) => o.title);
  const body = p.paragraphs
    .map((parts) =>
      parts
        .map((part) => {
          if (typeof part === "string") return part;
          const also = others(part);
          return `>>> SHARED BLOCK "${part.name}" — ${also.length ? `also in: ${also.join("; ")}` : "used by this prompt only, so far"}\n${part.text}\n<<< END OF "${part.name}"`;
        })
        .join("\n"),
    )
    .join("\n\n");
  return `${p.title} — version ${promptVersion(p)}\nLines that start with >>> or <<< are marks for the reader. PMOS AI never sees them.\n\n${body}\n`;
}

/** Sentences of at least this length are checked (a shorter one can repeat by chance). */
const STRAY_MIN_CHARS = 40;
const sentences = (s: string) => s.split(/(?<=[.:;!?])\s+|\n/).map((x) => x.replace(/^\s*-\s*/, "").trim()).filter((x) => x.length >= STRAY_MIN_CHARS);

/** Sentences of a shared block that a prompt holds in its OWN text: each one should be the block instead. */
export function strayBlockText(p: PromptDef, blocks: PromptBlock[]): Array<{ block: string; sentence: string }> {
  const own = p.paragraphs.flat().filter((x): x is string => typeof x === "string").join("\n");
  const out: Array<{ block: string; sentence: string }> = [];
  for (const b of blocks) for (const s of sentences(b.text)) if (own.includes(s)) out.push({ block: b.name, sentence: s });
  return out;
}

// ————— The blocks of the feature list (1-read-the-pages.txt) —————

/** What each kind of page is good for. */
export const PAGE_KINDS: PromptBlock = { name: "page-kinds", text: `- product page: says what the product does and why. Written to sell.
- pricing page: lists names by plan. It does not explain them.
- help center: says how to use it, in detail.
- API docs: says what programs can read and change.
- release note: says what changed in the product.` };

/** What a feature is, who a user is, and what one line of the list holds. */
export const FEATURE_IS: PromptBlock = { name: "feature-is", text: `A feature is one specific thing the product does for a user: something the user can do with it, or something it does for the user by itself. It is understood when four things are clear: which problem of the user it solves, how it solves it, which workflow of the user it is part of, and who the user is.
- A user is a person, named by job title, or a non-human user: a program or an AI agent that uses the product by itself, named by its type.
- Do not copy the site's menu. A product, a module, a plan or a "solution for" a kind of customer is not a feature: break it down into the specific things it does.
- One feature, one line. When several pages describe the same feature, it is still one feature, with the evidence of every page.
- Two different things the product does are two features, also when they solve the same problem.` };

/** HOW A FEATURE IS UNDERSTOOD — the fields written for every feature: name, problem, how it works, users, workflows, evidence. */
export const FEATURE_FIELDS: PromptBlock = { name: "feature-fields", text: `For every feature write:
- name: 2 to 6 plain words that any company could use for it. No company name, no product name.
- company_name: what this company calls it, and the product or module it belongs to when the pages say so.
- problem: the user's problem it solves. One sentence that starts with "Without it,".
- problem_source: "stated" when a page says the problem, "worked out" when you concluded it from what the feature does.
- how_it_works: how this company's solution works and how that solves the problem. Not a manual and not steps: what goes in, what the product does, what the user gets. Simple words, the way you would explain it to a colleague from another field. At most 350 characters.
- users: everyone who has this problem. One or more. For each one: name, the job title as people say it at work, or the type of the program or AI agent; and kind, "person" or "agent".
- workflows: the workflows of the user this feature is part of, the one it relates to most first, then the others. One to three. For each one: workflow, the whole piece of work from what starts it to what ends it, named in the words these users use ("close the month's books", "hire a new employee"); and step, what the user is doing in that workflow when they need this feature, a verb plus an object ("reconcile the bank statement").
- evidence: every place in the pages that describes this feature, the strongest first. For each one:
  - quote: one sentence copied word for word from the page, the one that best shows what the feature does.
  - page: that page's code.
  - strength: "explains" when the page explains how the feature works; "describes" when it says what it does in a sentence or two; "names" when it only names it, as a pricing line or a list entry does.` };

/** What is not a feature and goes under left_out. */
export const NOT_A_FEATURE: PromptBlock = { name: "not-a-feature", text: `Not a feature. Leave these out and list them under left_out with the reason:
- Training, certification, webinars, customer stories, awards, company facts, prices.
- Services done by the company's people (consulting, managed services, takedown done by staff) are features only when the pages say what the customer gets and how; otherwise leave them out.
- "AI" or "AI assistant" on its own. What the AI does is a feature only when the pages say which work it does for the user.` };

/** Integrations are listed by tool name only. */
export const INTEGRATIONS_BY_NAME: PromptBlock = { name: "integrations-by-name", text: `Integrations with other tools: do not describe them one by one. List only the names of the tools, under integrations.` };

/** Only what the pages explain counts; a name with no explanation goes under not_understood. */
export const FOUND_MEANS_UNDERSTOOD: PromptBlock = { name: "found-means-understood", text: `Found means understood. Use only the pages given, never what you know about this company or about others. If the pages name something but do not say what it does, do not list it: put it under not_understood and say what is missing. A name on the pricing page that no page explains is not understood.` };

export const SHARED_BLOCKS: PromptBlock[] = [PAGE_KINDS, FEATURE_IS, FEATURE_FIELDS, NOT_A_FEATURE, INTEGRATIONS_BY_NAME, FOUND_MEANS_UNDERSTOOD];

/** The prompt that builds a company's feature list — the knowledge base. Run today by scripts outside the app. */
export const READ_PAGES_PROMPT: PromptDef = {
  name: "read-pages",
  title: "Read the pages (builds a company's feature list)",
  file: "1-read-the-pages.txt",
  paragraphs: [
    [`We want the full list of what one company's product does for its users: every feature, the problem it solves, how it solves it, which work of the user it is part of, and who the user is.`],
    [`Below are pages of one company's website. Each page has a code, its kind, its title, its address and its text. The kinds are:`, PAGE_KINDS],
    [`List every feature the pages describe.`],
    [FEATURE_IS],
    [`Missing something is worse than listing too much. List every feature the pages describe. When you are not sure a thing deserves a line, list it. No limit on the number.`],
    [FEATURE_FIELDS],
    [NOT_A_FEATURE],
    [INTEGRATIONS_BY_NAME],
    [FOUND_MEANS_UNDERSTOOD],
    [`Use only the page codes given.`],
  ],
};
