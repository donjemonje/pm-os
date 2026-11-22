/**
 * The prompt of ONE small call: re-evaluate one capability's row of the coverage model (Daniel 2026-11-22). It is asked
 * when a PM adds reasoning to a cell, releases a score they had fixed, or adds, removes, renames or re-marks a feature
 * row of the capability — the score must agree with the features, and scores compare companies, so the whole row is
 * scored again, never one cell and never the whole domain.
 *
 * The prompt lives here, in the app code (Daniel 2026-11-22: prompts only in the app code). Its rules are the ones of
 * the domain-building prompt, part 3 ("Say how well each company covers each capability").
 *
 * Pure: the text, the answer form (strict: every field required), the input and the reading of the answer. No
 * database, no network — reevaluate.ts does those.
 */
import { MAX_SCORE, REASONING_MAX, scoreAgreesWithFeatures } from "./scores";

export const REEVALUATE_SYSTEM_PROMPT = `We keep a table that compares the solutions of different companies in one market. A domain is one area of the work of the people who use these solutions. A capability is a sub-domain: a smaller area inside the domain's area. Every company has a score from 0 to ${MAX_SCORE} for each capability: how well it covers the capability's area. The readers are professionals of this market.

Below are:
- the domain: its name and what it covers;
- the capability: its name and what it covers;
- the main features of the capability, the rows of the table: for each one, which companies have it and, where it is known, how it works at that company;
- the companies, the first one being the company the table is made for, each with its score so far and the reasoning of that score;
- notes that a person of that organization added about a company. They know things the pages do not say;
- scores that a person fixed.

Score every company again.

For every company write
- score: 0 to ${MAX_SCORE}. 0: the company has nothing in this capability. 1 to ${MAX_SCORE} compares the companies with one another: ${MAX_SCORE} is the company that covers this capability's area most fully among the companies given, 1 the one that covers the least of those that cover anything. Companies that cover it about equally get the same score.
- reasoning: why this score, in plain words a colleague from another field would follow: which parts of the capability's area the company covers and which it does not. At most ${REASONING_MAX} characters. No brand names of products.

Rules
- A score marked "fixed by a person" is not yours to change. Return it as it is, with its reasoning as it is, and compare the other companies against it.
- A person's note about a company is a fact about that company. Use it in that company's score, and say in its reasoning what the note changed. It can move the other companies too, because the scores compare companies.
- The score and the main features must agree. The main features are most of the judgment, not all of it. A company that has one main feature of five cannot get ${MAX_SCORE}. A company that has all the main features cannot get 1. A company that has any main feature cannot get 0.
- Keep a score that still holds. Change one only when the features, a note or the comparison ask for it.

Facts and judgment
- What a company has: only from the features and the notes given, never from what you know about the company.
- What covering this area takes: from what you know about this market.

Return every company given, each once, by its name exactly as given.`;

const S = { type: "string" };
export const REEVALUATE_TOOL = {
  name: "score_capability_row",
  description: "Every company's score for this capability and why. Every field is required.",
  input_schema: {
    type: "object",
    properties: { companies: { type: "array", items: { type: "object", properties: { company: S, score: { type: "integer" }, reasoning: S }, required: ["company", "score", "reasoning"] } } },
    required: ["companies"],
  },
};

export interface RowCompany {
  /** "own" or the competitor's id. */
  key: string;
  name: string;
  score: number | null;
  reasoning: string | null;
  /** A person fixed the score. */
  locked: boolean;
  /** A person's note about this company for this capability. */
  note: string | null;
}
export interface RowFeature {
  name: string;
  /** Per company key: has it, and how it works there when known. A company not listed does not have it. */
  has: Record<string, { how: string | null }>;
}
export interface RowInput {
  domain: { name: string; covers: string };
  capability: { name: string; covers: string };
  features: RowFeature[];
  companies: RowCompany[];
}

/** The text sent with the prompt. The same row always gives the same text. */
export function renderRow(row: RowInput): string {
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    `THE DOMAIN\n${row.domain.name} — ${line(row.domain.covers)}`,
    `THE CAPABILITY\n${row.capability.name} — ${line(row.capability.covers)}`,
    `THE MAIN FEATURES (${row.features.length})\n${row.features.map((f, i) => `${i + 1}. ${f.name}\n${row.companies.map((c) => `   ${c.name}: ${f.has[c.key] ? `has it${f.has[c.key].how ? ` — ${line(f.has[c.key].how!)}` : ""}` : "not found"}`).join("\n")}`).join("\n") || "(none)"}`,
    `THE COMPANIES\n${row.companies.map((c, i) => [`${c.name}${i === 0 ? " (the table is made for this company)" : ""}`, `   Score so far: ${c.score ?? "none yet"}${c.locked ? " — fixed by a person" : ""}`, `   Reasoning so far: ${c.reasoning ? line(c.reasoning) : "none"}`, ...(c.note ? [`   A person's note: ${line(c.note)}`] : [])].join("\n")).join("\n")}`,
  ].join("\n\n");
}

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The answer, checked: every company once (names compared by their letters and digits — the model sometimes adds a
 * stray space or dash), a whole score 0-5, a reasoning of at most 350 characters, the score in agreement with the
 * main features. A company whose score a person fixed keeps its own score and reasoning whatever the answer says.
 * Any problem makes the whole answer unusable: nothing of it is applied.
 */
export function readRowAnswer(raw: unknown, row: RowInput): { scores: Array<{ key: string; score: number; reasoning: string }>; problems: string[] } {
  const problems: string[] = [];
  const list = raw && typeof raw === "object" && Array.isArray((raw as { companies?: unknown }).companies) ? ((raw as { companies: unknown[] }).companies as Array<Record<string, unknown>>) : null;
  if (!list) return { scores: [], problems: ["the answer has no list of companies"] };
  const scores: Array<{ key: string; score: number; reasoning: string }> = [];
  for (const c of row.companies) {
    if (c.locked && c.score != null) { scores.push({ key: c.key, score: c.score, reasoning: c.reasoning ?? "" }); continue; }
    const mine = list.filter((x) => x && typeof x.company === "string" && norm(x.company) === norm(c.name));
    if (mine.length !== 1) { problems.push(`${c.name}: ${mine.length ? "returned more than once" : "not returned"}`); continue; }
    const score = mine[0].score; const reasoning = typeof mine[0].reasoning === "string" ? mine[0].reasoning.trim() : "";
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) { problems.push(`${c.name}: the score is not a whole number 0-${MAX_SCORE}`); continue; }
    if (!reasoning) { problems.push(`${c.name}: no reasoning`); continue; }
    if (reasoning.length > REASONING_MAX) { problems.push(`${c.name}: the reasoning is ${reasoning.length} characters`); continue; }
    const had = row.features.filter((f) => f.has[c.key]).length;
    // A person's note can be the reason for a score above 0 with no feature; the other two rules hold with or without a note.
    if (!scoreAgreesWithFeatures(score, had, row.features.length)) { problems.push(`${c.name}: score ${score} with ${had} of ${row.features.length} main features`); continue; }
    scores.push({ key: c.key, score, reasoning });
  }
  return { scores: problems.length ? [] : scores, problems };
}
