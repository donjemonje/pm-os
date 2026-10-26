import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** GET ?competitorId=: the scan log — every run of the competitor's website source, newest first. */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const competitorId = new URL(req.url).searchParams.get("competitorId") ?? "";
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: ctx.workspaceId }, select: { id: true, name: true } });
  if (!competitor) return bad("Not found", 404);
  const scans = await db.competitorScan.findMany({
    where: { workspaceId: ctx.workspaceId, source: { competitorId } },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  const latest = scans[0];
  if (latest) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_scan_log_viewed", { competitorId, scanId: latest.id, scanStatus: latest.status });
  }
  return NextResponse.json({
    competitor,
    scans: scans.map((s) => ({
      id: s.id,
      trigger: s.trigger,
      status: s.status,
      fetchMode: s.fetchMode,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      pagesFetched: s.pagesFetched,
      pagesChanged: s.pagesChanged,
      statusesChanged: s.statusesChanged,
      factsChanged: s.factsChanged,
      suggestions: s.suggestions,
      aiCalls: s.aiCalls,
      errorKind: s.errorKind,
      error: s.error,
      badge: s.badge,
      outcomes: s.outcomes,
      robotsDisallowed: s.robotsDisallowed,
      removedPages: s.removedPages,
      piiHits: s.piiHits,
      pages: s.pages,
      log: s.log,
    })),
  });
}
