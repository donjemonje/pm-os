import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { readCounters } from "@/lib/competitors/analysis/counters";
import { readSetupProgress, setupStateOf, type SetupStage, type SetupState } from "@/lib/competitors/analysis/setup-rules";

/**
 * Administration → Competitors → Setup runs (PM-OS admin only, read-only): an organization's setup state, its own
 * site, and its setup runs with the progress of every company (analysis/setup.ts).
 *
 *   GET ?organizationId=<id> → { state, ownSite, domains, capabilities, runs: AdminSetupRun[] }
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
  budgetReached: boolean;
  calls: number;
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
  /** The token budget per company of the run; 0 before it started. */
  budget: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface AdminSetupState {
  workspaceId: string;
  state: SetupState;
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
  const [domains, capabilities, ownSite, runs] = await Promise.all([
    db.competitorDomain.count({ where: { workspaceId } }),
    db.capability.count({ where: { workspaceId } }),
    db.competitor.findFirst({ where: { workspaceId, isOwn: true, deletedAt: null }, select: { name: true, host: true } }),
    db.competitorAnalysis.findMany({
      where: { workspaceId, kind: "setup" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: { id: true, status: true, step: true, counters: true, setup: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
    }),
  ]);
  const body: AdminSetupState = {
    workspaceId,
    state: setupStateOf({ domains, capabilities, lastSetupStatus: runs[0]?.status ?? null }),
    ownSite,
    domains,
    capabilities,
    runs: runs.map((r): AdminSetupRun => {
      const c = readCounters(r.counters);
      const progress = readSetupProgress(r.setup);
      return {
        id: r.id, status: r.status, step: r.step,
        companies: progress.companies.map((x) => ({
          competitorId: x.competitorId, name: x.name, own: x.own, stage: x.stage, pagesRead: x.counters.pagesRead, pagesUnread: x.counters.pagesUnread,
          tokensUsed: x.counters.inputTokens + x.counters.outputTokens, budgetReached: x.counters.budgetReached > 0, calls: x.counters.calls,
        })),
        rows: progress.rows, domains: progress.domains, features: progress.features, calls: c.calls, tokensUsed: c.inputTokens + c.outputTokens, budget: c.budget,
        queuedAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
      };
    }),
  };
  return NextResponse.json(body);
}
