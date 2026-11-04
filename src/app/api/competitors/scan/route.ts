import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { failStaleScans } from "@/lib/competitors/run";
import { createAndRouteScan, manualScansToday } from "@/lib/competitors/scan";
import { getCompetitorsConfig } from "@/lib/competitors/store";
import { rescanLimitEnforced } from "@/lib/competitors/config";
import { isPmosAdmin } from "@/lib/admin-auth";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * POST {competitorId}: Scan now — any member of the org, within the org's
 * manual-rescans-per-site-per-day limit (PM-OS admins are exempt). A site that
 * is already scanning gets the new scan queued behind the running one (PRD:
 * never two scans on one site). Answers at once with the scan id and where it
 * went; the page polls the state until nothing is active.
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const competitorId = typeof body.competitorId === "string" ? body.competitorId : "";
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, sources: { where: { type: "website" }, select: { id: true } } } });
  if (!competitor) return bad("Not found", 404);
  if (rescanLimitEnforced() && !isPmosAdmin(ctx.user) && competitor.sources[0]) {
    const config = await getCompetitorsConfig(ctx.workspaceId);
    const today = await manualScansToday(competitor.sources[0].id);
    if (today >= config.manualRescansPerDay) {
      await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_rescan_limited", { competitorId: competitor.id, limit: config.manualRescansPerDay });
      return bad(C.settings.rescanLimited, 429);
    }
  }
  await failStaleScans();
  try {
    const created = await createAndRouteScan(ctx.workspaceId, competitor.id, "manual", ctx.user.id);
    if ("error" in created) return bad(C.errors.scanFailed, 409);
    return NextResponse.json({ scanId: created.scanId, state: created.state }, { status: 202 });
  } catch (e) {
    console.error("[competitors] scan now failed", e);
    return bad(C.errors.scanFailed, 502);
  }
}

/** GET ?scanId=: the scan's status and counters (polled while running). */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const scanId = new URL(req.url).searchParams.get("scanId") ?? "";
  const scan = await db.competitorScan.findFirst({
    where: { id: scanId, workspaceId: ctx.workspaceId },
    select: { id: true, status: true, pagesFetched: true, pagesChanged: true, pagesNotAttempted: true, startedAt: true, finishedAt: true, error: true, errorKind: true },
  });
  if (!scan) return bad("Not found", 404);
  return NextResponse.json({ scan });
}
