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
 * THE ONE HOME (Daniel 2026-11-22): the app code is the one home of every prompt. A prompt is edited here and nowhere
 * else; a readable copy is printed from here (`npm run competitors:prompts`), never kept as a second source.
 * Three prompts were written as text files before that decision — pmos-office/office/competitors/aha/prompts/
 * 1-read-the-pages.txt (a company's feature list, the knowledge base), 2-sort-the-features-into-domains.txt and
 * 3-build-the-domain.txt (the table). READ_PAGES_PROMPT, SORT_FEATURES_PROMPT and BUILD_DOMAIN_PROMPT are those prompts
 * built from blocks, character for character. While the scripts outside the app still read the files,
 * `npm run competitors:prompts -- --check=<that folder>` says when a file and this text differ.
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

/** The blocks of the feature list. Every block of the app: ALL_BLOCKS, at the end of this file. */
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

// ————— The blocks of the table (2-sort-the-features-into-domains.txt and 3-build-the-domain.txt) —————
// Cut at whole lines, character for character. A block is named for the rule it holds, so the prompt that places a
// newly found feature in the table (news/table-prompt-new-intake.ts) is built from the same text and never rewords it.
/** Given to every table prompt: the market. */
export const GIVEN_MARKET: PromptBlock = { name: "given-market", text: `- the market, in one line;` };
/** Given: the domains, each with what it covers and who does its work. */
export const GIVEN_DOMAINS: PromptBlock = { name: "given-domains", text: `- the domains: for each one its name, what it covers and who does its work;` };
/** Given: the features of one company, in the form of its feature list. */
export const GIVEN_COMPANY_FEATURES: PromptBlock = { name: "given-company-features", text: `- the features of one company's solution. Each feature has a code, a name, the problem it solves, how it works, its users (a person by job title or an agent by type) and the workflows it is part of, the closest one first, each with the step of work.` };
/** Every feature gets one domain. */
export const ONE_DOMAIN_EACH: PromptBlock = { name: "one-domain-each", text: `Give every feature exactly one domain.` };
/** HOW A FEATURE'S DOMAIN IS DECIDED — by the work it helps; "none" for what surrounds the work or belongs to an area no domain covers. */
export const DOMAIN_HOW_TO_DECIDE: PromptBlock = { name: "domain-how-to-decide", text: `How to decide
- A feature belongs to the domain whose work it helps. Decide that from the feature's first workflow, the step of work and the users. Not from its name, and not from the product or page it came from.
- When the first workflow fits no domain, try the next one.
- A feature used in several domains belongs to the domain where it is used most. One domain only, never two.
- A feature that does two different jobs still gets one domain: the job that is the larger part of it.
- A tool for expressing or recording something (a report, a diagram, a document) belongs to the domain where what it produces is used.
- Things every solution has around its work (sign-in, roles, single sign-on, usage limits, API access on its own, notifications on their own, a mobile app on its own) belong to no domain: answer "none".
- When a feature is real work of this market but of an area none of the domains covers, answer "none" and say in the reason which area it is. Do not push it into the closest domain.` };
/** How a feature's domain is answered: the name as given or "none", and the reason. */
export const DOMAIN_ANSWER_FIELDS: PromptBlock = { name: "domain-answer-fields", text: `- domain: the name of the domain exactly as given, or "none".
- reason: up to about 12 words: the workflow or the users that decided it.` };
/** What the table is, what a domain is, and who reads it. */
export const TABLE_AIM: PromptBlock = { name: "table-aim", text: `We are building a table that compares the solutions of different companies in one market, one domain at a time. A domain is one area of the work of the people who use these solutions. The readers are professionals of this market: do not explain what they already know. A product manager who reads the finished table should see the state of the market at a glance: how strong every company is in each part of the domain, and where the companies differ.` };
/** A capability is a sub-domain. */
export const CAPABILITY_IS: PromptBlock = { name: "capability-is", text: `A capability is a sub-domain: a smaller area inside the domain's area. It is not one thing a product does.` };
/** How many capabilities a domain has. */
export const CAPABILITY_COUNT: PromptBlock = { name: "capability-count", text: `- 3 to 6 capabilities. Together they should cover as much of what the domain covers as they can. Never add one to reach a number.` };
/** WHERE THE BORDERS BETWEEN CAPABILITIES RUN — little overlap, by the work, for the whole market, able to hold features, never an API or an assistant. */
export const CAPABILITY_BORDERS: PromptBlock = { name: "capability-borders", text: `- They overlap as little as possible: a professional who reads the list sees at once which capability a feature belongs to. Two capabilities that overlap are one capability, or the border between them is drawn wrongly.
- Draw the borders by the work: the workflows, the steps and the users. A different part of the domain's work is a different capability. Not by how any company packages or names its products.
- Draw them for the whole market, from the features of all the companies, not from one company's list.
- A capability must be able to hold features: an area for which no company shows a feature is not a capability.
- An API, an integration, a connector or an AI assistant is not a capability. It is at most a feature of the capability it serves.` };
/** What is written for a capability: its name and what it covers. */
export const CAPABILITY_FIELDS: PromptBlock = { name: "capability-fields", text: `- name: one phrase of 2 to 4 words that the whole market would use, in sentence case. No brand or product name, no "&", no "/".
- covers: what this capability covers, as a part of what the domain covers. One or two plain sentences, in the same language as the domain's "what it covers". It says which work is inside; where the border with a neighbouring capability is not obvious, it says what is outside.` };
/** How many feature rows a capability has, and which ones. */
export const MAIN_FEATURES_COUNT: PromptBlock = { name: "main-features-count", text: `- 3 to 5 features per capability: the strongest ones, those built to solve the biggest problems of this area. Fewer is normal: never fill up to the number.` };
/** WHAT A FEATURE ROW IS — written for the whole market; the same thing is one row; rows are separate. */
export const FEATURE_ROW_IS: PromptBlock = { name: "feature-row-is", text: `- A feature is a row of the table: it gets a mark for each company. Write it for the whole market, not as one company's sentence.
- One thing a user can do is one feature, even when companies name it differently or offer it in several places. Features of different companies that solve the same problem in the same way are the same row.
- The features of a capability are separate from one another: no two that say the same thing in different words.` };
/** What is not a row of the table. */
export const NOT_A_ROW: PromptBlock = { name: "not-a-row", text: `- Not a row: what every solution in this market is assumed to have (fields, statuses, history, tags, comments, search); what could be built in about an hour; a claim that does not say what goes in and what comes out; a situation to use the product in, with nothing distinct built for it.` };
/** What is written for a feature row: its name and the problem it solves. */
export const FEATURE_ROW_FIELDS: PromptBlock = { name: "feature-row-fields", text: `- name: one line of up to about 8 words that says what it does, in plain words, in sentence case. No brand or product name.
- problem: the problem of the user it solves, one sentence that starts with "Without it,".` };
/** The coverage score of a company for a capability, 0 to 5. */
export const COVERAGE_SCORE: PromptBlock = { name: "coverage-score", text: `- score: 0 to 5. 0: none of this company's features belongs here. 1 to 5 compares the companies with one another: 5 is the company that covers this capability's area most fully among the companies given, 1 the one that covers the least of those that cover anything. Companies that cover it about equally get the same score. With one company only, judge it against what the area asks for.` };
/** The reasoning of a coverage score. */
export const COVERAGE_REASONING: PromptBlock = { name: "coverage-reasoning", text: `- reasoning: why this score, in plain words, in the same language as "what it covers": which parts of the capability's area the company covers and which it does not. At most 350 characters. No brand names of products, no feature codes.` };
/** The main features support the score. */
export const SCORE_SUPPORT: PromptBlock = { name: "score-support", text: `The main features should support the score. They are most of the judgment, not all of it: a company can have many other features in the area. But a company that has one main feature of five cannot get 5, and a company that has all the main features cannot get 1. When the score leans on features that are not main rows, the reasoning says so.` };
/** What comes from the features given, and what from knowing the market. */
export const FACTS_AND_JUDGMENT: PromptBlock = { name: "facts-and-judgment", text: `Facts and judgment
- What a company has and does: only from its features given, never from what you know about the company.
- Whether something is standard, small or heavy, and how the domain's work divides: from what you know about this market.` };
/** The blocks of the table prompts. */
export const TABLE_BLOCKS: PromptBlock[] = [GIVEN_MARKET, GIVEN_DOMAINS, GIVEN_COMPANY_FEATURES, ONE_DOMAIN_EACH, DOMAIN_HOW_TO_DECIDE, DOMAIN_ANSWER_FIELDS, TABLE_AIM, CAPABILITY_IS, CAPABILITY_COUNT, CAPABILITY_BORDERS, CAPABILITY_FIELDS, MAIN_FEATURES_COUNT, FEATURE_ROW_IS, NOT_A_ROW, FEATURE_ROW_FIELDS, COVERAGE_SCORE, COVERAGE_REASONING, SCORE_SUPPORT, FACTS_AND_JUDGMENT];

/** The prompt that gives every feature of a company's list its domain. Run today by scripts outside the app. */
export const SORT_FEATURES_PROMPT: PromptDef = {
  name: "sort-features",
  title: "Sort the features into domains",
  file: "2-sort-the-features-into-domains.txt",
  paragraphs: [
    [`We are building a table that compares the solutions of different companies in one market. The market is divided into domains: a domain is one area of the work of the people who use these solutions.`],
    [`Below are:`, GIVEN_MARKET, GIVEN_DOMAINS, GIVEN_COMPANY_FEATURES],
    [ONE_DOMAIN_EACH],
    [DOMAIN_HOW_TO_DECIDE],
    [`For every feature write`, `- feature: its code.`, DOMAIN_ANSWER_FIELDS],
    [`Every code given must come back exactly once. Use only the codes and the domain names given. Use only what the features say, never what you know about this company.`],
  ],
};

/** The prompt that builds one domain of the table: its capabilities, their main feature rows and every company's coverage. Run today by scripts outside the app. */
export const BUILD_DOMAIN_PROMPT: PromptDef = {
  name: "build-domain",
  title: "Build the domain (capabilities, feature rows, coverage)",
  file: "3-build-the-domain.txt",
  paragraphs: [
    [TABLE_AIM],
    [`Below are:`, GIVEN_MARKET, `- the domain we are building now: its name, what it covers and who does its work;`, `- the other domains: their names and what they cover;`, `- the companies. The first one is the company the table is made for;`, `- for each company, its features that belong to this domain. Each feature has a code, a name, the problem it solves, how it works, its users, the workflows it is part of and how strong its evidence is (a page that explains it, one that describes it, or one that only names it).`],
    [`Do three things.`],
    [`1. Divide the domain into capabilities`],
    [CAPABILITY_IS, CAPABILITY_COUNT, CAPABILITY_BORDERS, `- List the capabilities in order, the largest part of the domain's work first.`],
    [`For each capability write`, CAPABILITY_FIELDS],
    [`2. Choose the main features of each capability`],
    [MAIN_FEATURES_COUNT, FEATURE_ROW_IS, NOT_A_ROW, `- List the features in order, the most important first.`],
    [`For each feature write`, FEATURE_ROW_FIELDS, `- companies: for each company that has it, the codes of its features that show it, the one with the strongest evidence first. A company with no such feature is left out of the list.`],
    [`3. Say how well each company covers each capability`],
    [`For every capability and every company write`, `- features: the codes of ALL this company's features that belong to this capability, the main rows' ones and the others.`, COVERAGE_SCORE, COVERAGE_REASONING],
    [SCORE_SUPPORT],
    [`Also return`, `- unplaced: codes of features given that fit no capability, each with a reason of a few words (standard, small, claim, use case, another area).`],
    [FACTS_AND_JUDGMENT, `- Every feature code given comes back at least once: under a capability's features of its company, or under unplaced.`],
    [`Use only the codes and the company names given.`],
  ],
};

/** Every block: a prompt that holds a sentence of one of these in its own text should use the block instead (strayBlockText). */
export const ALL_BLOCKS: PromptBlock[] = [...SHARED_BLOCKS, ...TABLE_BLOCKS];
