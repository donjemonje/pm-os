import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { AnswerError, callTool, CapacityError, getCompetitorsModel, type CallOptions } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { HEARTBEAT_MS, STALE_MS } from "../config";
import { aiStepEnabled, now, testAiAnswers, testKnobsEnabled, type TestAiAnswers } from "../settings";
import { getCompetitorsConfig } from "../store";
import { analysisBaseWaitMs, analysisTpm, MAX_WAIT_MS, runPaced, TokenBudget, type PacedOptions, type PacedResult } from "./pacing";
import { factsStep } from "./facts";
import { applyStep, matchStep, mergeStep, planResearch, researchStep, secondLookStep } from "./steps";

/**
 * The analysis run (Capability Analysis, "How the analysis runs").
 *
 * A scan ends when the pages are stored; a finished scan queues an analysis run for the competitor. ONE run
 * executes at a time in the whole installation, oldest first: the token quota is shared, and two runs that add
 * rows to one catalog at once would add the same row twice. A queue of one needs no shared rate limiter, no locks.
 *
 *   queued ──claim (it is the head of the queue)──▶ running
 *   running ──capacity answer──▶ waiting (resumeAt; the same process sleeps) ──sleep over──▶ running
 *   running | waiting ──no heartbeat for 10 min──▶ queued (staleCount + 1; at 3 → failed "stale")
 *   running ──all six steps done──▶ done
 *   running ──an unusable answer in merge / match, too many failed pages, 24 h of waiting, any other error──▶ failed
 *   queued | running | waiting ──the competitor was removed──▶ cancelled
 *
 * The run keeps no cursor: every start walks the six steps from the first, and each step computes its to-do from
 * the tables (analysis/steps.ts). A run that stopped — rate limit, crash, deploy — continues with what is left.
 *
 * Where it executes: local dev and the e2e server run it in the app's Node process (inline runner), like scans;
 * production runs it in the scanner job (`--analysis <id>`), one execution per run. A failed run is not retried by
 * itself: the competitor's next scan queues a new run, which starts from what is left.
 */

export type AnalysisTrigger = "scan" | "catalog" | "manual";
export type AnalysisStepName = "research" | "merge" | "match" | "second_look" | "apply" | "facts";
export const ACTIVE_ANALYSIS_STATUSES = ["queued", "running", "waiting"] as const;
/** A run whose runner stopped reporting this many times fails. */
export const MAX_STALE = 3;
/** Log lines kept on the run. */
const MAX_LOG_LINES = 3000;

/** A step's own reason to fail the run. */
export class AnalysisError extends Error {
  kind: "answer" | "ai" | "other";
  constructor(kind: "answer" | "ai" | "other", message: string) {
    super(message);
    this.name = "AnalysisError";
    this.kind = kind;
  }
}

/** The competitor was removed while the run was working: it ends as cancelled. */
class RunCancelled extends Error {}

/** Everything a run counts. Stored on the run (counters) and sent with cmp_analysis_finished. */
export interface Counters {
  pagesRead: number;
  pagesFailed: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  waits: number;
  waitedMs: number;
  findings: number;
  findingsRemoved: number;
  quotesDropped: number;
  piiHits: number;
  itemsNew: number;
  mergeCalls: number;
  mergeSplits: number;
  matchCalls: number;
  matchedByName: number;
  matchedByAi: number;
  placed: number;
  secondLooks: number;
  secondLookFound: number;
  newCapabilities: number;
  newFeatures: number;
  newDomains: number;
  cellsFound: number;
  cellsLow: number;
  cellsNotFound: number;
  cellsChanged: number;
  factsNew: number;
}

export function emptyCounters(): Counters {
  return {
    pagesRead: 0, pagesFailed: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, waits: 0, waitedMs: 0,
    findings: 0, findingsRemoved: 0, quotesDropped: 0, piiHits: 0, itemsNew: 0, mergeCalls: 0, mergeSplits: 0,
    matchCalls: 0, matchedByName: 0, matchedByAi: 0, placed: 0, secondLooks: 0, secondLookFound: 0,
    newCapabilities: 0, newFeatures: 0, newDomains: 0, cellsFound: 0, cellsLow: 0, cellsNotFound: 0, cellsChanged: 0, factsNew: 0,
  };
}

function readCounters(raw: unknown): Counters {
  const out = emptyCounters();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of Object.keys(out) as (keyof Counters)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

export interface AnalysisLogLine {
  at: string;
  level: "info" | "warn" | "error";
  msg: string;
  url?: string;
}

/** What a step gets: the run, its settings, and the engine's accounting around every call and every loop. */
export interface RunContext {
  run: { id: string; workspaceId: string; competitorId: string; trigger: string; scanId: string | null; startedById: string | null; cursor: Record<string, unknown> };
  competitor: { id: string; name: string; host: string };
  /** Workspace settings, read once at the claim. */
  readWeak: boolean;
  minPagesForNewRow: number;
  model: string;
  /** TEST KNOB: the injected answers of the run, read once at the claim; null = a real run. */
  answers: TestAiAnswers | null;
  counters: Counters;
  log: (level: AnalysisLogLine["level"], msg: string, url?: string) => void;
  /** Research progress for the UI. */
  progress: { pagesTotal: number; pagesDone: number };
  /** One model call through the run's accounting. Returns the value and the tokens it used (input + output). */
  call: <T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, opts: CallOptions) => Promise<{ value: T; tokens: number }>;
  /** The one loop every step uses (pacing.ts runPaced), with the run's budget, waiting and cancelling wired in. */
  paced: <T>(o: Pick<PacedOptions<T>, "items" | "concurrency" | "estimate" | "work" | "onAnswerError">) => Promise<PacedResult>;
  /** Save the one thing that cannot be derived (the facts baseline). */
  saveCursor: (patch: Record<string, unknown>) => Promise<void>;
  /** Write counters, progress and log now (also done with every heartbeat). */
  flush: () => Promise<void>;
}

// ————— Queue —————

export type QueueResult = { id: string; created: boolean } | { skipped: "ai_off" };

/**
 * Queue an analysis of a competitor's stored pages. At most one queued run per competitor: a second request while
 * one waits folds into it (the newer scan wins). The run starts at once when nothing else is running.
 */
export async function queueAnalysis(
  workspaceId: string,
  competitorId: string,
  trigger: AnalysisTrigger,
  opts: { scanId?: string | null; startedById?: string | null } = {},
): Promise<QueueResult> {
  const answers = await testAiAnswers(competitorId);
  // Test knob: COMPETITORS_AI=off and no injected answers for the competitor → no analysis (the scanning story is tested without it).
  if (testKnobsEnabled() && !aiStepEnabled() && !answers) return { skipped: "ai_off" };
  const queued = await db.competitorAnalysis.findFirst({ where: { competitorId, status: "queued" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  let result: QueueResult;
  if (queued) {
    if (opts.scanId) await db.competitorAnalysis.update({ where: { id: queued.id }, data: { scanId: opts.scanId } });
    result = { id: queued.id, created: false };
  } else {
    const run = await db.competitorAnalysis.create({
      data: { workspaceId, competitorId, trigger, scanId: opts.scanId ?? null, startedById: opts.startedById ?? null, injected: Boolean(answers) },
      select: { id: true },
    });
    await recordCompetitorEvent(workspaceId, opts.startedById ?? null, "cmp_analysis_queued", { analysisId: run.id, competitorId, trigger, scanId: opts.scanId ?? null });
    result = { id: run.id, created: true };
  }
  await kickAnalyses();
  return result;
}

/**
 * Our catalog got a row the competitors were never checked for (added by hand, restored, or created by another
 * competitor's run): queue a run for every competitor of the workspace that has stored pages. Such a run reads no
 * page again — it matches nothing new and gives the row its second look.
 */
export async function queueCatalogAnalyses(workspaceId: string, opts: { exceptCompetitorId?: string; startedById?: string | null } = {}): Promise<number> {
  const competitors = await db.competitor.findMany({
    where: { workspaceId, deletedAt: null, ...(opts.exceptCompetitorId ? { id: { not: opts.exceptCompetitorId } } : {}), sources: { some: { pages: { some: {} } } } },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  for (const c of competitors) await queueAnalysis(workspaceId, c.id, "catalog", { startedById: opts.startedById ?? null });
  return competitors.length;
}

/**
 * Start the head of the queue when nothing is running. Called when a run is queued, when a run ends, by the hourly
 * tick, at server start, and (inline runner) once a minute — so a restart resumes a run without anyone pressing anything.
 */
export async function kickAnalyses(): Promise<void> {
  try {
    await sweepStaleAnalyses(await now());
    const head = await db.competitorAnalysis.findFirst({ where: { status: { in: [...ACTIVE_ANALYSIS_STATUSES] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, status: true } });
    if (!head || head.status !== "queued") return;
    const { launchAnalysis } = await import("../run");
    await launchAnalysis(head.id);
  } catch (e) {
    console.error("[competitors] could not start the next analysis", e);
  }
}

/** Runs whose runner stopped reporting for 10 minutes go back to the queue (the next start continues from state); the third time they fail. */
export async function sweepStaleAnalyses(t: Date): Promise<number> {
  const cutoff = new Date(t.getTime() - STALE_MS);
  const stale = await db.competitorAnalysis.findMany({
    where: { status: { in: ["running", "waiting"] }, heartbeatAt: { lt: cutoff } },
    select: { id: true, staleCount: true, workspaceId: true, competitorId: true, trigger: true, step: true, scanId: true, startedById: true },
  });
  let swept = 0;
  for (const s of stale) {
    const gaveUp = s.staleCount + 1 >= MAX_STALE;
    const r = await db.competitorAnalysis.updateMany({
      where: { id: s.id, status: { in: ["running", "waiting"] }, heartbeatAt: { lt: cutoff } },
      data: gaveUp
        ? { status: "failed", staleCount: s.staleCount + 1, resumeAt: null, finishedAt: new Date(), errorKind: "stale", error: `the runner stopped reporting ${MAX_STALE} times` }
        : { status: "queued", staleCount: s.staleCount + 1, resumeAt: null },
    });
    if (!r.count) continue;
    swept++;
    if (gaveUp) {
      await recordCompetitorEvent(s.workspaceId, s.startedById, "cmp_analysis_finished", { analysisId: s.id, competitorId: s.competitorId, trigger: s.trigger, outcome: "failed", step: s.step, errorKind: "stale" });
      await notifyScanRun(s.scanId);
    }
  }
  return swept;
}

/** The scan run's one email waits for the analyses its scans queued (runs.ts notifyRunWhenAnalyzed). */
async function notifyScanRun(scanId: string | null): Promise<void> {
  if (!scanId) return;
  try {
    const scan = await db.competitorScan.findUnique({ where: { id: scanId }, select: { runId: true } });
    if (!scan?.runId) return;
    const { notifyRunWhenAnalyzed } = await import("../runs");
    await notifyRunWhenAnalyzed(scan.runId);
  } catch (e) {
    console.error("[competitors] run notification after the analysis failed", scanId, e);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ————— Run —————

export async function runAnalysis(id: string): Promise<void> {
  const model = getCompetitorsModel();
  // The claim: only the head of the queue can be claimed, and only once — so two runs never execute together.
  const claimed = await db.$transaction(async (tx) => {
    const head = await tx.competitorAnalysis.findFirst({ where: { status: { in: [...ACTIVE_ANALYSIS_STATUSES] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, startedAt: true } });
    if (!head || head.id !== id) return null;
    const t = new Date();
    const r = await tx.competitorAnalysis.updateMany({ where: { id, status: "queued" }, data: { status: "running", startedAt: head.startedAt ?? t, heartbeatAt: t, resumeAt: null, model } });
    return r.count ? { resumed: head.startedAt != null } : null;
  });
  if (!claimed) return;

  const row = await db.competitorAnalysis.findUnique({ where: { id }, include: { competitor: { select: { id: true, name: true, host: true, deletedAt: true } } } });
  if (!row) return;
  const t0 = Date.now();
  const counters = readCounters(row.counters);
  const lines: AnalysisLogLine[] = Array.isArray(row.log) ? (row.log as unknown as AnalysisLogLine[]) : [];
  const progress = { pagesTotal: row.pagesTotal, pagesDone: row.pagesDone };
  const log: RunContext["log"] = (level, msg, url) => {
    lines.push({ at: new Date().toISOString(), level, msg, ...(url ? { url } : {}) });
  };
  let step: AnalysisStepName = "research";
  const flush = async () => {
    await db.competitorAnalysis
      .updateMany({
        where: { id },
        data: { heartbeatAt: new Date(), counters: counters as unknown as Prisma.InputJsonValue, log: lines.slice(-MAX_LOG_LINES) as unknown as Prisma.InputJsonValue, pagesTotal: progress.pagesTotal, pagesDone: progress.pagesDone },
      })
      .catch(() => undefined);
  };
  const heartbeat = setInterval(() => void flush(), HEARTBEAT_MS);
  const setStep = async (s: AnalysisStepName) => {
    step = s;
    await db.competitorAnalysis.updateMany({ where: { id }, data: { step: s, heartbeatAt: new Date() } });
  };

  let outcome: "done" | "failed" | "cancelled" = "done";
  let errorKind: string | null = null;
  let error: string | null = null;
  try {
    // TEST KNOB, read ONCE per run: a run flagged injected whose answers are gone fails — it can never reach a real model.
    const answers = await testAiAnswers(row.competitorId);
    if (row.injected && !answers) throw new AnalysisError("other", "test answers were cleared before the run started (test knob) — no model is called");
    const config = await getCompetitorsConfig(row.workspaceId);
    const budget = new TokenBudget(analysisTpm());
    let okCalls = 0;
    let refused = 0;
    let stopCheckedAt = 0;
    let stop = Boolean(row.competitor.deletedAt);
    const shouldStop = async () => {
      if (stop || Date.now() - stopCheckedAt < 10_000) return stop;
      stopCheckedAt = Date.now();
      const c = await db.competitor.findUnique({ where: { id: row.competitorId }, select: { deletedAt: true } });
      stop = !c || Boolean(c.deletedAt);
      return stop;
    };
    const cursor = row.cursor && typeof row.cursor === "object" && !Array.isArray(row.cursor) ? { ...(row.cursor as Record<string, unknown>) } : {};
    const ctx: RunContext = {
      run: { id, workspaceId: row.workspaceId, competitorId: row.competitorId, trigger: row.trigger, scanId: row.scanId, startedById: row.startedById, cursor },
      competitor: { id: row.competitor.id, name: row.competitor.name, host: row.competitor.host },
      readWeak: config.readWeakPages,
      minPagesForNewRow: config.minPagesForNewRow,
      model,
      answers,
      counters,
      log,
      progress,
      call: async <T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, opts: CallOptions) => {
        if (answers && opts.injected === undefined) throw new AnalysisError("other", "this run takes injected answers (test knob) and a step asked for a model call");
        if (answers?.rateLimit && okCalls >= answers.rateLimit.afterCalls && refused < answers.rateLimit.times) {
          refused++;
          throw new CapacityError("PMOS AI has no capacity (test knob)");
        }
        let r;
        try {
          r = await callTool<T>(system, shared, tail, tool, opts);
        } catch (e) {
          if (e instanceof CapacityError || e instanceof AnswerError) throw e;
          throw new AnalysisError("ai", e instanceof Error ? e.message.slice(0, 300) : String(e));
        }
        okCalls++;
        counters.calls++;
        counters.inputTokens += r.usage.input;
        counters.outputTokens += r.usage.output;
        counters.cachedTokens += r.usage.cached;
        return { value: r.value, tokens: r.usage.input + r.usage.output };
      },
      paced: async <T>(o: Pick<PacedOptions<T>, "items" | "concurrency" | "estimate" | "work" | "onAnswerError">) => {
        const r = await runPaced<T>({
          ...o,
          budget,
          sleep,
          // 24 h of waiting in all, across the steps of the run.
          maxWaitMs: Math.max(0, MAX_WAIT_MS - counters.waitedMs),
          baseWaitMs: analysisBaseWaitMs(),
          shouldStop,
          onWait: async (ms, attempt) => {
            const resumeAt = new Date(Date.now() + ms);
            counters.waits++;
            counters.waitedMs += ms;
            log("warn", `PMOS AI has no capacity — waiting ${Math.round(ms / 1000)} s, then continuing from where it stopped (wait ${attempt} in a row)`);
            await db.competitorAnalysis.updateMany({ where: { id }, data: { status: "waiting", resumeAt } });
            await flush();
            await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_waiting", { analysisId: id, competitorId: row.competitorId, step, waitMs: ms, attempt });
          },
          onResume: async () => {
            await db.competitorAnalysis.updateMany({ where: { id, status: "waiting" }, data: { status: "running", resumeAt: null, heartbeatAt: new Date() } });
            log("info", "Continuing");
          },
        });
        if (r.stopped) throw new RunCancelled();
        return r;
      },
      saveCursor: async (patch) => {
        Object.assign(cursor, patch);
        await db.competitorAnalysis.updateMany({ where: { id }, data: { cursor: cursor as Prisma.InputJsonValue } });
      },
      flush,
    };
    if (await shouldStop()) throw new RunCancelled();

    log("info", `Analysis ${claimed.resumed ? "continued" : "started"} (${row.trigger}) for ${row.competitor.name}${answers ? " — PMOS AI answers injected (test knob), no model is called" : ` — ${model}`}`);
    await setStep("research");
    const plan = await planResearch(ctx);
    await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_started", {
      analysisId: id, competitorId: row.competitorId, trigger: row.trigger, scanId: row.scanId, resumed: claimed.resumed,
      pagesPicked: plan.picked, pagesToRead: plan.todo.length, readWeak: config.readWeakPages, model, injected: Boolean(answers),
    });
    await researchStep(ctx, plan);
    await setStep("merge");
    await mergeStep(ctx);
    await setStep("match");
    await matchStep(ctx);
    await setStep("second_look");
    await secondLookStep(ctx);
    await setStep("apply");
    await applyStep(ctx);
    await setStep("facts");
    await factsStep(ctx);
    log("info", `Analysis done in ${Math.round((Date.now() - t0) / 1000)} s · ${counters.pagesRead} page${counters.pagesRead === 1 ? "" : "s"} read · ${counters.calls} PMOS AI call${counters.calls === 1 ? "" : "s"} · ${counters.inputTokens + counters.outputTokens} tokens`);
  } catch (e) {
    if (e instanceof RunCancelled) {
      outcome = "cancelled";
      log("warn", "The competitor was removed — analysis cancelled");
    } else {
      outcome = "failed";
      errorKind = e instanceof CapacityError ? "capacity" : e instanceof AnswerError ? "answer" : e instanceof AnalysisError ? e.kind : "other";
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      log("error", `Analysis stopped in the ${step.replace("_", " ")} step: ${error}`);
      if (!(e instanceof CapacityError || e instanceof AnswerError || e instanceof AnalysisError)) console.error("[competitors] analysis failed", id, e);
    }
  } finally {
    clearInterval(heartbeat);
    const finishedAt = new Date();
    await db.competitorAnalysis
      .updateMany({
        where: { id },
        data: {
          status: outcome, step: outcome === "done" ? "done" : step, finishedAt, heartbeatAt: finishedAt, resumeAt: null, errorKind: errorKind ?? "none", error,
          counters: counters as unknown as Prisma.InputJsonValue, log: lines.slice(-MAX_LOG_LINES) as unknown as Prisma.InputJsonValue, pagesTotal: progress.pagesTotal, pagesDone: progress.pagesDone,
        },
      })
      .catch((e) => console.error("[competitors] could not close the analysis run", id, e));
    await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_finished", {
      analysisId: id, competitorId: row.competitorId, trigger: row.trigger, outcome, step, durationMs: Date.now() - t0, ...counters, errorKind: errorKind ?? "none", error,
    });
    await notifyScanRun(row.scanId);
    await kickAnalyses();
  }
}
