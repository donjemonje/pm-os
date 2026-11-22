import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { codeList, type NewsList } from "./intake";

/**
 * A COMPANY'S KNOWLEDGE BASE in the database (CompetitorKnowledge) — the flat list of features the news intake
 * compares new pages with (News Feed & Notifications PRD; Daniel 2026-11-22: "the knowledge base moves into the
 * database; the existing files are migrated, so only new work needs new code").
 *
 * Three things live here:
 *   - reading a list file of the form "features-v3" into rows (importKnowledge) — the lists made before the
 *     database held them;
 *   - the list as the intake shows it (loadKnowledgeList);
 *   - growing the list: every new ability the intake found is added to it (addNewAbilities), so the same ability
 *     is news only once.
 */

// ————— The file form (features-v3) —————

export interface KnowledgeFileItem {
  name?: unknown;
  company_name?: unknown;
  problem?: unknown;
  problem_source?: unknown;
  how_it_works?: unknown;
  users?: unknown;
  workflows?: unknown;
  evidence?: unknown;
}
export interface KnowledgeFile {
  company?: unknown;
  label?: unknown;
  form?: unknown;
  items?: unknown;
  integrations?: unknown;
}

export const KNOWLEDGE_FORM = "features-v3";

export interface KnowledgeRow {
  name: string;
  companyName: string;
  problem: string;
  problemSource: string;
  howItWorks: string;
  users: Prisma.InputJsonValue;
  workflows: Prisma.InputJsonValue;
  evidence: Prisma.InputJsonValue;
}

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** What is wrong with a file, or null: only the current form is taken (an older form has capabilities with features under them). */
export function knowledgeFileProblem(file: KnowledgeFile): string | null {
  if (file.form !== KNOWLEDGE_FORM) return `its form is "${String(file.form ?? "not stated")}", not "${KNOWLEDGE_FORM}" (an older list form is not imported)`;
  if (!text(file.company)) return "it names no company";
  if (!Array.isArray(file.items) || file.items.length === 0) return "it holds no items";
  return null;
}

/** The rows of a file, in its order. An item with no name is left out (counted by the caller: items − rows). Pure. */
export function knowledgeRows(file: KnowledgeFile): KnowledgeRow[] {
  const rows: KnowledgeRow[] = [];
  for (const raw of list(file.items)) {
    const i = (raw ?? {}) as KnowledgeFileItem;
    const name = text(i.name);
    if (!name) continue;
    rows.push({
      name,
      companyName: text(i.company_name),
      problem: text(i.problem),
      problemSource: text(i.problem_source),
      howItWorks: text(i.how_it_works),
      users: list(i.users) as Prisma.InputJsonValue,
      workflows: list(i.workflows) as Prisma.InputJsonValue,
      evidence: list(i.evidence) as Prisma.InputJsonValue,
    });
  }
  return rows;
}

/** The tool names of a file's integrations, each once (case kept as first seen). Pure. */
export function knowledgeIntegrations(file: KnowledgeFile): string[] {
  const seen = new Map<string, string>();
  for (const raw of list(file.integrations)) {
    const tool = text(typeof raw === "string" ? raw : (raw as { tool?: unknown } | null)?.tool);
    if (tool && !seen.has(tool.toLowerCase())) seen.set(tool.toLowerCase(), tool);
  }
  return [...seen.values()];
}

// ————— The database —————

export interface ImportOutcome {
  competitorId: string;
  company: string;
  rows: number;
  leftOut: number;
  integrations: number;
  /** Rows of an earlier read that this import replaced. */
  replaced: number;
  /** New abilities the news intake had added: kept. */
  keptFromNews: number;
  readyAt: Date;
}

/**
 * A list file becomes the company's knowledge base. The rows of an earlier read are replaced (a list is read whole,
 * never merged); what the news intake added since stays. `readyAt` = when the list was made: news is what the
 * company's pages add after it. One transaction: a company never has half a list.
 */
export async function importKnowledge(competitor: { id: string; workspaceId: string; name: string }, file: KnowledgeFile, readyAt: Date): Promise<ImportOutcome> {
  const problem = knowledgeFileProblem(file);
  if (problem) throw new Error(`The file is not imported: ${problem}.`);
  const rows = knowledgeRows(file);
  const tools = knowledgeIntegrations(file);
  const label = text(file.label);
  return db.$transaction(async (tx) => {
    const replaced = await tx.competitorKnowledge.deleteMany({ where: { competitorId: competitor.id, source: "read" } });
    const keptFromNews = await tx.competitorKnowledge.count({ where: { competitorId: competitor.id, source: "news" } });
    for (let i = 0; i < rows.length; i += 200) {
      await tx.competitorKnowledge.createMany({
        data: rows.slice(i, i + 200).map((r, k) => ({ ...r, workspaceId: competitor.workspaceId, competitorId: competitor.id, source: "read", label, position: i + k })),
      });
    }
    await tx.competitorIntegration.deleteMany({ where: { competitorId: competitor.id, source: "read" } });
    if (tools.length) {
      await tx.competitorIntegration.createMany({ data: tools.map((tool) => ({ workspaceId: competitor.workspaceId, competitorId: competitor.id, tool, source: "read" })), skipDuplicates: true });
    }
    await tx.competitor.update({ where: { id: competitor.id }, data: { knowledgeReadyAt: readyAt } });
    return { competitorId: competitor.id, company: competitor.name, rows: rows.length, leftOut: list(file.items).length - rows.length, integrations: tools.length, replaced: replaced.count, keptFromNews, readyAt };
  }, { timeout: 60_000 });
}

/** The company's list as the intake shows it: the read's features in their order, then what the news added. Empty = no knowledge base. */
export async function loadKnowledgeList(competitorId: string): Promise<NewsList> {
  const [rows, tools] = await Promise.all([
    db.competitorKnowledge.findMany({
      where: { competitorId },
      orderBy: [{ source: "desc" }, { position: "asc" }, { createdAt: "asc" }], // "read" before "news"
      select: { id: true, name: true, companyName: true, howItWorks: true },
    }),
    db.competitorIntegration.findMany({ where: { competitorId }, orderBy: { tool: "asc" }, select: { tool: true } }),
  ]);
  return codeList(rows.map((r) => ({ id: r.id, name: r.name, companyName: r.companyName, description: r.howItWorks })), tools.map((t) => t.tool));
}

/**
 * The new abilities of one intake batch join the company's knowledge base, each once (a row is tied to its news row
 * by `label`). Only abilities whose evidence is on its page; never the made-up news of a simulation. Returns how many were added.
 */
export async function addNewAbilities(batchId: string): Promise<number> {
  const fresh = await db.competitorNews.findMany({ where: { batchId, verdict: "new", quoteOk: true, simulated: false }, orderBy: { createdAt: "asc" } });
  if (fresh.length === 0) return 0;
  const already = new Set((await db.competitorKnowledge.findMany({ where: { source: "news", label: { in: fresh.map((n) => n.id) } }, select: { label: true } })).map((r) => r.label));
  const toAdd = fresh.filter((n) => !already.has(n.id));
  if (toAdd.length === 0) return 0;
  const last = await db.competitorKnowledge.aggregate({ where: { competitorId: toAdd[0].competitorId }, _max: { position: true } });
  let position = (last._max.position ?? -1) + 1;
  await db.competitorKnowledge.createMany({
    data: toAdd.map((n) => ({
      workspaceId: n.workspaceId,
      competitorId: n.competitorId,
      name: n.name,
      companyName: n.companyName ?? "",
      problem: n.problem ?? "",
      problemSource: n.problemSource ?? "",
      howItWorks: n.what,
      // The intake stores users and workflows as one line each; the list keeps them as it got them.
      users: n.audience ? [{ name: n.audience, kind: "person" }] : [],
      workflows: n.workflows ? [{ workflow: n.workflows, step: "" }] : [],
      evidence: (n.evidence ?? []) as Prisma.InputJsonValue,
      source: "news",
      label: n.id,
      position: position++,
    })),
  });
  return toAdd.length;
}
