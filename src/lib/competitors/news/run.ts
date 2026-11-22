import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { callTool } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { modelFor, thinkingFor } from "../models";
import { codeItems, NEWS_MAX_TOKENS, NEWS_SYSTEM_PROMPT, newsTool, parseNews, renderNews, type NewsListItem, type NewsPage, type NewsPiece } from "./intake";

/**
 * THE NEWS INTAKE — the database side (the rules and the prompt are news/intake.ts).
 *
 * A batch = the pages of one company handed in together (the new or changed pages of one scan; the made-up pages
 * of a simulation). One request per page; every piece of news an answer holds becomes one CompetitorNews row,
 * whatever its verdict. One notification per batch (news/email.ts).
 */

export interface IntakeCompany {
  id: string;
  workspaceId: string;
  name: string;
}

/** The company's list as the intake shows it: capabilities in their order, each with its features. */
export async function loadNewsList(competitorId: string): Promise<NewsListItem[]> {
  const rows = await db.competitorItem.findMany({
    where: { competitorId },
    orderBy: { position: "asc" },
    select: { id: true, kind: true, name: true, description: true, parentItemId: true },
  });
  const capabilities = rows.filter((r) => r.kind === "capability").map((k) => ({ ...k, features: rows.filter((f) => f.kind === "feature" && f.parentItemId === k.id) }));
  return codeItems(capabilities);
}

export interface PageOutcome {
  page: NewsPage;
  pageIsAbout: string;
  pieces: NewsPiece[];
  dropped: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** The call failed: what the provider or the parser said. No rows were written for the page. */
  error: string | null;
}

/** One page: ask, check, store. Never throws — a failed page is reported, the batch goes on. */
export async function intakePage(company: IntakeCompany, items: NewsListItem[], page: NewsPage, opts: { batchId: string; simulated: boolean; injected?: string }): Promise<PageOutcome> {
  const model = modelFor("read");
  const started = Date.now();
  try {
    const { value, usage } = await callTool<unknown>(NEWS_SYSTEM_PROMPT, "", renderNews(company.name, items, page), newsTool(items), {
      model,
      maxTokens: NEWS_MAX_TOKENS,
      thinking: thinkingFor("read"),
      injected: opts.injected,
    });
    const ms = Date.now() - started;
    const parsed = parseNews(value, items, page);
    if (parsed.pieces.length) {
      await db.competitorNews.createMany({
        data: parsed.pieces.map((p) => ({
          workspaceId: company.workspaceId,
          competitorId: company.id,
          batchId: opts.batchId,
          verdict: p.verdict,
          otherType: p.otherType,
          size: p.size,
          name: p.name,
          what: p.what,
          problem: p.problem,
          workflows: p.workflows,
          audience: p.audience,
          quote: p.quote,
          quoteOk: p.quoteOk,
          reason: p.reason,
          coveredItemId: p.covered?.id ?? null,
          coveredName: p.covered?.name ?? null,
          parentItemId: p.parent?.id ?? null,
          parentName: p.parent?.name ?? null,
          sourceUrl: page.url,
          sourceTitle: page.title,
          sourceKind: page.kind,
          publishedAt: page.publishedAt ? new Date(page.publishedAt) : null,
          simulated: opts.simulated,
          inputTokens: usage.input,
          outputTokens: usage.output,
          ms,
          model,
        })),
      });
    }
    return { page, pageIsAbout: parsed.pageIsAbout, pieces: parsed.pieces, dropped: parsed.dropped, inputTokens: usage.input, outputTokens: usage.output, ms, error: null };
  } catch (e) {
    return { page, pageIsAbout: "", pieces: [], dropped: 0, inputTokens: 0, outputTokens: 0, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface BatchOutcome {
  batchId: string;
  pages: PageOutcome[];
}

/** A batch of pages of one company, a few at a time. */
export async function intakeBatch(company: IntakeCompany, pages: NewsPage[], opts: { simulated: boolean; atOnce?: number; onPage?: (o: PageOutcome) => void }): Promise<BatchOutcome> {
  const batchId = randomUUID();
  const items = await loadNewsList(company.id);
  if (items.length === 0) throw new Error(`${company.name} has no list yet: news starts after its first full analysis.`);
  const out: PageOutcome[] = new Array(pages.length);
  let next = 0;
  const worker = async () => {
    while (next < pages.length) {
      const i = next++;
      out[i] = await intakePage(company, items, pages[i], { batchId, simulated: opts.simulated });
      opts.onPage?.(out[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.atOnce ?? 3, pages.length) }, worker));
  const all = out.flatMap((o) => o.pieces);
  await recordCompetitorEvent(company.workspaceId, null, "cmp_news_intake", {
    competitorId: company.id,
    batchId,
    pages: pages.length,
    failedPages: out.filter((o) => o.error).length,
    new: all.filter((p) => p.verdict === "new").length,
    covered: all.filter((p) => p.verdict === "covered").length,
    other: all.filter((p) => p.verdict === "other").length,
    inputTokens: out.reduce((s, o) => s + o.inputTokens, 0),
    outputTokens: out.reduce((s, o) => s + o.outputTokens, 0),
    simulated: opts.simulated,
  });
  return { batchId, pages: out };
}
