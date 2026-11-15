import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { capLines, readCaps } from "@/lib/competitors/analysis/caps";
import { readCounters } from "@/lib/competitors/analysis/engine";
import { estimateTokens, pacingView, type PacingView } from "@/lib/competitors/analysis/pacing";
import { readUsage, sortUsage, type StepUsage } from "@/lib/competitors/analysis/usage";

/**
 * Administration → Competitors → Reading plan (PM-OS admin only, read-only): one competitor's reading plan — the
 * sections of its site with the label that decides what is read — and its latest analysis runs.
 *
 *   GET ?competitorId=<id> → { competitor: { id, name }, sections: AdminPlanSection[], runs: AdminPlanRun[] }
 *
 * Nothing here changes the plan: a label is given by the analysis run's map step and kept.
 */

/** Runs returned at most, newest first. */
const MAX_RUNS = 10;

export interface AdminPlanSection {
  id: string;
  /** Address prefix without the scheme: "acme.com/products". */
  prefix: string;
  /** The type of the source its pages belong to (website, helpcenter …). */
  sourceType: string;
  label: string;
  pages: number;
  /** Tokens its pages would cost to read, estimated from their characters (pacing.ts estimateTokens). */
  tokens: number;
  /** "ai" | "code" */
  labeledBy: string;
  labeledAt: string;
}

export interface AdminPlanRun {
  id: string;
  trigger: string;
  status: string;
  step: string;
  pagesRead: number;
  pagesUnread: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  calls: number;
  /** The run's tokens per step and model (analysis/usage.ts); [] for a run from before they were split. */
  usage: StepUsage[];
  /** The caps the run hit, one line each (analysis/caps.ts capLine); [] = no cap was hit. */
  caps: string[];
  /** How the run paced itself and every pushback of the provider (analysis/pacing.ts); null for a run from before it was recorded. */
  pacing: PacingView | null;
  /** False for a run from before caps and tokens per step were recorded: "no cap" is then not known. */
  recorded: boolean;
  /** The models of the run, as it recorded them ("read … · match … · judge …", or one model for an older run). */
  model: string | null;
  /** 0 = a run from before the budget existed. */
  budget: number;
  budgetReached: boolean;
  goBackRounds: number;
  goBackPages: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const competitorId = new URL(req.url).searchParams.get("competitorId") ?? "";
  const competitor = competitorId ? await db.competitor.findUnique({ where: { id: competitorId }, select: { id: true, name: true, deletedAt: true } }) : null;
  if (!competitor || competitor.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [sections, runs] = await Promise.all([
    db.competitorSection.findMany({ where: { competitorId }, select: { id: true, prefix: true, label: true, pages: true, chars: true, labeledBy: true, labeledAt: true, source: { select: { type: true } } } }),
    db.competitorAnalysis.findMany({
      // A setup run is attached to the organization's own site and is not one company's run: it is listed under Setup runs.
      where: { competitorId, kind: "analysis" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: { id: true, trigger: true, status: true, step: true, counters: true, usage: true, caps: true, pacing: true, model: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
    }),
  ]);
  // Sections that hold pages first, by address; a section whose folder is gone (0 pages, the label is kept) last.
  sections.sort((a, b) => Number(a.pages === 0) - Number(b.pages === 0) || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  return NextResponse.json({
    competitor: { id: competitor.id, name: competitor.name },
    sections: sections.map((s): AdminPlanSection => ({
      id: s.id, prefix: s.prefix, sourceType: s.source.type, label: s.label, pages: s.pages, tokens: estimateTokens(s.chars), labeledBy: s.labeledBy, labeledAt: s.labeledAt.toISOString(),
    })),
    runs: runs.map((r): AdminPlanRun => {
      const c = readCounters(r.counters);
      return {
        id: r.id, trigger: r.trigger, status: r.status, step: r.step, pagesRead: c.pagesRead, pagesUnread: c.pagesUnread, tokensUsed: c.inputTokens + c.outputTokens,
        inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens, calls: c.calls, usage: sortUsage(readUsage(r.usage)), caps: capLines(readCaps(r.caps)), pacing: pacingView(r.pacing), recorded: readUsage(r.usage).length > 0 || c.calls === 0, model: r.model,
        budget: c.budget, budgetReached: c.budgetReached > 0, goBackRounds: c.goBackRounds, goBackPages: c.goBackPages,
        queuedAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
      };
    }),
  });
}
