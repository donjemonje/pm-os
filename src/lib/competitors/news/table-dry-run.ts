import { db } from "../../db";
import { callTool } from "../ai";
import { newsModel, NEWS_THINKING } from "./model";
import {
  NEW_CODE,
  parseTableNewIntake,
  renderTableNewIntake,
  TABLE_NEW_INTAKE_BATCH,
  TABLE_NEW_INTAKE_MAX_TOKENS,
  TABLE_NEW_INTAKE_SYSTEM_PROMPT,
  TABLE_NEW_INTAKE_VERSION,
  tableNewIntakeTool,
  type TableCapability,
  type TableForCompany,
  type TableNewFeature,
  type TableNewIntakeDecision,
} from "./table-prompt-new-intake";

/**
 * THE TABLE STEP, AS A DRY RUN — what the table prompt (news/table-prompt-new-intake.ts) WOULD do with the new
 * features of one intake batch. It asks, prints the decisions in plain lines and writes NOTHING: no row, no cell,
 * no score, no wording (Daniel 2026-11-22: "don't execute any table changes yet"). It exists so the prompt can be
 * judged on real answers before anything is allowed to change the table.
 */

/** "4/5 — covers …": how a capability cell holds its coverage score today (the loader writes it into the reasoning). */
const SCORED = /^\s*([0-5])\s*\/\s*5\s*—\s*([\s\S]*)$/;
const has = (value: string | null | undefined) => value === "found" || value === "low";

function cell(value: string | null | undefined, reasoning: string | null | undefined): { score: number | null; reasoning: string } {
  const m = (reasoning ?? "").match(SCORED);
  if (m) return { score: Number(m[1]), reasoning: m[2].trim() };
  return { score: has(value) ? null : 0, reasoning: (reasoning ?? "").trim() };
}

/**
 * The market in one line. It is not stored in the app yet (the scripts that build the table hold it as a constant):
 * the caller gives it, or COMPETITORS_MARKET does; without either the request says "(not recorded)".
 */
export function marketLine(given?: string): string {
  return (given ?? process.env.COMPETITORS_MARKET ?? "").trim();
}

/**
 * The table as it stands for ONE company: the domains, their capabilities (C1…) with this company's coverage and
 * the other companies' scores, and their feature rows (C1.1…) with this company's mark. Active rows only; a PM's
 * correction of a mark wins.
 */
export async function loadTableFor(company: { id: string; workspaceId: string; name: string }, market?: string): Promise<{ table: TableForCompany; names: Map<string, string> }> {
  const { workspaceId } = company;
  const [workspace, domains, capabilities, companies, marks] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, select: { organization: { select: { name: true } } } }),
    db.competitorDomain.findMany({ where: { workspaceId, state: "active" }, orderBy: { position: "asc" }, select: { id: true, name: true, description: true, doneBy: true } }),
    db.capability.findMany({
      where: { workspaceId, state: "active" },
      orderBy: { position: "asc" },
      select: {
        id: true, name: true, description: true, domainId: true, ourStatus: true, ourEvidence: true,
        features: { where: { state: "active" }, orderBy: { position: "asc" }, select: { id: true, name: true, description: true } },
        statuses: { select: { competitorId: true, value: true, overrideValue: true, reasoning: true } },
      },
    }),
    db.competitor.findMany({ where: { workspaceId, deletedAt: null, isOwn: false }, orderBy: { position: "asc" }, select: { id: true, name: true } }),
    db.featureStatus.findMany({ where: { workspaceId, competitorId: company.id }, select: { featureId: true, value: true, overrideValue: true } }),
  ]);
  const own = workspace?.organization.name ?? "";
  const markOf = new Map(marks.map((m) => [m.featureId, has(m.overrideValue ?? m.value)]));
  const names = new Map<string, string>();
  let n = 0;
  const table: TableForCompany = {
    market: marketLine(market),
    company: company.name,
    domains: domains.map((d) => ({
      name: d.name,
      covers: d.description,
      who: d.doneBy,
      capabilities: capabilities.filter((c) => c.domainId === d.id).map((c): TableCapability => {
        const code = `C${++n}`;
        names.set(code, c.name);
        const mine = c.statuses.find((s) => s.competitorId === company.id);
        const ownReasoning = c.ourEvidence && typeof c.ourEvidence === "object" && !Array.isArray(c.ourEvidence) ? String((c.ourEvidence as Record<string, unknown>).reasoning ?? "") : "";
        return {
          code,
          name: c.name,
          covers: c.description,
          ...cell(mine?.overrideValue ?? mine?.value, mine?.reasoning),
          others: [
            ...(own ? [{ company: own, score: cell(c.ourStatus, ownReasoning).score }] : []),
            ...companies.filter((o) => o.id !== company.id).map((o) => {
              const s = c.statuses.find((x) => x.competitorId === o.id);
              return { company: o.name, score: cell(s?.overrideValue ?? s?.value, s?.reasoning).score };
            }),
          ],
          rows: c.features.map((f, j) => {
            names.set(`${code}.${j + 1}`, f.name);
            return { code: `${code}.${j + 1}`, name: f.name, problem: f.description, has: markOf.get(f.id) ?? false };
          }),
        };
      }),
    })),
  };
  return { table, names };
}

/** One decision in plain lines. */
export function decisionLines(f: TableNewFeature, d: TableNewIntakeDecision, table: TableForCompany, names: Map<string, string>): string[] {
  const capability = table.domains.flatMap((x) => x.capabilities).find((c) => c.code === d.capability) ?? null;
  const capabilityLabel = d.capability === NEW_CODE ? `a NEW capability "${d.capabilityName}"` : `"${names.get(d.capability) ?? d.capability}"`;
  const place =
    d.place === "out"
      ? d.domain === "none" ? "NOT in the table (no domain)" : `NOT in the table: work of "${d.domain}" that deserves no place`
      : d.place === "row"
        ? `existing row "${names.get(d.row) ?? d.row}" of ${capabilityLabel} — ${d.fillsNotFound ? `fills ${table.company}'s "not found"` : `${table.company} already has this row`}`
        : d.place === "new_row"
          ? `NEW row "${d.rowName}" in ${capabilityLabel}${d.rowReplaces !== "none" ? `, in place of "${names.get(d.rowReplaces) ?? d.rowReplaces}"` : ""}`
          : `no row — counts in the coverage of ${capabilityLabel}`;
  const lines = [`- ${f.name} → ${place}`, `    domain: ${d.domain} (${d.reason})`];
  if (d.rowProblem) lines.push(`    the new row's problem: ${d.rowProblem}`);
  if (d.place !== "out") lines.push(`    coverage of ${capabilityLabel}: ${capability ? (capability.score === null ? "no score" : `${capability.score}/5`) : "—"} → ${d.score}/5${d.reasoning ? ` — ${d.reasoning}` : ""}`);
  if (d.change !== "none") lines.push(`    table change proposed: ${d.change} — ${d.changeDetail}${d.capabilityName && d.capability !== NEW_CODE ? ` (new wording: "${d.capabilityName}" — ${d.capabilityCovers})` : d.capability === NEW_CODE ? ` (covers: ${d.capabilityCovers})` : ""}`);
  lines.push(`    why: ${d.why}`);
  for (const w of d.warnings) lines.push(`    CHECK: ${w}`);
  return lines;
}

export async function tableDryRunFor(company: { id: string; workspaceId: string; name: string }, batchId: string, opts: { market?: string } = {}): Promise<string[]> {
  const fresh = await db.competitorNews.findMany({ where: { batchId, verdict: "new", quoteOk: true }, orderBy: { createdAt: "asc" } });
  if (fresh.length === 0) return ["TABLE DRY RUN: no new feature in this batch — nothing to ask."];
  const { table, names } = await loadTableFor(company, opts.market);
  const features: TableNewFeature[] = fresh.map((n, i) => ({
    code: `N${i + 1}`,
    name: n.name,
    problem: n.problem ?? "not stated",
    howItWorks: n.what,
    users: n.audience ?? "not stated",
    workflows: n.workflows ?? "not stated",
  }));
  const capabilities = table.domains.flatMap((d) => d.capabilities);
  const model = newsModel();
  const started = Date.now();
  let input = 0, output = 0, dropped = 0;
  const decisions: TableNewIntakeDecision[] = [];
  const unanswered: string[] = [];
  for (let at = 0; at < features.length; at += TABLE_NEW_INTAKE_BATCH) {
    const batch = features.slice(at, at + TABLE_NEW_INTAKE_BATCH);
    const { value, usage } = await callTool<unknown>(TABLE_NEW_INTAKE_SYSTEM_PROMPT, "", renderTableNewIntake(batch, table), tableNewIntakeTool(batch.map((f) => f.code), table), {
      model,
      maxTokens: TABLE_NEW_INTAKE_MAX_TOKENS,
      thinking: NEWS_THINKING,
    });
    const parsed = parseTableNewIntake(value, batch, table);
    decisions.push(...parsed.decisions);
    unanswered.push(...parsed.unanswered);
    dropped += parsed.dropped;
    input += usage.input;
    output += usage.output;
  }
  const lines = [
    `TABLE DRY RUN (nothing was written) — prompt ${TABLE_NEW_INTAKE_VERSION} · model ${model}, thinking ${NEWS_THINKING} · ${capabilities.length} capabilities and ${capabilities.reduce((s, c) => s + c.rows.length, 0)} rows in ${table.domains.length} domains · ${input.toLocaleString("en-US")} + ${output.toLocaleString("en-US")} tokens · ${((Date.now() - started) / 1000).toFixed(0)}s`,
  ];
  if (!table.market) lines.push("(the market's one line is not recorded in the app: the request said so)");
  for (const f of features) {
    const d = decisions.find((x) => x.feature === f.code);
    if (d) lines.push(...decisionLines(f, d, table, names));
    else lines.push(`- ${f.name}: no usable answer`);
  }
  if (dropped || unanswered.length) lines.push(`(${dropped} answer(s) dropped by the checks; unanswered: ${unanswered.join(", ") || "none"})`);
  return lines;
}
