import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { capLines, readCaps } from "@/lib/competitors/analysis/caps";
import { CHUNK_SELECT, chunkView, readUnexplained, type ChunkView } from "@/lib/competitors/analysis/chunk-view";
import { readCounters } from "@/lib/competitors/analysis/counters";
import { incidentLine, readIncidents } from "@/lib/competitors/analysis/incidents";
import { loadPages, loadReadingPlan } from "@/lib/competitors/analysis/plan";
import { loadList } from "@/lib/competitors/analysis/read-step";
import { notReadLine, readRunReads, readsLine, splitByReads } from "@/lib/competitors/analysis/reads";
import { pickReadable, READ_AS_RELEASE_NOTES, sectionKey } from "@/lib/competitors/analysis/sections";
import { analysisReads } from "@/lib/competitors/settings";
import { listSize, READ_VERSION, stillUnexplained, type Unexplained } from "@/lib/competitors/analysis/reading";
import { estimateTokens, pacingView, type PacingView } from "@/lib/competitors/analysis/pacing";
import { readUsage, sortUsage, type StepUsage } from "@/lib/competitors/analysis/usage";

/**
 * Administration → Competitors → Reading plan (PM-OS admin only, read-only): one competitor's reading plan — the
 * sections of its site with the label that decides what is read — its reading (the requests that read it in chunks,
 * the size of its list, the labels that were seen but not explained) and its latest analysis runs.
 *
 *   GET ?competitorId=<id> → { competitor: { id, name }, sections: AdminPlanSection[], runs: AdminPlanRun[],
 *                              reading: AdminReading }
 *
 * Nothing here changes the plan: a label is given by the analysis run's map step and kept.
 */

/** Runs returned at most, newest first. */
const MAX_RUNS = 10;
/** Reading requests returned at most, newest first. */
const MAX_CHUNKS = 60;

/** A company's reading: its list today, the requests that made it, and what was seen but not explained. */
export interface AdminReading {
  /** The company's list as it stands: capabilities and the features under them. */
  capabilities: number;
  features: number;
  /** The latest reading requests, newest first (analysis/chunk-view.ts). */
  chunks: ChunkView[];
  /** Bare labels a request reported and no later page explained: seen, not explained. */
  unexplained: Unexplained[];
  /** "What the analysis reads" today, in one line. */
  reads: string;
  /** What that setting leaves out of this company today, per kind that is off — "" when nothing. A setting, not a cap. */
  notRead: string;
}

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
  /** Its kind is on in "What the analysis reads" today. Noise is never read. */
  read: boolean;
  /** Pages inside it the map named release notes (a help-center or a blog section): read as release notes, whatever this section's switch says. */
  releaseNotesPages: number;
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
  /** The part of outputTokens that was the models' own thinking (0 where the provider reported none, and for an older run). */
  thinkingTokens: number;
  calls: number;
  /** The run's tokens per step and model (analysis/usage.ts); [] for a run from before they were split. */
  usage: StepUsage[];
  /** The caps the run hit, one line each (analysis/caps.ts capLine); [] = no cap was hit. */
  caps: string[];
  /** The run's incidents, one line each (analysis/incidents.ts incidentLine) — answers that should never happen; [] = none. */
  incidents: string[];
  /** Every incident of the run, also the ones no longer listed. */
  incidentsTotal: number;
  /** The kinds that were on when the run ran, in one line; null for a run from before the setting existed. */
  reads: string | null;
  /** What the run left out because its kind was off — "" when nothing. */
  notRead: string;
  /** Reading requests the run made (one per chunk of pages), and second-look requests. */
  readRequests: number;
  lookRequests: number;
  /** How the run paced itself and every pushback of the provider (analysis/pacing.ts); null for a run from before it was recorded. */
  pacing: PacingView | null;
  /** False for a run from before caps and tokens per step were recorded: "no cap" is then not known. */
  recorded: boolean;
  /** The models of the run, as it recorded them ("read … · match … · judge …", or one model for an older run). */
  model: string | null;
  /** 0 = a run from before the budget existed. */
  budget: number;
  budgetReached: boolean;
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
  const [sections, runs, chunks, list, pages, plan, setting] = await Promise.all([
    db.competitorSection.findMany({ where: { competitorId }, select: { id: true, sourceId: true, prefix: true, label: true, pages: true, chars: true, labeledBy: true, labeledAt: true, source: { select: { type: true } } } }),
    db.competitorAnalysis.findMany({
      // A setup run is attached to the organization's own site and is not one company's run: it is listed under Setup runs.
      where: { competitorId, kind: "analysis" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: { id: true, trigger: true, status: true, step: true, counters: true, usage: true, caps: true, incidents: true, reads: true, pacing: true, model: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
    }),
    db.competitorChunk.findMany({ where: { competitorId, version: READ_VERSION }, orderBy: [{ createdAt: "desc" }, { position: "desc" }], select: CHUNK_SELECT }),
    loadList(competitorId),
    loadPages(competitorId),
    loadReadingPlan(competitorId),
    analysisReads(),
  ]);
  // What the setting leaves out of this company today, and the release-notes pages the map named inside help-center and blog sections.
  const { notRead } = splitByReads(pickReadable(pages, plan), setting);
  const releaseNotesIn = new Map<string, number>();
  for (const p of pages) {
    if (p.readAs !== READ_AS_RELEASE_NOTES || p.state === "removed") continue;
    const section = plan.sectionOf(p);
    if (section) releaseNotesIn.set(sectionKey(p.sourceId, section.prefix), (releaseNotesIn.get(sectionKey(p.sourceId, section.prefix)) ?? 0) + 1);
  }
  const reading: AdminReading = { ...listSize(list), chunks: chunks.slice(0, MAX_CHUNKS).map(chunkView), unexplained: stillUnexplained([...chunks].reverse().flatMap((c) => readUnexplained(c.unexplained)), list), reads: readsLine(setting), notRead: notReadLine(notRead) };
  // Sections that hold pages first, by address; a section whose folder is gone (0 pages, the label is kept) last.
  sections.sort((a, b) => Number(a.pages === 0) - Number(b.pages === 0) || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  return NextResponse.json({
    competitor: { id: competitor.id, name: competitor.name },
    reading,
    sections: sections.map((s): AdminPlanSection => ({
      id: s.id, prefix: s.prefix, sourceType: s.source.type, label: s.label, pages: s.pages, tokens: estimateTokens(s.chars), labeledBy: s.labeledBy, labeledAt: s.labeledAt.toISOString(),
      read: s.label !== "noise" && Boolean((setting as Record<string, boolean>)[s.label]), releaseNotesPages: releaseNotesIn.get(sectionKey(s.sourceId, s.prefix)) ?? 0,
    })),
    runs: runs.map((r): AdminPlanRun => {
      const c = readCounters(r.counters);
      const cases = readIncidents(r.incidents);
      const ran = readRunReads(r.reads);
      return {
        reads: ran ? readsLine(ran.kinds) : null, notRead: ran ? notReadLine(ran.notRead) : "",
        id: r.id, trigger: r.trigger, status: r.status, step: r.step, pagesRead: c.pagesRead, pagesUnread: c.pagesUnread, tokensUsed: c.inputTokens + c.outputTokens,
        inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens, thinkingTokens: c.thinkingTokens, calls: c.calls, usage: sortUsage(readUsage(r.usage)), caps: capLines(readCaps(r.caps)), incidents: cases.list.map(incidentLine), incidentsTotal: cases.total, readRequests: c.readRequests, lookRequests: c.lookRequests, pacing: pacingView(r.pacing), recorded: readUsage(r.usage).length > 0 || c.calls === 0, model: r.model,
        budget: c.budget, budgetReached: c.budgetReached > 0,
        queuedAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
      };
    }),
  });
}
