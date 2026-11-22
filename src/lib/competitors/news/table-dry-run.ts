import { db } from "../../db";
import { callTool } from "../ai";
import { newsModel, NEWS_THINKING } from "./model";
import { parseTableAdd, renderTableAdd, TABLE_ADD_MAX_TOKENS, TABLE_ADD_SYSTEM_PROMPT, tableAddTool, type TableAddAbility, type TableAddTable } from "./table-prompt-new-intake";

/**
 * THE TABLE STEP, AS A DRY RUN — what the table prompt (news/table-prompt-new-intake.ts) WOULD do with the new abilities of
 * one intake batch. It asks, prints the decisions in plain lines and writes NOTHING: no row, no cell, no match.
 * It exists so the prompt can be judged on real answers before anything is allowed to change the table.
 */

/** Our table with codes: D1… domains, R1… rows, R1.1… feature rows. Removed and declined rows are listed like any other (match.ts). */
export async function loadTable(workspaceId: string): Promise<{ table: TableAddTable; names: Map<string, string> }> {
  const [domains, rows] = await Promise.all([
    db.competitorDomain.findMany({ where: { workspaceId }, orderBy: { position: "asc" }, select: { id: true, name: true, description: true } }),
    db.capability.findMany({
      where: { workspaceId },
      orderBy: [{ domain: { position: "asc" } }, { position: "asc" }],
      select: { id: true, name: true, description: true, domainId: true, features: { orderBy: { position: "asc" }, select: { name: true } } },
    }),
  ]);
  const names = new Map<string, string>();
  const domainCode = new Map(domains.map((d, i) => [d.id, `D${i + 1}`]));
  domains.forEach((d) => names.set(domainCode.get(d.id)!, d.name));
  const table: TableAddTable = {
    domains: domains.map((d) => ({ code: domainCode.get(d.id)!, name: d.name, definition: d.description })),
    rows: rows.map((r, i) => {
      const code = `R${i + 1}`;
      names.set(code, r.name);
      return {
        code,
        domainCode: domainCode.get(r.domainId) ?? "",
        name: r.name,
        description: r.description,
        features: r.features.map((f, j) => { names.set(`${code}.${j + 1}`, f.name); return { code: `${code}.${j + 1}`, name: f.name }; }),
      };
    }),
  };
  return { table, names };
}

export async function tableDryRunFor(company: { id: string; workspaceId: string; name: string }, batchId: string): Promise<string[]> {
  const fresh = await db.competitorNews.findMany({ where: { batchId, verdict: "new", quoteOk: true }, orderBy: { createdAt: "asc" } });
  if (fresh.length === 0) return ["TABLE DRY RUN: no new ability in this batch — nothing to ask."];
  const { table, names } = await loadTable(company.workspaceId);
  const abilities: TableAddAbility[] = fresh.map((n, i) => ({
    code: `A${i + 1}`,
    size: n.size === "feature" ? "feature" : "capability",
    name: n.name,
    what: n.what,
    problem: n.problem ?? "not stated",
    workflows: n.workflows ?? "not stated",
    who: n.audience ?? "not stated",
    quote: n.quote ?? "",
    sourceUrl: n.sourceUrl,
    parentName: n.parentName,
  }));
  const started = Date.now();
  const { value, usage } = await callTool<unknown>(TABLE_ADD_SYSTEM_PROMPT, "", renderTableAdd(company.name, abilities, table), tableAddTool(abilities.map((a) => a.code), table), {
    model: newsModel(),
    maxTokens: TABLE_ADD_MAX_TOKENS,
    thinking: NEWS_THINKING,
  });
  const { decisions, dropped, unanswered } = parseTableAdd(value, abilities, table);
  const label = (code: string) => (code === "new" ? "a NEW one" : names.has(code) ? `"${names.get(code)}"` : code);
  const lines = [`TABLE DRY RUN (nothing was written) — ${table.rows.length} rows in ${table.domains.length} domains · ${usage.input.toLocaleString("en-US")} + ${usage.output.toLocaleString("en-US")} tokens · ${((Date.now() - started) / 1000).toFixed(0)}s`];
  for (const a of abilities) {
    const d = decisions.find((x) => x.code === a.code);
    if (!d) { lines.push(`- ${a.name}: no usable answer`); continue; }
    const place = !d.inTable
      ? "NOT in the table"
      : d.as === "feature"
        ? `feature row ${d.feature === "new" ? `NEW "${d.newName}"` : label(d.feature)} under row ${label(d.row)}`
        : d.row === "new"
          ? `NEW row "${d.newName}" in domain ${d.domain === "new" ? "a NEW domain" : label(d.domain)}`
          : `existing row ${label(d.row)} (fill this company's cell)`;
    lines.push(`- ${a.name} (their ${a.size}) → ${place}`);
    if (d.newDescription) lines.push(`    ${d.newDescription}`);
    if (d.change !== "none") lines.push(`    table change proposed: ${d.change} — ${d.changeDetail}`);
    lines.push(`    why: ${d.reason}`);
  }
  if (dropped || unanswered.length) lines.push(`(${dropped} answer(s) dropped by the checks; unanswered: ${unanswered.join(", ") || "none"})`);
  return lines;
}
