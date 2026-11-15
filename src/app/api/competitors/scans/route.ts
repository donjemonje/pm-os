import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * GET ?competitorId=: the customer-facing scan log — every scan of the
 * competitor's website source, newest first. Customers see what was read and
 * what was not, never HOW a scan ran: no lane, no fetch mode, no runner log
 * lines (those live in Administration → Competitors).
 */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const competitorId = new URL(req.url).searchParams.get("competitorId") ?? "";
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, name: true } });
  if (!competitor) return bad("Not found", 404);
  const scans = await db.competitorScan.findMany({
    where: { workspaceId: ctx.workspaceId, source: { competitorId }, status: { not: "cancelled" } },
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
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      pagesFetched: s.pagesFetched,
      pagesChanged: s.pagesChanged,
      pagesNotAttempted: s.pagesNotAttempted,
      statusesChanged: s.statusesChanged,
      factsChanged: s.factsChanged,
      suggestions: s.suggestions,
      errorKind: s.errorKind,
      error: s.error,
      badge: s.badge,
      outcomes: s.outcomes,
      robotsDisallowed: s.robotsDisallowed,
      removedPages: s.removedPages,
      // How a page was reached (home / sitemap / link / handed in) is the engine's business, not the customer's.
      pages: Array.isArray(s.pages) ? (s.pages as Record<string, unknown>[]).map(({ via: _via, ...p }) => p) : s.pages,
    })),
  });
}
