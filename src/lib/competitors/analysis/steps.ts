import { db } from "../../db";
import type { AnswerError } from "../ai";
import { COMPETITORS_COPY as C } from "../copy";
import { AnalysisError, type RunContext } from "./engine";
import { pickPages } from "./kinds";
import { analysisConcurrency, estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { parseResearch, renderResearch, RESEARCH_MAX_TOKENS, RESEARCH_SYSTEM_PROMPT, RESEARCH_TOOL, RESEARCH_VERSION } from "./prompts";
import { readKey, researchTodo, tooManyFailed } from "./todo";

/**
 * The database side of the six steps of an analysis run (Capability Analysis, "How the analysis runs").
 * Every step computes its to-do from the tables and saves each unit of work in one transaction, so a run that
 * stopped continues with exactly what is left. The rules themselves are the pure modules next to this file.
 */

/** Tokens of instructions and schema a research call carries besides the page. */
const RESEARCH_OVERHEAD_TOKENS = 450;
const CHUNK = 1000;

export interface StoredPage {
  id: string;
  url: string;
  hash: string;
  chars: number;
  state: string;
  kind: string;
  sourceId: string;
  sourceType: string;
  hasText: boolean;
  analyzedKey: string | null;
  factsKey: string | null;
}

/** Every stored page of the competitor, all its sources, without the text. */
export async function loadPages(competitorId: string): Promise<StoredPage[]> {
  const rows = await db.sourcePage.findMany({
    where: { source: { competitorId } },
    select: { id: true, url: true, hash: true, chars: true, state: true, kind: true, sourceId: true, analyzedKey: true, factsKey: true, source: { select: { type: true } } },
  });
  // "Has text" without loading it: a page that was read has characters; a page whose text was dropped has none.
  const textless = new Set((await db.sourcePage.findMany({ where: { source: { competitorId }, text: null }, select: { id: true } })).map((p) => p.id));
  return rows.map((r) => ({ id: r.id, url: r.url, hash: r.hash, chars: r.chars, state: r.state, kind: r.kind, sourceId: r.sourceId, sourceType: r.source.type, hasText: !textless.has(r.id), analyzedKey: r.analyzedKey, factsKey: r.factsKey }));
}

/** The pages the analysis reads (kinds.ts): strong, plus weak when the workspace reads them. */
export async function pickedPages(ctx: RunContext): Promise<Array<StoredPage & { tier: "strong" | "weak"; pageKind: string }>> {
  return pickPages(await loadPages(ctx.competitor.id), { readWeak: ctx.readWeak });
}

// ————— 1. Research: one call per page —————

export interface ResearchPlan {
  /** Pages the analysis reads at all. */
  picked: number;
  /** Of those, the pages whose current text was not read yet, in address order. */
  todo: Array<StoredPage & { tier: "strong" | "weak"; pageKind: string }>;
}

/**
 * Clean-up (code only, every run) and the to-do. A finding lives only while its page is read and its text is the
 * text it was read from: findings of pages that left the picked set (removed, text gone, kind now skipped, weak
 * pages switched off) are deleted and the page is marked not analyzed.
 */
export async function planResearch(ctx: RunContext): Promise<ResearchPlan> {
  const pages = await loadPages(ctx.competitor.id);
  const picked = pickPages(pages, { readWeak: ctx.readWeak });
  const pickedIds = new Set(picked.map((p) => p.id));
  const dropped = pages.filter((p) => !pickedIds.has(p.id)).map((p) => p.id);
  let removed = 0;
  for (let i = 0; i < dropped.length; i += CHUNK) {
    const ids = dropped.slice(i, i + CHUNK);
    removed += (await db.pageFinding.deleteMany({ where: { competitorId: ctx.competitor.id, pageId: { in: ids } } })).count;
    await db.sourcePage.updateMany({ where: { id: { in: ids }, analyzedKey: { not: null } }, data: { analyzedKey: null, analysisError: null } });
  }
  if (removed) {
    ctx.counters.findingsRemoved += removed;
    ctx.log("info", `${removed} finding${removed === 1 ? "" : "s"} removed: their pages are no longer read (removed, emptied, or of a kind that is skipped)`);
  }
  const todo = researchTodo(picked, RESEARCH_VERSION);
  if (ctx.progress.pagesTotal === 0) {
    ctx.progress.pagesTotal = todo.length;
    ctx.progress.pagesDone = 0;
  }
  ctx.log("info", `${pages.length} stored page${pages.length === 1 ? "" : "s"}: ${picked.length} read by the analysis${ctx.readWeak ? " (blog, news and press included)" : ""}, ${todo.length} new or changed since they were last read`);
  await ctx.flush();
  return { picked: picked.length, todo };
}

function injectedResearch(ctx: RunContext, url: string): string | undefined {
  if (!ctx.answers) return undefined;
  return ctx.answers.research?.[url] ?? ctx.answers.research?.["*"] ?? '{"capabilities": []}';
}

export async function researchStep(ctx: RunContext, plan: ResearchPlan): Promise<void> {
  const competitorId = ctx.competitor.id;
  let failed = 0;
  if (plan.todo.length) {
    await ctx.paced({
      items: plan.todo,
      concurrency: analysisConcurrency(),
      estimate: (p) => estimateTokens(p.chars) + RESEARCH_OVERHEAD_TOKENS + OUTPUT_RESERVE,
      work: async (p) => {
        // The text and its hash in one read: the key written below is the hash of the text that was read, so a page
        // a scan changes meanwhile is simply due again.
        const page = await db.sourcePage.findUnique({ where: { id: p.id }, select: { text: true, hash: true, title: true, kind: true } });
        if (!page || page.text == null) return 0;
        const r = await ctx.call<Record<string, unknown>>(
          RESEARCH_SYSTEM_PROMPT,
          "",
          renderResearch({ url: p.url, title: page.title ?? "", text: page.text, kind: page.kind, sourceLabel: C.profile.sourceTypes[p.sourceType] ?? p.sourceType }),
          RESEARCH_TOOL,
          { maxTokens: RESEARCH_MAX_TOKENS, thinking: "low", injected: injectedResearch(ctx, p.url) },
        );
        const parsed = parseResearch(r.value, page.text);
        await db.$transaction([
          db.pageFinding.deleteMany({ where: { pageId: p.id } }),
          db.pageFinding.createMany({
            data: parsed.findings.map((f) => ({
              workspaceId: ctx.run.workspaceId, competitorId, pageId: p.id, pageHash: page.hash, analysisId: ctx.run.id, origin: "research",
              kind: f.kind, wording: f.wording, parentWording: f.parentWording, quote: f.quote, reasoning: f.reasoning,
            })),
          }),
          db.sourcePage.update({ where: { id: p.id }, data: { analyzedKey: readKey(RESEARCH_VERSION, page.hash), analyzedAt: new Date(), analysisError: null } }),
        ]);
        ctx.progress.pagesDone++;
        ctx.counters.pagesRead++;
        ctx.counters.findings += parsed.findings.length;
        ctx.counters.quotesDropped += parsed.dropped.noQuote;
        ctx.counters.piiHits += parsed.dropped.pii;
        if (parsed.dropped.over) ctx.log("warn", `${parsed.dropped.over} item${parsed.dropped.over === 1 ? "" : "s"} beyond the per-page limit were left out`, p.url);
        return r.tokens;
      },
      // A page whose answer is unusable is recorded and skipped: it is asked again only when its text or the prompt changes.
      onAnswerError: async (p, e: AnswerError) => {
        await db.$transaction([
          db.pageFinding.deleteMany({ where: { pageId: p.id } }),
          db.sourcePage.update({ where: { id: p.id }, data: { analyzedKey: readKey(RESEARCH_VERSION, p.hash), analyzedAt: new Date(), analysisError: e.message.slice(0, 300) } }),
        ]);
        failed++;
        ctx.progress.pagesDone++;
        ctx.counters.pagesFailed++;
        ctx.log("warn", `Page skipped — PMOS AI's answer was unusable: ${e.message.slice(0, 200)}`, p.url);
        // Many unusable answers are the model's or the prompt's problem, not a page's.
        if (tooManyFailed(failed, plan.todo.length)) throw new AnalysisError("answer", `${failed} of ${plan.todo.length} pages got an unusable answer from PMOS AI — stopping`);
      },
    });
    const read = plan.todo.length - failed;
    ctx.log("info", `Research: ${read} page${read === 1 ? "" : "s"} read${failed ? `, ${failed} skipped (unusable answer)` : ""}`);
    const total = ctx.counters.findings + ctx.counters.quotesDropped;
    if (total > 0 && ctx.counters.quotesDropped > total / 4) ctx.log("warn", `${ctx.counters.quotesDropped} of ${total} findings were dropped because their quote is not on the page — more than a quarter`);
  }
  // The change has been read: the texts before it are dropped (no retention).
  const released = await db.sourcePage.updateMany({ where: { source: { competitorId }, previousText: { not: null } }, data: { previousText: null, previousHash: null } });
  if (released.count) ctx.log("info", `${released.count} previous page text${released.count === 1 ? "" : "s"} dropped (the change was read)`);
  await ctx.flush();
}

// ————— 2–6. Built in the next steps of the build —————

export async function mergeStep(_ctx: RunContext): Promise<void> {}
export async function matchStep(_ctx: RunContext): Promise<void> {}
export async function secondLookStep(_ctx: RunContext): Promise<void> {}
export async function applyStep(_ctx: RunContext): Promise<void> {}
export async function factsStep(_ctx: RunContext): Promise<void> {}
