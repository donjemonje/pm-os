import { arr, str } from "../ai";
import { checkPii } from "../pii";
import { MAX_ENUM, NO_VALUE } from "../analysis/prompts";
import { AREA_SPLIT_RULE } from "../analysis/reading";
import {
  BROADER_NARROWER_RULE,
  FEATURE_NAME_RULE,
  FEATURE_PLACE_RULE,
  FEATURE_ROW_IS,
  NEW_ROW,
  NO_DUPLICATE_ROW_RULE,
  NO_WIDE_ROW_RULE,
  ROW_GROUPING_RULE,
  ROW_NAME_RULE,
  ROW_SIZE,
  SAME_FEATURE_RULE,
  SAME_ROW_RULE,
  TABLE_FRAME,
} from "../analysis/unify";

/**
 * ADD A NEWLY FOUND ABILITY TO THE TABLE (News Feed & Notifications PRD, "Table Capabilities updates").
 *
 * A competitor's material was read again and showed something its product can now do that was not on the company's
 * list. By the time it reaches this prompt it is a real new ability: checked against the company's full list,
 * understood (what it is, the problem it solves, the workflows it helps, who it is for) and backed by a quote. This
 * prompt asks what it means for the table — the questions Daniel listed (2026-11-21):
 *   1. does it belong in the table at all;
 *   2. as what — a capability or a feature;
 *   3. where — an existing row (the company's cell on it is then filled), a new row, a feature row under a row;
 *   4. for a new row, which domain;
 *   5. does the table itself have to change — a row or a domain reworded, a row split, a new domain.
 *
 * ONE SET OF RULES FOR THE TABLE (Daniel: "creating the table and adding a new ability found should have similar
 * prompts, as much as possible"). The prompt is built from the sentences the setup run already uses — what a row is,
 * when two things are one row, how a row, a feature row and a domain are named — imported from analysis/unify.ts
 * and analysis/reading.ts. The sentences of the domains and match prompts are held here as copies of their text
 * (DOMAIN_*_RULE, MATCH_*_RULE): a unit test fails when one of them is no longer part of the prompt it was taken
 * from, so the two cannot drift apart unseen.
 *
 * The answer PROPOSES. Nothing here writes to the table: what is done with a decision (fill the cell by the cell
 * rules, create the row, show a proposed change to a person) is the caller's.
 *
 * Closed sets, every field required (the answer form must be strict: a form with optional fields lets the model
 * close its answer early). An answer names abilities, rows, feature rows and domains by the codes it was given, or
 * "new", or "none". A decision that names anything else, or that does not hold together (a feature row under
 * another row, a new row without a name), is dropped and counted; an ability with no usable decision is listed as
 * unanswered — the caller asks it again.
 *
 * Pure: no database, no network.
 */

/** Bumping it invalidates nothing: a decision that was applied is saved where it was applied. */
export const TABLE_ADD_VERSION = "table-add-1";
/** Visible output tokens of one call (thinking is on top, ai.ts). A decision is a few codes and three short texts. */
export const TABLE_ADD_MAX_TOKENS = 12_000;
/** New abilities per call. A run that finds more asks in consecutive calls. */
export const TABLE_ADD_BATCH = 20;

/** A code that asks for something new (a row, a feature row, a domain): the word the setup run uses. */
export const NEW_CODE = NEW_ROW;

// ————— Rule text taken from prompts this file may not import a constant for —————
// Each is a sentence of DOMAINS_SYSTEM_PROMPT (analysis/domains.ts) or MATCH_SYSTEM_PROMPT (analysis/prompts.ts),
// character for character. tests/unit/competitors-news-table-prompt.test.ts checks that they still are.

export const DOMAIN_AREA_RULE = `A domain is an area, not a single capability and not everything: do not make one domain for the whole table, and do not make a domain that only repeats the name of one row. A row that truly belongs to no other domain may have a domain of its own.`;
export const DOMAIN_NAME_RULE = `Name a domain in market terms: short, title case, vendor-neutral — never a product, brand or marketing name, and never the name of a company.`;
export const NO_OTHER_DOMAIN_RULE = `There is no "other" or "miscellaneous" domain: do not make one catch-all domain for what is left.`;
export const DOMAIN_DEFINITIONS_RULE = `Each domain has the team's definition: read the definitions first, they say what belongs in each domain.`;
export const MATCH_BY_WHAT_RULE = `Match by what it is, not by its name. A capability of theirs can be a feature of ours, and a feature of theirs can be a capability of ours.`;
export const CONFIDENT_RULE = `Give a code only when you are confident it is the same thing`;

export const TABLE_ADD_SYSTEM_PROMPT = `${TABLE_FRAME} The table is made: its domains, the rows in each domain and the feature rows under each row. Now one company's material was read again, and it shows NEW ABILITIES: things its product can do that were not on the company's list before. Each one was checked before it reached you: it is new for this company, it is understood (what it is, the problem it solves, the workflows it helps, who it is for), and it comes with an exact quote from the company's own page. For each new ability, decide what it means for the table. Your answer changes nothing by itself: a person reviews it.

The table is OURS; the new abilities are THEIRS. Every domain, row and feature row of ours has a code. Every new ability has a code (A1, A2 …).

THE SIZES. ${ROW_SIZE} Under each row, ${FEATURE_ROW_IS}.

For each new ability, answer these five questions in this order.

1. DOES IT BELONG IN THE TABLE AT ALL? The table holds what a buyer compares between products: capabilities, and the features under them. An ability belongs when a buyer could ask for it — as one line of a list of requirements, or as a detail of one. It does not belong when it gives a buyer nothing new to ask for: a new look, a new name or a faster version of something that exists; a change of price, plan or packaging; a preview with nothing to use yet. Then in_table = false, and the reason says why. An ability that is left out stays on the company's own list: nothing is lost. When you are not sure, it belongs.

2. AS WHAT: A CAPABILITY OR A FEATURE? Each new ability comes with the size the company's list gave it. Judge by what it is in OUR table, not by that. ${MATCH_BY_WHAT_RULE}

3. WHERE DOES IT GO? Place it by how it helps its user — the problem it solves, the workflow it helps, who uses it — never by its name and never by the page it was found on.
- As a capability: look for the row of ours that is the same capability. ${SAME_ROW_RULE} ${ROW_GROUPING_RULE} When there is one: row = its code; the company now has that row. When there is none: row = "${NEW_CODE}", with new_name and new_description. ${ROW_NAME_RULE} ${NO_DUPLICATE_ROW_RULE} ${NO_WIDE_ROW_RULE}
- As a feature: row = the code of the row of ours it is a detail of. ${FEATURE_PLACE_RULE} Here "the row it is listed with" is the row of ours that holds the company's capability named with the ability. Then look at the feature rows under that row. ${SAME_FEATURE_RULE}. When one of them is the same feature: feature = its code. When none is: feature = "${NEW_CODE}", with new_name and new_description. ${FEATURE_NAME_RULE}
- A feature whose capability is no row of ours: the row is what is missing. Answer for the capability it is a detail of — as = "capability", row = "${NEW_CODE}" — and name the feature in the reason.
- ${CONFIDENT_RULE}; otherwise it is new.

4. A NEW ROW: WHICH DOMAIN? ${DOMAIN_DEFINITIONS_RULE} domain = the code of the one domain of ours the new row belongs in. Only when it fits none of them and overlaps little with every one of them: domain = "${NEW_CODE}" and change = "new_domain". ${DOMAIN_AREA_RULE} ${DOMAIN_NAME_RULE} ${NO_OTHER_DOMAIN_RULE}

5. DOES THE TABLE ITSELF HAVE TO CHANGE? Most new abilities fit the table as it is: change = "none". Name a change only when the ability shows that the table is worded or cut wrong, and say exactly what in change_detail:
- "reword_row": the ability is the same capability as a row of ours, but the row's name or sentence is now too narrow, or says it wrong. row = that row. change_detail = the row's new name and its new sentence.
- "split_row": with this ability, a row of ours holds two different capabilities. ${BROADER_NARROWER_RULE}. ${AREA_SPLIT_RULE} row = the row to split. change_detail = the rows it becomes, each with its name and its sentence, and which of them the ability goes on.
- "reword_domain": the ability belongs in a domain of ours, but the domain's name or definition does not cover it as written. domain = that domain. change_detail = the domain's new name and its new definition.
- "new_domain": only for a new row that fits no domain of ours (question 4). change_detail = the new domain's name and its one-sentence definition.
One change per ability: the one that matters most.

Keep the table small: a new row, a new feature row or a new domain is made only when nothing of ours holds the ability.

EVERY FIELD OF EVERY DECISION IS FILLED. Answer once for every ability code, in the order given, and use only the codes given. When a field does not apply, write "${NO_VALUE}" for a code (as, row, feature, domain, change) and an empty text for new_name, new_description and change_detail:
- in_table = false: as, row, feature, domain and change are all "${NO_VALUE}".
- as = "capability": feature = "${NO_VALUE}".
- domain is a code only for a new row (its domain) and for change = "reword_domain" (the domain to reword); otherwise "${NO_VALUE}".
- new_name and new_description are filled only for a new row or a new feature row.
- reason is never empty: one plain sentence saying why this answer and not the nearest other one.`;

// ————— What the prompt is given —————

/** A new ability as the earlier steps understood it. */
export interface TableAddAbility {
  /** "A1", "A2" … in the order of the call. */
  code: string;
  /** The size the company's list gave it. */
  size: "capability" | "feature";
  /** The company's own name for it. */
  name: string;
  /** One plain sentence: what it does. */
  what: string;
  /** The problem it solves. */
  problem: string;
  /** The user workflow(s) it helps. */
  workflows: string;
  /** Who it is for: job titles, or the kind of non-human user (an agent). */
  who: string;
  /** The exact passage of the company's page that shows it. */
  quote: string;
  sourceUrl: string | null;
  /** For a feature: the company's capability it is listed under. */
  parentName: string | null;
}

/** Our table as the prompt sees it. Rows a PM removed or declined are listed like any other (match.ts: so a thing a PM removed is recognised and not added back under a new name). */
export interface TableAddTable {
  domains: { code: string; name: string; definition: string }[];
  rows: { code: string; domainCode: string; name: string; description: string; features: { code: string; name: string }[] }[];
}

export const TABLE_ADD_CHANGES = ["none", "reword_row", "split_row", "reword_domain", "new_domain"] as const;
export type TableAddChange = (typeof TABLE_ADD_CHANGES)[number];

/** What the answer says of one new ability. Every field is always set: "none" / "" when it does not apply. */
export interface TableAddDecision {
  /** The ability's code. */
  code: string;
  inTable: boolean;
  as: "capability" | "feature" | "none";
  /** A row code of ours, "new", or "none". */
  row: string;
  /** A feature-row code of ours (under `row`), "new", or "none". */
  feature: string;
  /** A domain code of ours, "new", or "none" — set only for a new row and for change = "reword_domain". */
  domain: string;
  /** The name and sentence of a new row or a new feature row; "" otherwise. */
  newName: string;
  newDescription: string;
  change: TableAddChange;
  /** What exactly changes; "" when change = "none". */
  changeDetail: string;
  reason: string;
}

const closed = (values: string[]) => (values.length <= MAX_ENUM ? { enum: values } : {});

/** The tool of one call: `ability` is always a closed set; our codes ride as an enum only while the set is small. */
export function tableAddTool(abilityCodes: string[], table: TableAddTable): Record<string, unknown> {
  const rows = [NO_VALUE, NEW_CODE, ...table.rows.map((r) => r.code)];
  const features = [NO_VALUE, NEW_CODE, ...table.rows.flatMap((r) => r.features.map((f) => f.code))];
  const domains = [NO_VALUE, NEW_CODE, ...table.domains.map((d) => d.code)];
  return {
    name: "place_new_abilities",
    description: "Record, for each new ability, whether it belongs in the table, as what, where, and whether the table itself has to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        decisions: {
          type: "array",
          description: "One decision per ability code, in the order given.",
          items: {
            type: "object",
            properties: {
              ability: { type: "string", enum: abilityCodes },
              in_table: { type: "boolean", description: "Does it belong in the table at all." },
              as: { type: "string", enum: ["capability", "feature", NO_VALUE], description: `What it is in our table; "${NO_VALUE}" when in_table is false.` },
              row: { type: "string", description: `A row code of ours (the same capability, or the row a feature is a detail of), "${NEW_CODE}" for a new row, "${NO_VALUE}" when in_table is false.`, ...closed(rows) },
              feature: { type: "string", description: `For a feature: the code of the feature row of ours under that row that is the same feature, or "${NEW_CODE}". "${NO_VALUE}" for a capability, or when in_table is false.`, ...closed(features) },
              domain: { type: "string", description: `For a new row: the code of the domain of ours it belongs in, or "${NEW_CODE}". For change = "reword_domain": the domain to reword. Otherwise "${NO_VALUE}".`, ...closed(domains) },
              new_name: { type: "string", description: "For a new row or a new feature row: its name in market terms, at most 80 characters. Otherwise empty." },
              new_description: { type: "string", description: "For a new row or a new feature row: one plain sentence saying what it is. Otherwise empty." },
              change: { type: "string", enum: [...TABLE_ADD_CHANGES], description: "The change the table itself needs; \"none\" in most cases." },
              change_detail: { type: "string", description: "Exactly what changes (new names, sentences, definitions). Empty when change is \"none\"." },
              reason: { type: "string", description: "One plain sentence: why this answer and not the nearest other one. Never empty." },
            },
            required: ["ability", "in_table", "as", "row", "feature", "domain", "new_name", "new_description", "change", "change_detail", "reason"],
          },
        },
      },
      required: ["decisions"],
    },
  };
}

// ————— The user content —————

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, max: number) => {
  const t = oneLine(s);
  return (t.length > max ? `${t.slice(0, max).trimEnd()}…` : t).replace(/"/g, "'");
};

/** OUR TABLE (domains, rows, feature rows — each with its code), then the NEW ABILITIES with everything that is known of each. */
export function renderTableAdd(company: string, abilities: TableAddAbility[], table: TableAddTable): string {
  const lines: string[] = [`COMPANY: ${oneLine(company)}`, "", "OUR TABLE:"];
  const known = new Set(table.domains.map((d) => d.code));
  const rowLines = (domainCode: string | null) =>
    table.rows
      .filter((r) => (domainCode === null ? !known.has(r.domainCode) : r.domainCode === domainCode))
      .flatMap((r) => [`  ${r.code} | ${oneLine(r.name)}${r.description ? ` — ${short(r.description, 240)}` : ""}`, ...r.features.map((f) => `    ${f.code} | ${oneLine(f.name)}`)]);
  for (const d of table.domains) {
    lines.push(`${d.code} | DOMAIN: ${oneLine(d.name)}${d.definition ? ` — ${short(d.definition, 300)}` : ""}`);
    const rows = rowLines(d.code);
    lines.push(...(rows.length ? rows : ["  (no rows yet)"]));
  }
  const orphans = rowLines(null);
  if (orphans.length) lines.push("ROWS WITH NO DOMAIN:", ...orphans);
  lines.push("", "NEW ABILITIES (theirs):");
  for (const a of abilities) {
    const size = a.size === "capability" ? "capability" : `feature${a.parentName ? `, listed by the company under "${short(a.parentName, 80)}"` : ""}`;
    lines.push(`${a.code} | ${size} | ${oneLine(a.name)}${a.what ? ` — ${short(a.what, 300)}` : ""}`);
    if (a.problem) lines.push(`  problem it solves: ${short(a.problem, 300)}`);
    if (a.workflows) lines.push(`  workflows it helps: ${short(a.workflows, 300)}`);
    if (a.who) lines.push(`  for whom: ${short(a.who, 200)}`);
    if (a.quote) lines.push(`  quote: "${short(a.quote, 300)}"${a.sourceUrl ? ` (${a.sourceUrl})` : ""}`);
  }
  return lines.join("\n");
}

// ————— The answer —————

/** A text that names a person is emptied. */
const clean = (text: string): string => (checkPii(text).hit ? "" : text);
const code = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isNone = (v: string) => v === "" || v.toLowerCase() === NO_VALUE;

/**
 * The decisions of one call. Kept: one decision per ability of the call (the first when a code comes twice), whose
 * codes are all of the closed sets and whose parts hold together. Dropped and counted: everything else — an ability
 * that was not asked, a second answer for an ability, a code that is none of ours, a feature row that is not under
 * the row named, a new row or feature row without a name, a new row without a domain, a change without its detail
 * (or one that does not fit the answer: "new_domain" without a new row in a new domain, a row change on a new row,
 * a reworded domain that is not the row's own), a decision without a reason.
 * Fields that do not apply are set to "none" / "" whatever the answer wrote in them.
 * `unanswered`: the abilities of the call with no kept decision — asked again by the caller.
 */
export function parseTableAdd(value: unknown, abilities: TableAddAbility[], table: TableAddTable): { decisions: TableAddDecision[]; dropped: number; unanswered: string[] } {
  const asked = new Set(abilities.map((a) => a.code));
  const rows = new Map(table.rows.map((r) => [r.code, r]));
  const domains = new Set(table.domains.map((d) => d.code));
  const seen = new Set<string>();
  const decisions: TableAddDecision[] = [];
  let dropped = 0;

  for (const entry of arr((value as Record<string, unknown> | null)?.decisions)) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const ability = code(o.ability);
    const decision = asked.has(ability) && !seen.has(ability) ? decide(ability, o, rows, domains) : null;
    if (!decision) {
      dropped++;
      continue;
    }
    seen.add(ability);
    decisions.push(decision);
  }
  return { decisions, dropped, unanswered: abilities.map((a) => a.code).filter((c) => !seen.has(c)) };
}

function decide(ability: string, o: Record<string, unknown>, rows: Map<string, TableAddTable["rows"][number]>, domains: Set<string>): TableAddDecision | null {
  if (typeof o.in_table !== "boolean") return null;
  const reason = clean(str(o.reason, 300));
  if (!reason) return null;
  const none: TableAddDecision = { code: ability, inTable: false, as: "none", row: NO_VALUE, feature: NO_VALUE, domain: NO_VALUE, newName: "", newDescription: "", change: "none", changeDetail: "", reason };
  if (!o.in_table) return none;

  const as = code(o.as);
  if (as !== "capability" && as !== "feature") return null;
  const row = code(o.row);
  const isNewRow = row === NEW_CODE;
  const ourRow = rows.get(row);
  if (!isNewRow && !ourRow) return null;
  const change = code(o.change) as TableAddChange;
  if (!TABLE_ADD_CHANGES.includes(change)) return null;
  const changeDetail = change === "none" ? "" : clean(str(o.change_detail, 600));
  if (change !== "none" && !changeDetail) return null;
  const newName = clean(str(o.new_name, 80));
  const newDescription = clean(str(o.new_description, 300));
  const givenDomain = code(o.domain);

  let feature = NO_VALUE;
  if (as === "feature") {
    // A feature is a detail of a row that exists; a feature whose row is missing is answered as that capability.
    if (!ourRow) return null;
    feature = code(o.feature);
    if (feature !== NEW_CODE && !ourRow.features.some((f) => f.code === feature)) return null;
    if (feature === NEW_CODE && !newName) return null;
  }

  let domain = NO_VALUE;
  if (isNewRow) {
    if (!newName) return null;
    if (givenDomain !== NEW_CODE && !domains.has(givenDomain)) return null;
    domain = givenDomain;
    // A new row is neither reworded nor split; a new domain is declared, and only then.
    if (change === "reword_row" || change === "split_row") return null;
    if ((domain === NEW_CODE) !== (change === "new_domain")) return null;
  } else {
    if (change === "new_domain") return null;
    if (change === "reword_domain") {
      // The domain to reword is the row's own.
      if (isNone(givenDomain) || givenDomain !== ourRow!.domainCode || !domains.has(givenDomain)) return null;
      domain = givenDomain;
    }
  }

  const named = isNewRow || feature === NEW_CODE;
  return { code: ability, inTable: true, as, row, feature, domain, newName: named ? newName : "", newDescription: named ? newDescription : "", change, changeDetail, reason };
}
