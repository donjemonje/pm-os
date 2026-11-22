import { arr, str } from "../ai";
import { MAX_ENUM, NO_VALUE } from "../analysis/prompts";
import {
  CAPABILITY_BORDERS,
  CAPABILITY_COUNT,
  CAPABILITY_FIELDS,
  CAPABILITY_IS,
  COVERAGE_REASONING,
  COVERAGE_SCORE,
  DOMAIN_ANSWER_FIELDS,
  DOMAIN_HOW_TO_DECIDE,
  FACTS_AND_JUDGMENT,
  FEATURE_ROW_FIELDS,
  FEATURE_ROW_IS,
  GIVEN_COMPANY_FEATURES,
  GIVEN_DOMAINS,
  GIVEN_MARKET,
  MAIN_FEATURES_COUNT,
  NOT_A_ROW,
  ONE_DOMAIN_EACH,
  promptText,
  promptVersion,
  SCORE_SUPPORT,
  TABLE_AIM,
  type PromptDef,
} from "../prompts/blocks";

/**
 * THE TABLE STEP FOR A NEWLY FOUND FEATURE — what a feature the news intake found (news/intake.ts: something the
 * company's feature list did not hold) changes in the table (News Feed & Notifications PRD, "Table Capabilities
 * updates").
 *
 * The table model is the one of 2026-11-22: domains (written by a person: name, what it covers, who does the work)
 * → capabilities (sub-domains, 3 to 6 per domain, each with "what it covers" and, per company, a coverage score 0-5
 * with its reasoning) → feature rows (the 3 to 5 main features of a capability, each with the problem it solves and
 * a mark per company). A new feature arrives in the form of a feature of a company's list — name, problem, how it
 * works, users, workflows — with no size: capability or feature is decided here, against the table.
 *
 * The prompt asks, of each new feature, the questions the table was built by, in Daniel's order (2026-11-21): does
 * it belong in the table at all (its domain, or "none"); where (a capability, a new one, or none); as what (an
 * existing row — which fills this company's "not found" — a new row, or no row: it then only counts in the
 * coverage); does a capability or a domain have to change for it (a wording change, a split, a new one); and what
 * the company's coverage score is with it.
 *
 * NO SECOND WORDING (Daniel 2026-11-22): the rules are the blocks of the prompts that build the table —
 * sort-the-features-into-domains and build-the-domain (prompts/blocks.ts). This prompt's own text is only what
 * those do not need: that the table exists, what is given, and the choices of each question.
 *
 * NOTHING IS APPLIED. The answer is a proposal: news/table-dry-run.ts asks and prints, and writes nothing (Daniel
 * 2026-11-22: "don't execute any table changes yet"). The prompt has never been run against a model.
 *
 * This file is the prompt, the request, the answer form and the parser. Pure: no database, no network.
 */

/** Visible output tokens of one call (thinking is on top; the news model thinks at "high"). */
export const TABLE_NEW_INTAKE_MAX_TOKENS = 30_000;
/** New features per call. A batch of news is a handful; a longer list goes in consecutive calls. */
export const TABLE_NEW_INTAKE_BATCH = 20;
/** The code of a capability or a row that does not exist yet. */
export const NEW_CODE = "new";

/** What a new feature can ask of the table besides its own place. */
export const TABLE_CHANGES = ["none", "capability wording", "split capability", "new capability", "domain wording", "new domain"] as const;
export type TableChange = (typeof TABLE_CHANGES)[number];

export const TABLE_NEW_INTAKE_PROMPT: PromptDef = {
  name: "table-new-intake",
  title: "Table: place newly found features (dry run, nothing is applied)",
  paragraphs: [
    [TABLE_AIM],
    [
      `The table is built. Since then one company's solution got new features: things it does now that it did not do when the table was built. Say what each new feature changes in the table. Do not build the table again: change only what a new feature asks for.`,
    ],
    [
      `Below are:`,
      GIVEN_MARKET,
      GIVEN_DOMAINS,
      `- the company;`,
      `- the table as it is. Under each domain its capabilities: each has a code, its name, what it covers, this company's coverage score with its reasoning, and the scores of the other companies. Under each capability its feature rows: each has a code, its name, the problem it solves, and whether this company has it;`,
      GIVEN_COMPANY_FEATURES,
      `The features given are the new ones only.`,
    ],
    [`For every new feature answer four questions, in this order.`],
    [`1. Which domain`],
    [ONE_DOMAIN_EACH],
    [DOMAIN_HOW_TO_DECIDE],
    [
      `- A feature whose domain is "none" is not in the table: answer "none" to the other questions about it.`,
      `- It is work of a domain by everything but the wording of what that domain covers: give that domain, with change "domain wording".`,
      `- It is real work of this market in an area that no domain covers and that overlaps little with every domain given: domain "none", with change "new domain".`,
    ],
    [`For the domain write`, DOMAIN_ANSWER_FIELDS],
    [`2. Which capability of that domain`],
    [
      CAPABILITY_IS,
      `- A capability's "what it covers" holds the work this feature helps: answer that capability's code.`,
      `- No capability holds that work as it is worded, and a small change of one capability's name or "what it covers" would: answer that capability's code, with change "capability wording".`,
      `- With this feature in it, a capability would hold two different parts of the domain's work: answer that capability's code, with change "split capability".`,
      `- The work is a part of the domain's work that no capability covers: answer "new", with change "new capability".`,
      `- It is work of the domain that deserves no place in the table (standard, small, a claim, a use case): answer "none".`,
    ],
    [`A new capability, a split one and one whose wording changes keep the rules the capabilities were made by:`, CAPABILITY_COUNT, CAPABILITY_BORDERS],
    [`For a new capability and for one whose wording changes write, as capability_name and capability_covers`, CAPABILITY_FIELDS],
    [`3. Which row of that capability`],
    [
      MAIN_FEATURES_COUNT,
      FEATURE_ROW_IS,
      NOT_A_ROW,
      `- It is the same feature as a row of the capability: answer that row's code. Where the company's mark on that row is "not found", the new feature fills it.`,
      `- It is none of the rows, and it is one of the strongest features of the capability: answer "new". When the capability already has 5 rows, write under row_replaces the code of the row it takes the place of.`,
      `- Otherwise answer "none": it is not a row. It still counts in the company's coverage of the capability.`,
    ],
    [`For a new row write, as row_name and row_problem`, FEATURE_ROW_FIELDS],
    [`4. The company's coverage of that capability`],
    [`With the new feature counted, write for this company and that capability`, COVERAGE_SCORE, COVERAGE_REASONING],
    [SCORE_SUPPORT],
    [
      `Also write`,
      `- change_detail: for a change, what exactly changes, in one or two plain sentences: the new wording, the two parts of a split, or the area of a new domain.`,
      `- why: one sentence: why this place, and not the closest other one.`,
    ],
    [FACTS_AND_JUDGMENT],
    [`Every feature code given comes back exactly once. Use only the codes and the names given. Every field is always written: "none" where it does not apply, and 0 for a score that does not apply.`],
  ],
};

/** The prompt as PMOS AI gets it. */
export const TABLE_NEW_INTAKE_SYSTEM_PROMPT = promptText(TABLE_NEW_INTAKE_PROMPT);
/** Moves whenever the prompt's text moves, a shared block included. */
export const TABLE_NEW_INTAKE_VERSION = promptVersion(TABLE_NEW_INTAKE_PROMPT);

// ————— What the request holds —————

/** A newly found feature, in the form of a feature of a company's list. */
export interface TableNewFeature {
  /** "N1", "N2" … in the order of the call. */
  code: string;
  /** The plain name any company could use for it. */
  name: string;
  /** The user's problem it solves ("Without it, …"). */
  problem: string;
  howItWorks: string;
  /** One line: "Threat analyst (person), SOAR playbook (agent)". */
  users: string;
  /** One line, the closest workflow first: "1. workflow — step | 2. …". */
  workflows: string;
}

/** A feature row of the table, as this company stands on it. */
export interface TableRow {
  /** "C3.2": the second row of capability C3. */
  code: string;
  name: string;
  problem: string;
  /** This company's mark: true = it has the row, false = "not found". */
  has: boolean;
}

export interface TableCapability {
  /** "C1", "C2" … across the whole table. */
  code: string;
  name: string;
  covers: string;
  /** This company's coverage score 0-5; null when the table holds a mark and no score. */
  score: number | null;
  reasoning: string;
  /** The other companies' scores (the company the table is made for included). */
  others: Array<{ company: string; score: number | null }>;
  rows: TableRow[];
}

export interface TableDomain {
  name: string;
  covers: string;
  who: string;
  capabilities: TableCapability[];
}

/** The table as the prompt sees it: for ONE company. */
export interface TableForCompany {
  /** The market, in one line. */
  market: string;
  company: string;
  domains: TableDomain[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const scoreText = (n: number | null) => (n === null ? "no score" : `${n}/5`);

export function renderTable(table: TableForCompany): string {
  const out: string[] = [];
  for (const d of table.domains) {
    out.push(`DOMAIN: ${oneLine(d.name)}`);
    if (d.capabilities.length === 0) out.push("  (no capability yet)");
    for (const c of d.capabilities) {
      out.push(`  ${c.code} | ${oneLine(c.name)}`);
      out.push(`     Covers: ${oneLine(c.covers)}`);
      out.push(`     ${oneLine(table.company)}: ${scoreText(c.score)}${c.reasoning ? ` — ${oneLine(c.reasoning)}` : ""}`);
      if (c.others.length) out.push(`     The other companies: ${c.others.map((o) => `${oneLine(o.company)} ${scoreText(o.score)}`).join(" · ")}`);
      for (const r of c.rows) out.push(`     ${r.code} | ${oneLine(r.name)} — Problem: ${oneLine(r.problem)} — ${oneLine(table.company)}: ${r.has ? "has it" : "not found"}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** A new feature as the build prompt is given a feature: code and name, then its lines. */
export function renderNewFeature(f: TableNewFeature): string {
  return [`${f.code} | ${oneLine(f.name)}`, `   Problem: ${oneLine(f.problem)}`, `   How it works: ${oneLine(f.howItWorks)}`, `   Users: ${oneLine(f.users)}`, `   Workflows: ${oneLine(f.workflows)}`].join("\n");
}

export function renderTableNewIntake(features: TableNewFeature[], table: TableForCompany): string {
  return [
    `THE MARKET\n${oneLine(table.market) || "(not recorded)"}`,
    `THE DOMAINS\n${table.domains.map((d) => `${oneLine(d.name)} — ${oneLine(d.covers)}\nWho does the work: ${oneLine(d.who) || "(not recorded)"}`).join("\n")}`,
    `THE COMPANY\n${oneLine(table.company)}`,
    `THE TABLE AS IT IS\n${renderTable(table)}`,
    `THE NEW FEATURES OF ${oneLine(table.company).toUpperCase()} (${features.length})\n${features.map(renderNewFeature).join("\n")}`,
  ].join("\n\n");
}

// ————— The answer form —————

const S = { type: "string" };
const closed = (values: string[]) => (values.length <= MAX_ENUM ? { enum: values } : {});
const capabilitiesOf = (table: TableForCompany) => table.domains.flatMap((d) => d.capabilities);

/** Every field is required (a form with optional fields lets the model close its answer early — found 2026-11-20). */
export function tableNewIntakeTool(featureCodes: string[], table: TableForCompany): Record<string, unknown> {
  const capabilities = capabilitiesOf(table);
  const rows = capabilities.flatMap((c) => c.rows.map((r) => r.code));
  const properties = {
    feature: { ...S, description: "The new feature's code.", ...closed(featureCodes) },
    domain: { ...S, description: `The name of the domain exactly as given, or "${NO_VALUE}".`, ...closed([...table.domains.map((d) => d.name), NO_VALUE]) },
    reason: { ...S, description: "Why this domain: the workflow or the users that decided it." },
    capability: { ...S, description: `A capability code of that domain, "${NEW_CODE}", or "${NO_VALUE}".`, ...closed([...capabilities.map((c) => c.code), NEW_CODE, NO_VALUE]) },
    change: { ...S, enum: [...TABLE_CHANGES], description: "What the table has to change for this feature besides its own place." },
    change_detail: { ...S, description: `What exactly changes, or "${NO_VALUE}".` },
    capability_name: { ...S, description: `The name of a new capability or the new name of a reworded one, or "${NO_VALUE}".` },
    capability_covers: { ...S, description: `What a new or reworded capability covers, or "${NO_VALUE}".` },
    row: { ...S, description: `A row code of that capability, "${NEW_CODE}", or "${NO_VALUE}".`, ...closed([...rows, NEW_CODE, NO_VALUE]) },
    row_replaces: { ...S, description: `The row a new row takes the place of, or "${NO_VALUE}".`, ...closed([...rows, NO_VALUE]) },
    row_name: { ...S, description: `The name of a new row, or "${NO_VALUE}".` },
    row_problem: { ...S, description: `The problem a new row solves, or "${NO_VALUE}".` },
    score: { type: "integer", description: "The company's coverage score for that capability with the new feature counted, 0 to 5; 0 when no capability." },
    reasoning: { ...S, description: `Why this score, at most 350 characters, or "${NO_VALUE}".` },
    why: { ...S, description: "Why this place, and not the closest other one." },
  };
  return {
    name: "place_new_features",
    description: "For every new feature: its domain, its capability, its row, what the table has to change for it, and the company's coverage with it. Every field is required.",
    input_schema: { type: "object" as const, properties: { features: { type: "array", items: { type: "object", properties, required: Object.keys(properties) } } }, required: ["features"] },
  };
}

// ————— The answer, checked —————

/** Where a new feature lands. "out": not in the table. "coverage": in a capability, no row. "row": an existing row. "new_row". */
export type TablePlace = "out" | "coverage" | "row" | "new_row";

export interface TableNewIntakeDecision {
  feature: string;
  /** A domain name as given, or "none". */
  domain: string;
  reason: string;
  /** A capability code, "new" or "none". */
  capability: string;
  change: TableChange;
  /** "" when there is no change. */
  changeDetail: string;
  /** Kept for a new capability and a reworded one; "" otherwise. */
  capabilityName: string;
  capabilityCovers: string;
  /** A row code, "new" or "none". */
  row: string;
  /** A row code, or "none". */
  rowReplaces: string;
  /** Kept for a new row; "" otherwise. */
  rowName: string;
  rowProblem: string;
  /** 0 when the feature is in no capability. */
  score: number;
  reasoning: string;
  why: string;
  place: TablePlace;
  /** It lands on an existing row this company was "not found" on. */
  fillsNotFound: boolean;
  /** Things a person should look at; the decision is kept. */
  warnings: string[];
}

const given = (v: unknown, max: number) => {
  const s = str(v, max);
  return s.toLowerCase() === NO_VALUE ? "" : s;
};

/** The longest reasoning a capability cell holds (the coverage-reasoning block). */
export const REASONING_MAX_CHARS = 350;
/** The most rows a capability holds (the main-features-count block). */
export const ROWS_MAX = 5;

/**
 * The answer, checked field by field against the closed sets and against itself. A decision that contradicts itself
 * (a row of another capability, "new capability" without a new capability, no name for a new row …) is dropped and
 * its feature comes back under `unanswered`, to be asked again. Soft doubts are kept as warnings.
 */
export function parseTableNewIntake(value: unknown, features: TableNewFeature[], table: TableForCompany): { decisions: TableNewIntakeDecision[]; dropped: number; unanswered: string[] } {
  const v = (value ?? {}) as Record<string, unknown>;
  const featureCodes = new Set(features.map((f) => f.code));
  const domainOf = new Map(table.domains.map((d) => [d.name, d]));
  const capabilityOf = new Map(capabilitiesOf(table).map((c) => [c.code, c]));
  const decisions: TableNewIntakeDecision[] = [];
  let dropped = 0;
  for (const raw of arr(v.features)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const feature = str(p.feature, 20);
    if (!featureCodes.has(feature) || decisions.some((d) => d.feature === feature)) { dropped++; continue; }
    const domain = str(p.domain, 200);
    const reason = str(p.reason, 300);
    const why = str(p.why, 400);
    const change = str(p.change, 40) as TableChange;
    if (!(TABLE_CHANGES as readonly string[]).includes(change) || !reason || !why) { dropped++; continue; }
    if (domain !== NO_VALUE && !domainOf.has(domain)) { dropped++; continue; }
    const capability = str(p.capability, 20) || NO_VALUE;
    const row = str(p.row, 20) || NO_VALUE;
    const changeDetail = given(p.change_detail, 600);
    if (change !== "none" && !changeDetail) { dropped++; continue; }
    const base = { feature, domain, reason, change, changeDetail: change === "none" ? "" : changeDetail, why, warnings: [] as string[] };
    const nowhere = { capability: NO_VALUE, capabilityName: "", capabilityCovers: "", row: NO_VALUE, rowReplaces: NO_VALUE, rowName: "", rowProblem: "", score: 0, reasoning: "", place: "out" as const, fillsNotFound: false };

    // Not in the table: no domain. The only change it can ask for is a new domain.
    if (domain === NO_VALUE) {
      if (capability !== NO_VALUE || row !== NO_VALUE || (change !== "none" && change !== "new domain")) { dropped++; continue; }
      decisions.push({ ...base, ...nowhere });
      continue;
    }
    if (change === "new domain") { dropped++; continue; }

    // In a domain, in no capability: standard, small, a claim, a use case.
    if (capability === NO_VALUE) {
      if (row !== NO_VALUE || (change !== "none" && change !== "domain wording")) { dropped++; continue; }
      decisions.push({ ...base, ...nowhere });
      continue;
    }

    const existing = capability === NEW_CODE ? null : capabilityOf.get(capability) ?? null;
    if (capability !== NEW_CODE && (!existing || !domainOf.get(domain)!.capabilities.includes(existing))) { dropped++; continue; }
    // "new capability" goes with a new capability and with nothing else.
    if ((capability === NEW_CODE) !== (change === "new capability")) { dropped++; continue; }
    const named = change === "new capability" || change === "capability wording";
    const capabilityName = named ? given(p.capability_name, 80) : "";
    const capabilityCovers = named ? given(p.capability_covers, 500) : "";
    if (named && (!capabilityName || !capabilityCovers)) { dropped++; continue; }

    const rowOf = existing?.rows.find((r) => r.code === row) ?? null;
    if (row !== NEW_CODE && row !== NO_VALUE && !rowOf) { dropped++; continue; }
    const rowName = row === NEW_CODE ? given(p.row_name, 120) : "";
    const rowProblem = row === NEW_CODE ? given(p.row_problem, 400) : "";
    if (row === NEW_CODE && (!rowName || !rowProblem)) { dropped++; continue; }
    const replaces = str(p.row_replaces, 20);
    const rowReplaces = row === NEW_CODE && existing?.rows.some((r) => r.code === replaces) ? replaces : NO_VALUE;

    const score = typeof p.score === "number" && Number.isInteger(p.score) ? p.score : NaN;
    if (!(score >= 0 && score <= 5)) { dropped++; continue; }
    const reasoning = given(p.reasoning, 600);

    if (score === 0) base.warnings.push("score 0 for a capability the feature belongs to");
    if (existing && existing.score !== null && score < existing.score) base.warnings.push(`the score goes down (${existing.score} → ${score}) for a feature that was added`);
    if (!reasoning) base.warnings.push("no reasoning for the score");
    if (reasoning.length > REASONING_MAX_CHARS) base.warnings.push(`the reasoning is ${reasoning.length} characters (at most ${REASONING_MAX_CHARS})`);
    if (row === NEW_CODE && existing && existing.rows.length >= ROWS_MAX && rowReplaces === NO_VALUE) base.warnings.push(`a new row in a capability that already has ${existing.rows.length} rows, and no row it replaces`);
    if (rowProblem && !rowProblem.startsWith("Without it,")) base.warnings.push('the new row\'s problem does not start with "Without it,"');

    decisions.push({
      ...base, capability, capabilityName, capabilityCovers, row, rowReplaces, rowName, rowProblem, score, reasoning,
      place: row === NEW_CODE ? "new_row" : rowOf ? "row" : "coverage",
      fillsNotFound: Boolean(rowOf && !rowOf.has),
    });
  }
  return { decisions, dropped, unanswered: features.map((f) => f.code).filter((code) => !decisions.some((d) => d.feature === code)) };
}
