import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { callTool } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { newsModel, NEWS_THINKING } from "./model";
import { loadKnowledgeList } from "./knowledge";
import { codeList, NEWS_MAX_TOKENS, NEWS_SYSTEM_PROMPT, newsTool, parseNews, planRequests, renderList, renderPages, type NewsList, type NewsPage, type NewsPiece, type SentPage } from "./intake";

/**
 * THE NEWS INTAKE — the database side (the rules and the prompt are news/intake.ts).
 *
 * A batch = the pages of one company handed in together (the new and the changed pages of one scan; the made-up
 * pages of a simulation). The pages go out several per request (intake.ts planRequests); every thing an answer
 * names becomes one CompetitorNews row, whatever its verdict. One notification per batch (news/email.ts).
 */

export interface IntakeCompany {
  id: string;
  workspaceId: string;
  name: string;
}

/**
 * The company's list: its knowledge base (CompetitorKnowledge — a flat list of features, news/knowledge.ts).
 * A company whose knowledge base is not in the database yet falls back to the items of the older analysis, as one
 * flat list — a capability and a feature are each a line (the intake has no sizes).
 */
export async function loadNewsList(competitorId: string): Promise<NewsList> {
  const knowledge = await loadKnowledgeList(competitorId);
  if (knowledge.features.length) return knowledge;
  const rows = await db.competitorItem.findMany({
    where: { competitorId },
    orderBy: { position: "asc" },
    select: { id: true, kind: true, name: true, description: true, parentItemId: true },
  });
  const capabilities = rows.filter((r) => r.kind === "capability");
  const ordered = capabilities.flatMap((k) => [k, ...rows.filter((f) => f.kind === "feature" && f.parentItemId === k.id)]);
  return codeList(ordered.map((r) => ({ id: r.id, name: r.name, description: r.description })));
}

export interface RequestOutcome {
  pages: SentPage[];
  pieces: NewsPiece[];
  /** What each page's text is about, by page code. */
  about: Map<string, string>;
  /** Pages the answer did not report, after every ask: their news is not known. */
  unanswered: SentPage[];
  dropped: number;
  /** How many times the request was asked (an answer that leaves a page out is asked again). */
  asks: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** The call failed: what the provider or the parser said. No rows were written for the request. */
  error: string | null;
}

/** An answer that does not report every page is not complete: the request is asked again, this many times in all. */
const NEWS_ASKS = 2;

/** One request: ask, check, store. Never throws — a failed request is reported, the batch goes on. */
export async function intakeRequest(company: IntakeCompany, list: NewsList, listText: string, pages: SentPage[], opts: { batchId: string; simulated: boolean; injected?: string }): Promise<RequestOutcome> {
  const model = newsModel();
  const started = Date.now();
  let input = 0, output = 0, asks = 0;
  try {
    let parsed = parseNews(null, list, pages);
    while (asks < NEWS_ASKS && (asks === 0 || parsed.unanswered.length)) {
      asks++;
      const { value, usage } = await callTool<unknown>(NEWS_SYSTEM_PROMPT, listText, renderPages(pages), newsTool(list.features, pages), {
        model,
        maxTokens: NEWS_MAX_TOKENS,
        thinking: NEWS_THINKING,
        injected: opts.injected,
      });
      input += usage.input;
      output += usage.output;
      parsed = parseNews(value, list, pages);
    }
    const ms = Date.now() - started;
    // The news of a page the answer did not report is not known: its pieces (if any came) are not stored.
    const unanswered = pages.filter((p) => parsed.unanswered.includes(p.code));
    const pieces = parsed.pieces.filter((p) => !unanswered.includes(p.page));
    if (pieces.length) {
      await db.competitorNews.createMany({
        data: pieces.map((p) => ({
          workspaceId: company.workspaceId,
          competitorId: company.id,
          batchId: opts.batchId,
          verdict: p.verdict,
          otherType: p.otherType,
          name: p.name,
          companyName: p.companyName,
          what: p.what,
          problem: p.problem,
          problemSource: p.problemSource,
          workflows: p.workflows,
          audience: p.audience,
          evidence: p.evidence.length ? (p.evidence as unknown as object[]) : undefined,
          quote: p.quote,
          quoteOk: p.quoteOk,
          reason: p.reason,
          coveredItemId: p.covered?.id ?? null,
          coveredName: p.covered?.name ?? null,
          sourceUrl: p.page.page.url,
          sourceTitle: p.page.page.title,
          sourceKind: p.page.page.kind,
          publishedAt: p.page.page.publishedAt ? new Date(p.page.page.publishedAt) : null,
          simulated: opts.simulated,
          inputTokens: input,
          outputTokens: output,
          ms,
          model,
        })),
      });
    }
    return { pages, pieces, about: parsed.about, unanswered, dropped: parsed.dropped, asks, inputTokens: input, outputTokens: output, ms, error: null };
  } catch (e) {
    return { pages, pieces: [], about: new Map(), unanswered: [], dropped: 0, asks, inputTokens: input, outputTokens: output, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface BatchOutcome {
  batchId: string;
  requests: RequestOutcome[];
  /** Changed pages that hold no new line: not sent. */
  nothingNew: NewsPage[];
  /** Pages whose news is not known: their request failed, or the answer left them out. */
  failedPages: number;
}

/** A batch of pages of one company. `list` = the company's list when the caller has it; otherwise it is read from the database. */
export async function intakeBatch(company: IntakeCompany, pages: NewsPage[], opts: { simulated: boolean; list?: NewsList; atOnce?: number; onRequest?: (o: RequestOutcome, index: number, of: number) => void }): Promise<BatchOutcome> {
  const batchId = randomUUID();
  const list = opts.list ?? (await loadNewsList(company.id));
  if (list.features.length === 0) throw new Error(`${company.name} has no list yet: news starts after its first full analysis.`);
  const { requests, nothingNew } = planRequests(pages);
  const listText = renderList(company.name, list);
  const out: RequestOutcome[] = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      out[i] = await intakeRequest(company, list, listText, requests[i], { batchId, simulated: opts.simulated });
      opts.onRequest?.(out[i], i, requests.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.atOnce ?? 2, requests.length) }, worker));
  const all = out.flatMap((o) => o.pieces);
  const failedPages = out.reduce((n, o) => n + (o.error ? o.pages.length : o.unanswered.length), 0);
  await recordCompetitorEvent(company.workspaceId, null, "cmp_news_intake", {
    competitorId: company.id,
    batchId,
    pages: pages.length,
    requests: requests.length,
    nothingNewPages: nothingNew.length,
    failedPages,
    new: all.filter((p) => p.verdict === "new").length,
    covered: all.filter((p) => p.verdict === "covered").length,
    other: all.filter((p) => p.verdict === "other").length,
    inputTokens: out.reduce((s, o) => s + o.inputTokens, 0),
    outputTokens: out.reduce((s, o) => s + o.outputTokens, 0),
    simulated: opts.simulated,
  });
  return { batchId, requests: out, nothingNew, failedPages };
}
