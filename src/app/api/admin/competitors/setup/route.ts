import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { capLines, capsOf, readCaps } from "@/lib/competitors/analysis/caps";
import { CHUNK_SELECT, chunkView, type ChunkView } from "@/lib/competitors/analysis/chunk-view";
import { incidentLine, incidentsOf, readIncidents } from "@/lib/competitors/analysis/incidents";
import { notReadLine, readRunReads, readsLine } from "@/lib/competitors/analysis/reads";
import { readCounters } from "@/lib/competitors/analysis/counters";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { setSetupState, workspaceSetup } from "@/lib/competitors/analysis/setup";
import { isOrgSetupState, ORG_SETUP_STATES, readSetupProgress, type OrgSetupState, type SetupStage } from "@/lib/competitors/analysis/setup-rules";
import { pacingView, type PacingView } from "@/lib/competitors/analysis/pacing";
import { readUsage, sortUsage, type StepUsage } from "@/lib/competitors/analysis/usage";

/**
 * Administration → Competitors → Setup runs (PM-OS admin only): an organization's setup state, its own site, and
 * its setup runs with the progress of every company (analysis/setup.ts).
 *
 *   GET   ?organizationId=<id>        → { state, stateSet, ownSite, domains, capabilities, runs: AdminSetupRun[] }
 *   PATCH { organizationId, state }   → a PM-OS admin sets the setup state by hand: required | in_setup | done.
 *                                       The customer never can (setup-rules.ts).
 *
 * Nothing here starts or changes a run: the setup run is started from the scanner CLI (--setup <workspaceId>).
 */

/** Runs returned at most, newest first. */
const MAX_RUNS = 5;

export interface AdminSetupCompany {
  competitorId: string;
  name: string;
  own: boolean;
  stage: SetupStage;
  pagesRead: number;
  pagesUnread: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** The part of outputTokens that was the models' own thinking (0 where the provider reported none, and for an older run). */
  thinkingTokens: number;
  budgetReached: boolean;
  calls: number;
  /** The company's tokens per step and model. */
  usage: StepUsage[];
  /** The caps hit for this company, one line each. */
  caps: string[];
  /** What the run left out of this company because its kind was off in "What the analysis reads" — "" when nothing. A setting, not a cap. */
  notRead: string;
  /** Its incidents in this run, one line each (answers that should never happen); [] = none. */
  incidents: string[];
  /** The reading requests this run made for the company, in order: its chunks, their pages and tokens, what each answer did. */
  chunks: ChunkView[];
}

export interface AdminSetupRun {
  id: string;
  status: string;
  step: string;
  companies: AdminSetupCompany[];
  rows: number;
  domains: number;
  features: number;
  calls: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** The part of outputTokens that was the models' own thinking (0 where the provider reported none, and for an older run). */
  thinkingTokens: number;
  /** The run's tokens per step and model: all companies and the shared calls (unify, domains) together. */
  usage: StepUsage[];
  /** The calls that belong to no company (unify, domains), per step and model. */
  sharedUsage: StepUsage[];
  /** Every cap the run hit, one line each — the company named on the line; [] = no cap was hit. */
  caps: string[];
  /** The kinds that were on when the run ran ("Reading: … — not read: …"); null for a run from before the setting existed. */
  reads: string | null;
  /** Every incident of the run, one line each — the company named on the line; [] = none. */
  incidents: string[];
  /** All incidents of the run, also the ones no longer listed. */
  incidentsTotal: number;
  /** How the run paced itself and every pushback of the provider (analysis/pacing.ts); null for a run from before it was recorded. */
  pacing: PacingView | null;
  /** The models of the run ("read … · match … · judge …"). */
  model: string | null;
  /** The token budget per company of the run; 0 before it started. */
  budget: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface AdminSetupState {
  workspaceId: string;
  /** required | in_setup | done (setup-rules.ts orgSetupState). */
  state: OrgSetupState;
  /** The state is stored on the organization. False = it was never set: `state` is read from the organization's data. */
  stateSet: boolean;
  ownSite: { name: string; host: string } | null;
  domains: number;
  capabilities: number;
  runs: AdminSetupRun[];
}

export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const organizationId = new URL(req.url).searchParams.get("organizationId") ?? "";
  const workspace = organizationId ? await db.workspace.findUnique({ where: { organizationId }, select: { id: true } }) : null;
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceId = workspace.id;
  const [setup, ownSite, runs] = await Promise.all([
    workspaceSetup(workspaceId),
    db.competitor.findFirst({ where: { workspaceId, isOwn: true, deletedAt: null }, select: { name: true, host: true } }),
    db.competitorAnalysis.findMany({
      where: { workspaceId, kind: "setup" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: { id: true, status: true, step: true, counters: true, usage: true, caps: true, incidents: true, reads: true, pacing: true, model: true, setup: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
    }),
  ]);
  if (!setup) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The reading requests of these runs, per company: its chunks.
  const chunks = runs.length ? await db.competitorChunk.findMany({ where: { analysisId: { in: runs.map((r) => r.id) } }, orderBy: [{ createdAt: "asc" }, { position: "asc" }], select: { ...CHUNK_SELECT, competitorId: true } }) : [];
  const body: AdminSetupState = {
    workspaceId,
    state: setup.state,
    stateSet: setup.stored != null,
    ownSite,
    domains: setup.facts.domains,
    capabilities: setup.facts.capabilities,
    runs: runs.map((r): AdminSetupRun => {
      const c = readCounters(r.counters);
      const progress = readSetupProgress(r.setup);
      const hit = readCaps(r.caps);
      const cases = readIncidents(r.incidents);
      const ran = readRunReads(r.reads);
      return {
        reads: ran ? readsLine(ran.kinds) : null,
        id: r.id, status: r.status, step: r.step,
        companies: progress.companies.map((x) => ({
          competitorId: x.competitorId, name: x.name, own: x.own, stage: x.stage, pagesRead: x.counters.pagesRead, pagesUnread: x.counters.pagesUnread,
          tokensUsed: x.counters.inputTokens + x.counters.outputTokens, inputTokens: x.counters.inputTokens, outputTokens: x.counters.outputTokens, cachedTokens: x.counters.cachedTokens, thinkingTokens: x.counters.thinkingTokens,
          budgetReached: x.counters.budgetReached > 0, calls: x.counters.calls, usage: sortUsage(x.usage), caps: capLines(capsOf(hit, x.competitorId)),
          notRead: notReadLine(x.notRead), incidents: incidentsOf(cases, x.competitorId).list.map(incidentLine), chunks: chunks.filter((k) => k.analysisId === r.id && k.competitorId === x.competitorId).map(chunkView),
        })),
        rows: progress.rows, domains: progress.domains, features: progress.features, calls: c.calls, tokensUsed: c.inputTokens + c.outputTokens, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens, thinkingTokens: c.thinkingTokens,
        usage: sortUsage(readUsage(r.usage)), sharedUsage: sortUsage(progress.sharedUsage), caps: capLines(hit), incidents: cases.list.map(incidentLine), incidentsTotal: cases.total, pacing: pacingView(r.pacing), model: r.model, budget: c.budget,
        queuedAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
      };
    }),
  };
  return NextResponse.json(body);
}

export async function PATCH(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isOrgSetupState(body.state)) return NextResponse.json({ error: `state must be one of ${ORG_SETUP_STATES.join(", ")}` }, { status: 400 });
  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const workspace = organizationId ? await db.workspace.findUnique({ where: { organizationId }, select: { id: true } }) : null;
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const before = await setSetupState(workspace.id, body.state);
  if (before == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await recordCompetitorEvent(workspace.id, admin.id, "cmp_setup_state_set", { from: before, to: body.state, by: "admin" });
  return NextResponse.json({ state: body.state });
}
