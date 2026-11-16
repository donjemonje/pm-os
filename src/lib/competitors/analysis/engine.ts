import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { AnswerError, callTool, CapacityError, EndpointError, type CallOptions, type Usage } from "../ai";
import { callFailureMessage, competitorsModels, competitorsThinking, modelsLine, retiredThinkingOverride, THINKING_ENV_ALL, thinkingLine, type ModelRole } from "../models";
import { recordCompetitorEvent } from "../analytics";
import { HEARTBEAT_MS, STALE_MS } from "../config";
import { aiStepEnabled, analysisReads, analysisTokenBudget, now, testAiAnswers, type TestAiAnswers } from "../settings";
import { analysisBaseWaitMs, analysisMaxSpeed, analysisTpm, emptyPacing, MAX_WAIT_MS, PACE_START_SPEED, Pacer, pacingLine, readPacing, recordPushback, runPaced, TokenBudget, type PacedOptions, type PacedResult, type PacingRecord } from "./pacing";
import { runAlertDue, runAlertEmail } from "./alert";
import { ReadingBudget } from "./budget";
import { capLine, capLines, CAPS, capsForEvent, capsHeadline, capsOf, clearStateCaps, readCaps, recordCap, type CapHit, type CapId } from "./caps";
import { emptyCounters, readCounters, type Counters } from "./counters";
import { factsStep } from "./facts";
import { analysisMayRun, queueFilter } from "./gate";
import { emptyIncidents, incidentLine, incidentsForEvent, incidentsHeadline, incidentsOf, readIncidents, recordIncident, type Incident, type IncidentLog } from "./incidents";
import { mapStep } from "./plan";
import { readingStep } from "./read-step";
import { effectiveReads, READ_KINDS, readsLine, type NotReadByKind, type ReadSetting } from "./reads";
import type { ReadingPlan } from "./sections";
import { moveSetupState, setupWalk, workspaceSetupState } from "./setup";
import { analysisPath, readSetupProgress, setupTotals, type SetupCompany, type SetupProgress, type SetupStage } from "./setup-rules";
import { addUsage, readUsage, usageByModel, usageByModelText, usageLine, usageSince, type StepUsage } from "./usage";
import { applyStep, matchStep, secondLookStep } from "./steps";

/**
 * The analysis run (Capability Analysis, "How the analysis runs").
 *
 * A scan ends when the pages are stored; a finished scan queues an analysis run for the competitor. ONE run
 * executes at a time in the whole installation, oldest first: the provider's capacity is shared, and two runs that
 * add rows to one catalog at once would add the same row twice. Inside a run the reading calls go many at once, at
 * the run's own speed (analysis/pacing.ts): it starts fast, speeds up while calls succeed and slows down when the
 * provider pushes back — every pushback is recorded on the run (CompetitorAnalysis.pacing). A queue of one needs no shared rate limiter, no locks.
 *
 *   queued ──claim (it is the head of the queue)──▶ running
 *   running ──capacity answer, or the endpoint failed (500, 502, 504, network)──▶ waiting (resumeAt; the same
 *                      process sleeps) ──sleep over──▶ running
 *   running | waiting ──no heartbeat for 10 min──▶ queued (staleCount + 1; at 3 → failed "stale"); the worker that
 *                      held it, if it is still alive, finds it is no longer the owner and stops without writing
 *   running ──all steps done──▶ done
 *   running ──an unusable answer (map, reading, unify, domains, match), 24 h of waiting for capacity, an endpoint
 *                      that failed 7 times in a row (6 waits, 45 min), any other error──▶ failed
 *   queued | running | waiting ──the competitor was removed──▶ cancelled
 *
 * The steps of one run of a company, after its organization was set up:
 *   map (label the sections of the site: the reading plan) → reading (the company's new or changed pages, in a few
 *   chunks, against its list so far: analysis/read-step.ts) → match (its new items against the rows that exist; what
 *   matches nothing becomes a new row in an existing domain) → second look (OUR rows it has no item for, asked in
 *   bulk per chunk) → apply (the cells, by fixed rules) → facts.
 *
 * The run keeps no fragile state: every start walks the steps from the first, and each step computes its to-do from
 * the tables. A run that stopped — rate limit, crash, deploy — continues with what is left. The cursor holds only
 * what cannot be derived: the facts baseline, and how far a second look got.
 *
 * The token budget (analysis/budget.ts; Administration → Competitors, one number for the installation): every token
 * of the run counts. When the next reading call (a chunk of the reading, a second look) would pass it, no
 * further reading call starts; match, apply and facts still run, so the table is filled from what was read.
 * The run ends "done" with budgetReached and the pages left unread in its counters; they stay due for the next run.
 *
 * Two things changed with the setup run (analysis/setup.ts, 2026-11-15):
 *   - A run fills the table only in an organization whose SETUP IS DONE — an explicit state of the organization
 *     (setup-rules.ts: required → in setup → done), not a guess from its catalog. Until then a run does
 *     map → reading and stops "done": the company's list is ready, and no row is created.
 *   - The organization's own source (own.ts) is analysed like a competitor up to the match; then it fills OUR column
 *     (steps.ts applyOwnCells) instead of a competitor's cells, with no second look and no facts step.
 * The setup run itself is a row of this table (kind "setup", attached to the own source) and takes its turn in this
 * queue: the claim, the heartbeat, the waiting, the stale sweep and the close below are shared; its steps are
 * analysis/setup.ts.
 *
 * Limits are safety nets (analysis/caps.ts): a run that hits one records it on the run row, says so in its log, in
 * the finished event and in Administration → Competitors — and a run that failed or hit any cap sends ONE email to
 * support (analysis/alert.ts). So is an INCIDENT (analysis/incidents.ts): an answer that should never happen — a
 * quote that is not on the page it names — is kept on the run as a case, never just dropped.
 * The tokens and the time of every call are kept by step and model (analysis/usage.ts).
 *
 * Where it executes: local dev and the e2e server run it in the app's Node process (inline runner), like scans;
 * production runs it in the scanner job (`--analysis <id>`), one execution per run. A failed run is not retried by
 * itself: the competitor's next scan queues a new run, which starts from what is left.
 */

/** "sources" = an address of the company was removed (address-search.ts): what its pages said leaves the picture. Automatic, like "scan" and "catalog". */
export type AnalysisTrigger = "scan" | "catalog" | "manual" | "sources";
/** "unify" and "domains" are steps of a setup run only. */
export type AnalysisStepName = "map" | "reading" | "unify" | "domains" | "match" | "second_look" | "apply" | "facts";
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

/**
 * This worker no longer owns the run: it was swept as stale and put back in the queue (or failed) while this process
 * was still alive — the Mac slept, the database was away for 10 minutes. The run now belongs to whoever claims it
 * next; this worker stops and writes nothing more.
 */
class RunLost extends Error {}

export { emptyCounters, readCounters, type Counters } from "./counters";

/** What a step passes with a call: everything but the model and the thinking level — the step names the ROLE (models.ts), the engine resolves both. */
export type StepCallOptions = Omit<CallOptions, "model" | "thinking"> & { role: ModelRole };

/** What a call gives back to its step: the answer, and what it cost. */
export interface StepCallResult<T> {
  value: T;
  /** Input + output tokens (what the pacing counts). */
  tokens: number;
  usage: Usage;
  /** How long the call took, and the model that answered. */
  ms: number;
  model: string;
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
  /** The company the steps work on. `isOwn` = the organization's own source (own.ts): it fills OUR column. */
  competitor: { id: string; name: string; host: string; websiteUrl: string; isOwn: boolean };
  /** The context belongs to a setup run (analysis/setup.ts): `run.id` is the setup run's, the company is one of several. */
  setup: boolean;
  /** The competitor's reading plan (sections.ts): set by the map step, read by every later step (plan.ts planOf). */
  plan: ReadingPlan | null;
  /**
   * "What the analysis reads" for this company (analysis/reads.ts): the installation's setting, read once at the
   * claim — one switch per kind of content. The reading asks this and nothing else.
   */
  reads: ReadSetting;
  /** The reading step says what it left out because its kind is off: recorded on the run (a configuration, not a cap). */
  setNotRead: (notRead: NotReadByKind) => void;
  /** The model of the "read" role: the one that makes the second look, so the one a look's key carries (secondlook.ts lookKey). */
  model: string;
  /** The model of each role in this run (models.ts), resolved once at the claim. */
  models: Record<ModelRole, string>;
  /** TEST KNOB: the injected answers of the run, read once at the claim; null = a real run. */
  answers: TestAiAnswers | null;
  counters: Counters;
  log: (level: AnalysisLogLine["level"], msg: string, url?: string) => void;
  /** Research progress for the UI. */
  progress: { pagesTotal: number; pagesDone: number };
  /**
   * A cap was hit for this context's company (analysis/caps.ts): recorded on the run and, when what it says is new,
   * written to the log as a warn line. Never silent, never an error: the run goes on.
   */
  cap: (cap: CapId, r: { limit: number; undone: number; also?: number; times?: number }) => void;
  /**
   * An incident for this context's company (analysis/incidents.ts): an answer that should never happen — a quote
   * that is not on the page it names, a page or an item outside the closed set. Kept on the run as a case; the step
   * leaves the finding out of the table.
   */
  incident: (i: Omit<Incident, "at" | "step" | "competitorId" | "company">) => void;
  /** One model call through the run's accounting. Returns the value and what it cost. */
  call: <T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, opts: StepCallOptions) => Promise<StepCallResult<T>>;
  /** The run's token budget: the gate of every reading call (budget.ts). */
  reading: ReadingBudget;
  /**
   * The one loop every step uses (pacing.ts runPaced), with the run's pacing, waiting and cancelling wired in.
   * `reading: true` marks the calls of the loop as READING calls (a chunk of the reading, a second look): each
   * passes the run's token budget before it starts; the items not started are counted in the result's `left`.
   */
  paced: <T>(o: Pick<PacedOptions<T>, "items" | "concurrency" | "estimate" | "work" | "onAnswerError"> & { reading?: boolean }) => Promise<PacedResult>;
  /** Save what cannot be derived (the facts baseline, how far a second look got). */
  saveCursor: (patch: Record<string, unknown>) => Promise<void>;
  /** The apply step finished: the cells are current as of `at`. */
  markApplied: (at: Date) => Promise<void>;
  /** Write counters, progress and log now (also done with every heartbeat). */
  flush: () => Promise<void>;
}

// ————— Queue —————

export type QueueResult = { id: string; created: boolean } | { skipped: "ai_off" };

/** The runs that take part in "one at a time, oldest first" right now (gate.ts: with the PMOS AI step off, only what was asked by hand or injected). */
function activeQueue(): Prisma.CompetitorAnalysisWhereInput {
  return queueFilter({ aiOff: !aiStepEnabled() }) as Prisma.CompetitorAnalysisWhereInput;
}

/**
 * Queue an analysis of a competitor's stored pages. At most one queued run per competitor: a second request while
 * one waits folds into it (the newer scan wins; a request by hand makes the waiting run a manual one). The run
 * starts at once when nothing else is running.
 *
 * TEST KNOB — COMPETITORS_AI=off (with COMPETITORS_TEST_KNOBS=on): the automatic triggers ("scan", "catalog") queue
 * nothing. A run asked for by hand ("manual") and a run with injected answers are queued and run (gate.ts).
 */
export async function queueAnalysis(
  workspaceId: string,
  competitorId: string,
  trigger: AnalysisTrigger,
  opts: { scanId?: string | null; startedById?: string | null } = {},
): Promise<QueueResult> {
  const answers = await testAiAnswers(competitorId);
  if (!analysisMayRun({ trigger, injected: Boolean(answers) }, { aiOff: !aiStepEnabled() })) return { skipped: "ai_off" };
  // Look-then-create under a lock held to the end of the transaction, one per competitor: two requests in the same
  // instant (two scans ending, a scan and a catalog change) fold into one queued run instead of making two.
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-analysis-queue:${competitorId}`}))`;
    // Never a queued setup run (it is attached to the own source): a scan of the own source gets a run of its own, behind it.
    const queued = await tx.competitorAnalysis.findFirst({ where: { competitorId, status: "queued", kind: "analysis" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (queued) {
      if (opts.scanId || trigger === "manual") {
        await tx.competitorAnalysis.update({ where: { id: queued.id }, data: { ...(opts.scanId ? { scanId: opts.scanId } : {}), ...(trigger === "manual" ? { trigger: "manual" } : {}) } });
      }
      return { id: queued.id, created: false };
    }
    const run = await tx.competitorAnalysis.create({
      data: { workspaceId, competitorId, trigger, scanId: opts.scanId ?? null, startedById: opts.startedById ?? null, injected: Boolean(answers) },
      select: { id: true },
    });
    return { id: run.id, created: true };
  });
  if (result.created) await recordCompetitorEvent(workspaceId, opts.startedById ?? null, "cmp_analysis_queued", { analysisId: result.id, competitorId, trigger, scanId: opts.scanId ?? null });
  await kickAnalyses();
  return result;
}

/**
 * Our catalog got a row the competitors were never checked for (added by hand, restored, or created by another
 * competitor's run): queue a run for every competitor of the workspace that already has a finished analysis. Such a
 * run reads no page again — it matches nothing new and gives the row its second look.
 *
 * Never a first full read: a competitor that was never analysed to the end is left alone — its own scan queues its
 * first analysis, and that run looks for every row of ours anyway.
 */
export async function queueCatalogAnalyses(workspaceId: string, opts: { exceptCompetitorId?: string; startedById?: string | null } = {}): Promise<number> {
  const competitors = await db.competitor.findMany({
    // Never the organization's own source: such a run only gives a row its second look, and the own source gets none (own.ts).
    where: { workspaceId, deletedAt: null, isOwn: false, ...(opts.exceptCompetitorId ? { id: { not: opts.exceptCompetitorId } } : {}), analyses: { some: { status: "done" } } },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  let queued = 0;
  for (const c of competitors) {
    const q = await queueAnalysis(workspaceId, c.id, "catalog", { startedById: opts.startedById ?? null });
    if (!("skipped" in q)) queued++;
  }
  return queued;
}

/**
 * Start the head of the queue when nothing is running. Called when a run is queued, when a run ends, by the hourly
 * tick, at server start, and (inline runner) once a minute — so a restart resumes a run without anyone pressing anything.
 * With the PMOS AI step off (test knob) the queue holds only runs asked for by hand or injected (gate.ts): a kick
 * starts nothing else.
 */
export async function kickAnalyses(): Promise<void> {
  try {
    await sweepStaleAnalyses(await now());
    const head = await db.competitorAnalysis.findFirst({ where: activeQueue(), orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, status: true } });
    if (!head || head.status !== "queued") return;
    // One runner per queued run: the kick that marks the run is the one that asks for a runner. Every other kick —
    // the minute timer, the tick, another run being queued — finds the mark and asks for nothing, so on Cloud Run a
    // queued run gets one job execution, not one per kick. A runner that never came (the mark is 10 minutes old) is
    // asked for again; a run that is running or waiting is never launched (it is not "queued").
    const at = new Date();
    const marked = await db.competitorAnalysis.updateMany({
      where: { id: head.id, status: "queued", OR: [{ launchedAt: null }, { launchedAt: { lt: new Date(at.getTime() - STALE_MS) } }] },
      data: { launchedAt: at },
    });
    if (!marked.count) return;
    const { launchAnalysis } = await import("../run");
    try {
      await launchAnalysis(head.id);
    } catch (e) {
      // No runner was started: the next kick may ask again at once.
      await db.competitorAnalysis.updateMany({ where: { id: head.id, status: "queued", launchedAt: at }, data: { launchedAt: null } });
      throw e;
    }
  } catch (e) {
    console.error("[competitors] could not start the next analysis", e);
  }
}

/** Runs whose runner stopped reporting for 10 minutes go back to the queue (the next start continues from state); the third time they fail. */
export async function sweepStaleAnalyses(t: Date): Promise<number> {
  const cutoff = new Date(t.getTime() - STALE_MS);
  const stale = await db.competitorAnalysis.findMany({
    where: { status: { in: ["running", "waiting"] }, heartbeatAt: { lt: cutoff } },
    select: { id: true, kind: true, staleCount: true, workspaceId: true, competitorId: true, trigger: true, step: true, scanId: true, startedById: true },
  });
  let swept = 0;
  for (const s of stale) {
    const gaveUp = s.staleCount + 1 >= MAX_STALE;
    const r = await db.competitorAnalysis.updateMany({
      where: { id: s.id, status: { in: ["running", "waiting"] }, heartbeatAt: { lt: cutoff } },
      data: gaveUp
        ? { status: "failed", staleCount: s.staleCount + 1, resumeAt: null, ownerToken: null, finishedAt: new Date(), errorKind: "stale", error: `the runner stopped reporting ${MAX_STALE} times` }
        : { status: "queued", staleCount: s.staleCount + 1, resumeAt: null, ownerToken: null, launchedAt: null },
    });
    if (!r.count) continue;
    swept++;
    if (gaveUp) {
      await recordCompetitorEvent(s.workspaceId, s.startedById, s.kind === "setup" ? "cmp_setup_finished" : "cmp_analysis_finished", { analysisId: s.id, competitorId: s.competitorId, trigger: s.trigger, outcome: "failed", step: s.step, errorKind: "stale" });
      // A run that was given up failed like any other: support hears about it, once.
      await alertSupport(s.id);
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

/**
 * Where a run's log lines go besides the run row, in this process: the scanner CLI sets it for `--setup`, so a run of
 * hours shows on the console line by line. Null (the default, and always in the app server) = the run row only.
 */
let echo: ((line: AnalysisLogLine) => void) | null = null;
export function echoRunLog(to: ((line: AnalysisLogLine) => void) | null): void {
  echo = to;
}

/** What the setup walk (analysis/setup.ts) gets from the engine: the run, its accounting, and one context per company. */
export interface SetupEnv {
  run: { id: string; workspaceId: string; ownCompetitorId: string; startedById: string | null; startedAt: Date; injected: boolean; resumed: boolean };
  model: string;
  /** "read medium · match high · judge medium": how much each role thinks in this run (models.ts thinkingFor). */
  thinking: string;
  /** "What the analysis reads" in this run (analysis/reads.ts). */
  reads: ReadSetting;
  /** The run's recorded progress (CompetitorAnalysis.setup): written with every heartbeat. */
  progress: SetupProgress;
  log: RunContext["log"];
  /** One step of the run, with a log line of what it cost. */
  inStep: <R>(name: AnalysisStepName, work: () => Promise<R>) => Promise<R>;
  /**
   * The context of one company — made once per company per walk: its own counters, page progress and cursor, and
   * its own reading budget (the same token budget per company as an analysis run, counted over the whole setup run).
   */
  company: (c: SetupCompany) => Promise<RunContext>;
  /** The context of the calls that belong to no company (unify, domains): the run's own cursor, the shared counters. */
  shared: RunContext;
  setStage: (competitorId: string, stage: SetupStage) => void;
  /** The caps one company hit in this run so far (its record carries them). */
  capsOf: (competitorId: string) => CapHit[];
  /** The incidents one company had in this run so far (its record carries them). */
  incidentsOf: (competitorId: string) => IncidentLog;
  flush: () => Promise<void>;
}

export async function runAnalysis(id: string): Promise<void> {
  // A model per role (models.ts), resolved once: every call of the run names its role. The run row carries all three.
  const models = competitorsModels();
  const model = modelsLine(models);
  // How much each role thinks (models.ts thinkingFor), resolved once like the models.
  const thinking = competitorsThinking();
  /** The retired one-value-for-all setting, when the environment still sets it: said in the log, never honoured. */
  const retired = retiredThinkingOverride();
  // The claim's owner token: every later write of this worker carries it in its `where`.
  const token = randomUUID();
  // The claim: only the head of the queue can be claimed, and only once — so two runs never execute together.
  // `kind` is read inside the claim on purpose: a process whose database client predates the setup run (a server
  // that was not restarted after the schema change) fails here, before it has claimed anything.
  const claimed = await db.$transaction(async (tx) => {
    const head = await tx.competitorAnalysis.findFirst({ where: activeQueue(), orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, startedAt: true, kind: true } });
    if (!head || head.id !== id) return null;
    const t = new Date();
    const r = await tx.competitorAnalysis.updateMany({ where: { id, status: "queued" }, data: { status: "running", startedAt: head.startedAt ?? t, heartbeatAt: t, resumeAt: null, model, ownerToken: token } });
    return r.count ? { resumed: head.startedAt != null, startedAt: head.startedAt ?? t } : null;
  });
  if (!claimed) return;

  const row = await db.competitorAnalysis.findUnique({ where: { id }, include: { competitor: { select: { id: true, name: true, host: true, websiteUrl: true, deletedAt: true, isOwn: true } } } });
  if (!row) return;
  const isSetup = row.kind === "setup";
  const what = isSetup ? "Setup run" : "Analysis";
  const t0 = Date.now();
  const counters = readCounters(row.counters);
  const lines: AnalysisLogLine[] = Array.isArray(row.log) ? (row.log as unknown as AnalysisLogLine[]) : [];
  const progress = { pagesTotal: row.pagesTotal, pagesDone: row.pagesDone };
  /** A setup run: its per-company progress. The run's own counters and page progress are their sum (sync). */
  const setup: SetupProgress | null = isSetup ? readSetupProgress(row.setup) : null;
  /** The run's tokens by step and model (usage.ts). A setup run's are the roll-up of its companies' lists and its shared calls. */
  let usage: StepUsage[] = readUsage(row.usage);
  /** The caps this run hit (caps.ts): one entry per cap and company. [] = no cap was hit. */
  const caps: CapHit[] = readCaps(row.caps);
  /** "What the analysis reads" when this run ran (set at the start of the walk), and what a run of one company left out because its kind is off. */
  let runReads: ReadSetting | null = null;
  let notRead: NotReadByKind = {};
  /** The incidents of this run (incidents.ts): answers that should never happen, each kept as a case. */
  const incidents: IncidentLog = readIncidents(row.incidents) ?? emptyIncidents();
  // The run's speed (pacing.ts): it starts fast, goes faster while calls succeed and halves when the provider pushes
  // back. One pacer for the whole run — every step, and in a setup run every company, shares what it learned.
  const pacer = new Pacer(PACE_START_SPEED, analysisMaxSpeed());
  /** How the run paced itself. A run that continues starts fast again and keeps the pushbacks of its earlier walks. */
  const paced: PacingRecord = { ...(readPacing(row.pacing) ?? emptyPacing(pacer)), start: pacer.start, max: pacer.max };
  const pacing = (): PacingRecord => ({ ...paced, peak: Math.max(paced.peak, pacer.peak), speed: pacer.speed });
  const sync = () => {
    if (!setup) return;
    const t = setupTotals(setup);
    Object.assign(counters, t.counters);
    usage = t.usage;
    progress.pagesTotal = t.pagesTotal;
    progress.pagesDone = t.pagesDone;
  };
  const log: RunContext["log"] = (level, msg, url) => {
    const line: AnalysisLogLine = { at: new Date().toISOString(), level, msg, ...(url ? { url } : {}) };
    lines.push(line);
    echo?.(line);
  };
  let step: AnalysisStepName = "map";
  let lost = false;
  /** A cap of the run as a whole — the two ceilings of its speed: recorded for no company, said once in the log. */
  const runCap = (cap: CapId, r: { limit: number; undone: number; times?: number }) => {
    const recorded = recordCap(caps, { cap, limit: r.limit, competitorId: null, company: null, undone: r.undone, times: r.times });
    if (recorded.fresh || (recorded.changed && CAPS[cap].mode !== "event")) log("warn", `Cap hit — ${capLine(recorded.hit)}`);
  };
  /** Every write to the run row goes through here: it names the claim, and zero rows means the run is no longer this worker's. */
  const own = async (data: Prisma.CompetitorAnalysisUpdateManyMutationInput): Promise<boolean> => {
    const r = await db.competitorAnalysis.updateMany({ where: { id, ownerToken: token }, data });
    if (!r.count) lost = true;
    return r.count > 0;
  };
  /** What a heartbeat and the close write besides the status. */
  const state = (): Prisma.CompetitorAnalysisUpdateManyMutationInput => {
    sync();
    // The log keeps its newest lines only: when older ones were dropped, that is a cap like any other.
    if (lines.length > MAX_LOG_LINES) recordCap(caps, { cap: "log_lines", limit: MAX_LOG_LINES, competitorId: null, company: null, undone: lines.length - MAX_LOG_LINES });
    return {
      counters: counters as unknown as Prisma.InputJsonValue, usage: usage as unknown as Prisma.InputJsonValue, caps: caps as unknown as Prisma.InputJsonValue, pacing: pacing() as unknown as Prisma.InputJsonValue,
      ...(incidents.total ? { incidents: incidents as unknown as Prisma.InputJsonValue } : {}),
      // The kinds that were on when the run ran, and — for a run of one company — what it left out (a setup run keeps that per company).
      ...(runReads ? { reads: { kinds: runReads, notRead } as unknown as Prisma.InputJsonValue } : {}),
      log: lines.slice(-MAX_LOG_LINES) as unknown as Prisma.InputJsonValue, pagesTotal: progress.pagesTotal, pagesDone: progress.pagesDone,
      ...(setup ? { setup: setup as unknown as Prisma.InputJsonValue } : {}),
    };
  };
  const flush = async () => {
    // A database error is not a lost claim: it is ignored here, and the next heartbeat tries again.
    await own({ heartbeatAt: new Date(), ...state() }).catch(() => undefined);
  };
  const heartbeat = setInterval(() => void flush(), HEARTBEAT_MS);
  const setStep = async (s: AnalysisStepName) => {
    step = s;
    if (!(await own({ step: s, heartbeatAt: new Date() }))) throw new RunLost();
  };

  let outcome: "done" | "failed" | "cancelled" = "done";
  let errorKind: string | null = null;
  let error: string | null = null;
  try {
    // The token budget: one number for the installation, read once. An analysis run counts every token it used so far
    // (a run that continues keeps its counters); a setup run counts per company. What the budget left unread is
    // counted again by the steps of this walk.
    const budgetLimit = await analysisTokenBudget();
    // TEST KNOB, read ONCE per run: a run flagged injected whose answers are gone fails — it can never reach a real model.
    const answers = await testAiAnswers(row.competitorId);
    if (row.injected && !answers) throw new AnalysisError("other", "test answers were cleared before the run started (test knob) — no model is called");
    // "What the analysis reads": one setting for the installation, read once — the run records it and says it in its log.
    const reads = await analysisReads();
    runReads = reads;
    const pace = new TokenBudget(analysisTpm());
    let okCalls = 0;
    let refused = 0;
    let stopCheckedAt = 0;
    let stop = Boolean(row.competitor.deletedAt);
    const shouldStop = async () => {
      if (lost) return true;
      if (stop || Date.now() - stopCheckedAt < 10_000) return stop;
      stopCheckedAt = Date.now();
      const [c, mine] = await Promise.all([
        db.competitor.findUnique({ where: { id: row.competitorId }, select: { deletedAt: true } }),
        db.competitorAnalysis.findUnique({ where: { id }, select: { ownerToken: true } }),
      ]);
      if (mine?.ownerToken !== token) lost = true;
      stop = !c || Boolean(c.deletedAt);
      return stop || lost;
    };
    const cursor = row.cursor && typeof row.cursor === "object" && !Array.isArray(row.cursor) ? { ...(row.cursor as Record<string, unknown>) } : {};
    const persistCursor = async () => {
      if (!(await own({ cursor: cursor as Prisma.InputJsonValue }))) throw new RunLost();
    };
    /** Every token of the run so far, and all it waited — a setup run's are the sums over its companies. */
    const waitedMs = () => {
      sync();
      return counters.waitedMs;
    };

    /** What a context works on: one company with its own accounting. An analysis run has one; a setup run one per company and one shared. */
    interface Target {
      competitor: RunContext["competitor"];
      /** Who a cap hit in this context is recorded for: the company, or nobody (a setup run's shared calls). */
      capsFor: { id: string | null; name: string | null };
      counters: Counters;
      /** Its tokens by step and model: every call adds to the row of the running step and the call's model. */
      usage: StepUsage[];
      progress: { pagesTotal: number; pagesDone: number };
      answers: TestAiAnswers | null;
      cursor: Record<string, unknown>;
      markApplied: (at: Date) => Promise<void>;
      /** Put before every log line of the context ("[Acme] "). */
      prefix: string;
      /** Where what the reading left out (a kind that is off) is kept: the run's own record, or the company's entry of a setup run. */
      setNotRead: (notRead: NotReadByKind) => void;
    }
    const contextFor = (t: Target): RunContext => {
      const c = t.counters;
      c.budget = budgetLimit;
      c.budgetReached = 0;
      c.pagesUnread = 0;
      const reading = new ReadingBudget(budgetLimit, () => c.inputTokens + c.outputTokens);
      const say: RunContext["log"] = (level, msg, url) => log(level, `${t.prefix}${msg}`, url);
      // What was true at the end of the company's last walk (pages left unread, looks not made) is decided again by this one.
      clearStateCaps(caps, t.capsFor.id);
      return {
        run: { id, workspaceId: row.workspaceId, competitorId: row.competitorId, trigger: row.trigger, scanId: row.scanId, startedById: row.startedById, cursor: t.cursor },
        competitor: t.competitor,
        setup: isSetup,
        plan: null,
        // The installation's setting; a company's own override would be laid on top here (none exists today).
        reads: effectiveReads(reads, null),
        setNotRead: t.setNotRead,
        model: models.read,
        models,
        answers: t.answers,
        counters: c,
        log: say,
        progress: t.progress,
        reading,
        cap: (cap, r) => {
          const recorded = recordCap(caps, { cap, limit: r.limit, competitorId: t.capsFor.id, company: t.capsFor.name, undone: r.undone, also: r.also, times: r.times });
          // A cap that bites on every page says so once; the run's last lines carry the totals.
          if (recorded.fresh || (recorded.changed && CAPS[cap].mode !== "event")) log("warn", `Cap hit — ${capLine(recorded.hit)}`);
        },
        incident: (i) => {
          const one: Incident = { ...i, at: new Date().toISOString(), step, competitorId: t.capsFor.id, company: t.capsFor.name };
          recordIncident(incidents, one);
          c.incidents++;
          // Never silent: every case is a line of the run's log.
          log("warn", `INCIDENT — ${incidentLine(one)}`, one.pageUrl ?? undefined);
        },
        call: async <T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, opts: StepCallOptions) => {
          const { role, ...rest } = opts;
          const callModel = models[role];
          // A worker that lost the run spends nothing more.
          if (lost) throw new RunLost();
          if (t.answers && opts.injected === undefined) throw new AnalysisError("other", "this run takes injected answers (test knob) and a step asked for a model call");
          if (t.answers?.rateLimit && okCalls >= t.answers.rateLimit.afterCalls && refused < t.answers.rateLimit.times) {
            refused++;
            throw new CapacityError("PMOS AI has no capacity (test knob)");
          }
          let r;
          const callStarted = Date.now();
          try {
            r = await callTool<T>(system, shared, tail, tool, { ...rest, model: callModel, thinking: thinking[role] });
          } catch (e) {
            if (e instanceof AnswerError) {
              // The call was made and is billed: its tokens count, whatever the step does with the failure.
              c.calls++;
              c.unusableAnswers++;
              c.inputTokens += e.usage.input;
              c.outputTokens += e.usage.output;
              c.cachedTokens += e.usage.cached;
              c.thinkingTokens += e.usage.thinking;
              addUsage(t.usage, step, callModel, e.usage, Date.now() - callStarted);
              throw e;
            }
            if (e instanceof CapacityError) throw e;
            // Anything the run cannot wait out — a refused model id above all — fails it with the step and the model named.
            throw new AnalysisError("ai", callFailureMessage({ status: (e as { status?: unknown } | null)?.status, message: e instanceof Error ? e.message : String(e) }, { step, role, model: callModel }));
          }
          okCalls++;
          c.calls++;
          c.inputTokens += r.usage.input;
          c.outputTokens += r.usage.output;
          c.cachedTokens += r.usage.cached;
          // The model's own thinking is billed as output: counted there, and kept apart (usage.ts).
          c.thinkingTokens += r.usage.thinking;
          const ms = Date.now() - callStarted;
          addUsage(t.usage, step, callModel, r.usage, ms);
          return { value: r.value, tokens: r.usage.input + r.usage.output, usage: r.usage, ms, model: callModel };
        },
        paced: async <T>({ reading: isReading, ...o }: Pick<PacedOptions<T>, "items" | "concurrency" | "estimate" | "work" | "onAnswerError"> & { reading?: boolean }) => {
          const held = { calls: pace.holds, ms: pace.heldMs };
          const r = await runPaced<T>({
            ...o,
            ...(isReading ? { admit: (item: T) => reading.admit(o.estimate(item)), release: (item: T) => reading.release(o.estimate(item)) } : {}),
            budget: pace,
            pacer,
            sleep,
            // 24 h of waiting in all, across the steps (and the companies) of the run.
            maxWaitMs: Math.max(0, MAX_WAIT_MS - waitedMs()),
            baseWaitMs: analysisBaseWaitMs("capacity"),
            transientBaseWaitMs: analysisBaseWaitMs("endpoint"),
            shouldStop,
            onWait: async (ms, attempt, cause) => {
              const resumeAt = new Date(Date.now() + ms);
              c.waits++;
              c.waitedMs += ms;
              // Every pushback is recorded on the run: when, in which step, at what speed, the speed after, how long it waits.
              const speed = cause.speed ?? { from: pacer.speed, to: pacer.speed };
              recordPushback(paced, { at: new Date().toISOString(), step, company: t.capsFor.name, reason: cause.transient ? "endpoint" : "capacity", speed: speed.from, next: speed.to, waitMs: ms, retryAfterMs: cause.retryAfterMs });
              say("warn", `${cause.transient ? `PMOS AI did not answer (${cause.message.slice(0, 160)})` : "PMOS AI has no capacity"} — slowing from ${speed.from} to ${speed.to} call${speed.to === 1 ? "" : "s"} at once, waiting ${Math.round(ms / 1000)} s${cause.retryAfterMs ? " (the provider asked for it)" : ""}, then continuing from where it stopped (pushback ${attempt} in a row)`);
              await own({ status: "waiting", resumeAt });
              await flush();
              await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_waiting", { analysisId: id, competitorId: t.competitor.id, kind: row.kind, step, waitMs: ms, attempt, reason: cause.transient ? "endpoint" : "capacity", speedFrom: speed.from, speedTo: speed.to });
            },
            onResume: async () => {
              if (!(await own({ status: "running", resumeAt: null, heartbeatAt: new Date() }))) throw new RunLost();
              say("info", "Continuing");
            },
          });
          // The two ceilings are safety nets: a run that was ever held back by one says so, like any other cap.
          if (pace.holds > held.calls) runCap("tpm_ceiling", { limit: pace.tokensPerMinute, undone: Math.round((pace.heldMs - held.ms) / 1000), times: pace.holds - held.calls });
          if (pacer.ceilingHit) runCap("speed_ceiling", { limit: pacer.max, undone: 0 });
          if (lost) throw new RunLost();
          if (r.stopped) throw new RunCancelled();
          if (reading.reached) c.budgetReached = 1;
          return r;
        },
        saveCursor: async (patch) => {
          Object.assign(t.cursor, patch);
          await persistCursor();
        },
        markApplied: t.markApplied,
        flush,
      };
    };
    if (await shouldStop()) throw lost ? new RunLost() : new RunCancelled();

    /** One step, with a log line of what it cost — also when it fails: the counters are totals, this is the split. */
    const inStep = async <R>(name: AnalysisStepName, work: () => Promise<R>): Promise<R> => {
      await setStep(name);
      sync();
      const before = { ...counters };
      const usedBefore = usage.map((u) => ({ ...u }));
      const started = Date.now();
      try {
        return await work();
      } finally {
        sync();
        const calls = counters.calls - before.calls;
        if (calls > 0) {
          const unusable = counters.unusableAnswers - before.unusableAnswers;
          // The step's cost, model by model.
          log("info", `Step ${name.replace("_", " ")}: ${usageByModel(usageSince(usage, usedBefore)).map(usageLine).join("; ") || `${calls} PMOS AI call${calls === 1 ? "" : "s"}`}${unusable ? ` · ${unusable} unusable answer${unusable === 1 ? "" : "s"}` : ""} · ${Math.round((Date.now() - started) / 1000)} s`);
        }
      }
    };
    const company = (c: { id: string; name: string; host: string; websiteUrl: string; isOwn: boolean }): RunContext["competitor"] => ({ id: c.id, name: c.name, host: c.host, websiteUrl: c.websiteUrl, isOwn: c.isOwn });

    if (setup) {
      // ——— The setup run: the organization's own source and every competitor (analysis/setup.ts) ———
      const made = new Map<string, RunContext>();
      const companyCursors = (cursor.companies && typeof cursor.companies === "object" && !Array.isArray(cursor.companies) ? cursor.companies : (cursor.companies = {})) as Record<string, Record<string, unknown>>;
      await setupWalk({
        run: { id, workspaceId: row.workspaceId, ownCompetitorId: row.competitorId, startedById: row.startedById, startedAt: claimed.startedAt, injected: row.injected, resumed: claimed.resumed },
        model,
        thinking: `${thinkingLine(thinking)}${retired ? ` (${THINKING_ENV_ALL}="${retired}" is set and ignored)` : ""}`,
        reads,
        progress: setup,
        log,
        inStep,
        company: async (c) => {
          const known = made.get(c.id);
          if (known) return known;
          let entry = setup.companies.find((x) => x.competitorId === c.id);
          if (!entry) {
            entry = { competitorId: c.id, name: c.name, own: c.isOwn, stage: "waiting", pagesTotal: 0, pagesDone: 0, appliedAt: null, counters: emptyCounters(), usage: [], notRead: {} };
            setup.companies.push(entry);
          }
          entry.name = c.name;
          const mine = entry;
          // TEST KNOB: an injected setup run takes every company's answers from the knob and never calls a model; a real run never reads them.
          const theirs = row.injected ? await testAiAnswers(c.id) : null;
          if (row.injected && !theirs) throw new AnalysisError("other", `this setup run takes injected answers (test knob) and ${c.name} has none — no model is called`);
          const ctx = contextFor({
            competitor: company(c),
            capsFor: { id: c.id, name: c.name },
            counters: mine.counters,
            usage: mine.usage,
            progress: mine,
            answers: theirs,
            cursor: (companyCursors[c.id] ??= {}),
            markApplied: async (at) => {
              mine.appliedAt = at.toISOString();
              await flush();
            },
            prefix: `[${c.name}] `,
            setNotRead: (n) => {
              mine.notRead = n;
            },
          });
          made.set(c.id, ctx);
          return ctx;
        },
        shared: contextFor({ competitor: company(row.competitor), capsFor: { id: null, name: null }, counters: setup.shared, usage: setup.sharedUsage, progress: { pagesTotal: 0, pagesDone: 0 }, answers: row.injected ? answers : null, cursor, markApplied: async () => undefined, prefix: "", setNotRead: () => undefined }),
        setStage: (competitorId, stage) => {
          const entry = setup.companies.find((x) => x.competitorId === competitorId);
          if (entry) entry.stage = stage;
        },
        capsOf: (competitorId) => capsOf(caps, competitorId),
        incidentsOf: (competitorId) => incidentsOf(incidents, competitorId),
        flush,
      });
    } else {
      // ——— An analysis run: one company ———
      const ctx = contextFor({
        competitor: company(row.competitor),
        capsFor: { id: row.competitor.id, name: row.competitor.name },
        counters,
        usage,
        progress,
        answers,
        cursor,
        markApplied: async (at) => {
          if (!(await own({ appliedAt: at }))) throw new RunLost();
        },
        prefix: "",
        setNotRead: (n) => {
          notRead = n;
        },
      });
      const reading = ctx.reading;
      const isOwn = row.competitor.isOwn;
      log("info", `Analysis ${claimed.resumed ? "continued" : "started"} (${row.trigger}) for ${row.competitor.name}${isOwn ? " — the organization's own site" : ""}${answers ? " — PMOS AI answers injected (test knob), no model is called" : ` — ${model} — thinking: ${thinkingLine(thinking)}`}`);
      if (retired && !answers) log("warn", `${THINKING_ENV_ALL} is set to "${retired}" in this environment and is IGNORED: each role thinks at its own level (${thinkingLine(thinking)})`);
      log("info", `${readsLine(reads)} (Administration → Competitors → What the analysis reads)`);
      // The map first: what is read follows from the reading plan. No plan, no read — a failed map fails the run.
      await inStep("map", () => mapStep(ctx));
      await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_started", {
        analysisId: id, competitorId: row.competitorId, trigger: row.trigger, scanId: row.scanId, resumed: claimed.resumed, own: isOwn,
        mapSections: counters.mapSections, reads: READ_KINDS.filter((k) => reads[k]).join(","), model, injected: Boolean(answers),
      });
      // The reading: the pages that are new or changed, in chunks, against the company's list so far.
      await inStep("reading", () => readingStep(ctx));
      // A run fills the table only in an organization whose setup is done (an explicit state, setup-rules.ts): no row is created before.
      const setupState = await workspaceSetupState(row.workspaceId);
      const path = analysisPath(setupState, isOwn);
      if (!path.includes("match")) {
        log("info", `${setupState === "in_setup" ? "The setup run of this organization has not finished" : "The setup of this organization is required and has not been started"}: the run stops after the reading. ${row.competitor.name}'s list is ready — it gets its rows and its cells in the setup run (--setup ${row.workspaceId})`);
      } else {
        // The company's new items against the rows that exist; what matches nothing becomes a new row in an existing domain.
        await inStep("match", () => matchStep(ctx));
        // The own source: what its items say is ours — no second look, no profile facts (own.ts).
        const lookWaiting = path.includes("second_look") ? await inStep("second_look", () => secondLookStep(ctx)) : new Set<string>();
        await inStep("apply", () => applyStep(ctx, lookWaiting));
        if (path.includes("facts")) await inStep("facts", () => factsStep(ctx));
      }
      if (reading.reached) {
        log("warn", `The token budget of this run was reached (${(counters.inputTokens + counters.outputTokens).toLocaleString("en-US")} of ${counters.budget.toLocaleString("en-US")} tokens used): ${counters.pagesUnread} page${counters.pagesUnread === 1 ? "" : "s"} left unread${counters.secondLooksWaiting ? `, ${counters.secondLooksWaiting} row${counters.secondLooksWaiting === 1 ? "" : "s"} not looked for` : ""}. They stay due — the next run of ${row.competitor.name} continues with a fresh budget`);
      }
    }
    sync();
    log("info", `Speed: ${pacingLine(pacing())}`);
    // Limits are safety nets: the run's last lines say whether one was hit, each with what it left undone.
    if (caps.length) log("warn", `${capsHeadline(caps)} in this run — ${capLines(caps).join("; ")}`);
    else log("info", `${capsHeadline(caps)} in this run`);
    // So is an incident: an answer that should never happen is counted here and kept as a case on the run.
    log(incidents.total ? "warn" : "info", `${incidentsHeadline(incidents)} in this run`);
    log("info", `${what} done in ${Math.round((Date.now() - t0) / 1000)} s · ${counters.pagesRead} page${counters.pagesRead === 1 ? "" : "s"} read · ${counters.calls} PMOS AI call${counters.calls === 1 ? "" : "s"} · ${counters.inputTokens + counters.outputTokens} tokens${counters.thinkingTokens ? ` (${counters.inputTokens} input, ${counters.outputTokens} output — ${counters.thinkingTokens} of the output was the models' own thinking)` : ""}`);
  } catch (e) {
    if (lost || e instanceof RunLost) {
      lost = true;
    } else if (e instanceof RunCancelled) {
      outcome = "cancelled";
      log("warn", isSetup ? "The organization's own site was removed — setup run cancelled" : "The competitor was removed — analysis cancelled");
    } else {
      outcome = "failed";
      errorKind = e instanceof CapacityError ? "capacity" : e instanceof AnswerError ? "answer" : e instanceof EndpointError ? "ai" : e instanceof AnalysisError ? e.kind : "other";
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      log("error", `${what} stopped in the ${step.replace("_", " ")} step: ${error}`);
      if (!(e instanceof CapacityError || e instanceof AnswerError || e instanceof AnalysisError || e instanceof EndpointError)) console.error("[competitors] analysis failed", id, e);
    }
  } finally {
    clearInterval(heartbeat);
  }

  // The close carries the owner token too: a worker that lost the run never overwrites the status the other worker set.
  // Decided here, once: a heartbeat still in flight that lands after the close finds no owner and must not count.
  let closed = false;
  if (!lost) {
    const finishedAt = new Date();
    try {
      closed = await own({ status: outcome, step: outcome === "done" ? "done" : step, finishedAt, heartbeatAt: finishedAt, resumeAt: null, ownerToken: null, errorKind: errorKind ?? "none", error, ...state() });
    } catch (e) {
      // The database refused the write: not a lost claim. The stale sweep will put the run back; the event and the kick below still go out.
      console.error("[competitors] could not close the analysis run", id, e);
      closed = true;
    }
  }
  if (!closed) {
    console.warn(`[competitors] analysis ${id}: this worker no longer owns the run (it was put back in the queue while this process was alive) — stopped in the ${step} step without writing; the run continues from the tables when it is claimed again`);
    return;
  }
  if (setup) {
    // A setup run that failed or was cancelled leaves the organization "in setup": the same run is continued (setup-rules.ts).
    if (outcome !== "done") await moveSetupState(row.workspaceId, "run_stopped").catch((e) => console.error("[competitors] the setup state could not be written", id, e));
    await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_setup_finished", {
      analysisId: id, outcome, step, companies: setup.companies.length, rows: setup.rows, domains: setup.domains, features: setup.features,
      calls: counters.calls, tokens: counters.inputTokens + counters.outputTokens, inputTokens: counters.inputTokens, outputTokens: counters.outputTokens, cachedTokens: counters.cachedTokens, thinkingTokens: counters.thinkingTokens, thinking: thinkingLine(thinking), tokensByModel: usageByModelText(usage), models: model, pagesRead: counters.pagesRead, ...capsForEvent(caps), ...incidentsForEvent(incidents), speedPeak: pacing().peak, pushbacks: paced.total,
      durationMs: Date.now() - t0, totalMs: Date.now() - claimed.startedAt.getTime(), resumed: claimed.resumed, errorKind: errorKind ?? "none", error,
    });
  } else {
    await recordCompetitorEvent(row.workspaceId, row.startedById, "cmp_analysis_finished", {
      analysisId: id, competitorId: row.competitorId, trigger: row.trigger, outcome, step, durationMs: Date.now() - t0, ...counters, budgetReached: counters.budgetReached > 0, tokensByModel: usageByModelText(usage), models: model, thinking: thinkingLine(thinking), ...capsForEvent(caps), ...incidentsForEvent(incidents), speedPeak: pacing().peak, pushbacks: paced.total, errorKind: errorKind ?? "none", error,
    });
  }
  await alertSupport(id);
  await notifyScanRun(row.scanId);
  await kickAnalyses();
}

/**
 * The ONE email of a run to support (analysis/alert.ts): sent when the run ended failed, hit any cap or had an incident. Read from
 * the run row after it was closed, so the email says what the row says. Called once per ending — by the worker that
 * closed the run, or by the stale sweep that gave it up. A send that fails never fails anything: it is logged, and
 * recorded (cmp_run_alert, sent false).
 */
async function alertSupport(id: string): Promise<void> {
  try {
    const run = await db.competitorAnalysis.findUnique({
      where: { id },
      select: {
        id: true, kind: true, workspaceId: true, status: true, step: true, error: true, errorKind: true, caps: true, incidents: true, counters: true, model: true, startedAt: true, finishedAt: true, startedById: true,
        competitor: { select: { name: true, isOwn: true, workspace: { select: { organization: { select: { name: true } } } } } },
      },
    });
    if (!run || (run.status !== "done" && run.status !== "failed")) return;
    const hit = readCaps(run.caps);
    const cases = readIncidents(run.incidents);
    if (!runAlertDue({ outcome: run.status, caps: hit.length, incidents: cases.total })) return;
    const c = readCounters(run.counters);
    // Loaded here: local.ts (the scanner's own support alerts) and the mailer are not needed by a run that ends clean.
    const [{ SUPPORT_EMAIL, appUrl }, { sendEmail }] = await Promise.all([import("../local"), import("../../mailer")]);
    const email = runAlertEmail({
      kind: run.kind, outcome: run.status, organization: run.competitor.workspace.organization.name, company: run.competitor.name, ownSite: run.competitor.isOwn, runId: run.id, workspaceId: run.workspaceId,
      step: run.step, error: run.error, errorKind: run.errorKind, caps: hit, incidents: cases, models: run.model ?? "", calls: c.calls, inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      startedAt: run.startedAt, finishedAt: run.finishedAt ?? new Date(), appUrl: appUrl(),
    });
    let sent = false;
    try {
      await sendEmail({ to: SUPPORT_EMAIL, subject: email.subject, text: email.text });
      sent = true;
    } catch (e) {
      console.error("[competitors] the run's alert email to support could not be sent", id, e);
    }
    await recordCompetitorEvent(run.workspaceId, run.startedById, "cmp_run_alert", { analysisId: id, kind: run.kind, outcome: run.status, sent, ...capsForEvent(hit), ...incidentsForEvent(cases) });
  } catch (e) {
    console.error("[competitors] the run's alert to support failed", id, e);
  }
}
