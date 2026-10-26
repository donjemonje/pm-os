import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { launchScan } from "@/lib/competitors/run";
import { createScan, manualScansToday } from "@/lib/competitors/scan";
import { getCompetitorsConfig } from "@/lib/competitors/store";
import { rescanLimitEnforced } from "@/lib/competitors/config";
import { isPmosAdmin } from "@/lib/admin-auth";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * POST {competitorId}: Scan now — any member of the org, within the org's
 * manual-rescans-per-site-per-day limit (PM-OS admins are exempt). Answers at
 * once with the scan id; the page polls GET ?scanId= until status leaves
 * queued/running and then reloads the state in one go.
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const competitorId = typeof body.competitorId === "string" ? body.competitorId : "";
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: ctx.workspaceId }, select: { id: true, sources: { where: { type: "website" }, select: { id: true } } } });
  if (!competitor) return bad("Not found", 404);
  if (rescanLimitEnforced() && !isPmosAdmin(ctx.user) && competitor.sources[0]) {
    const config = await getCompetitorsConfig(ctx.workspaceId);
    const today = await manualScansToday(competitor.sources[0].id);
    if (today >= config.manualRescansPerDay) {
      await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_rescan_limited", { competitorId: competitor.id, limit: config.manualRescansPerDay });
      return bad(C.settings.rescanLimited, 429);
    }
  }
  const created = await createScan(ctx.workspaceId, competitor.id, "manual", ctx.user.id);
  if ("error" in created) {
    return bad(created.error === "running" ? C.settings.scanRunning : C.errors.scanFailed, 409);
  }
  try {
    await launchScan(created.scanId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.competitorScan.update({ where: { id: created.scanId }, data: { status: "failed", finishedAt: new Date(), errorKind: "other", error: message.slice(0, 300) } });
    await db.competitorSource.updateMany({ where: { competitor: { id: competitor.id }, type: "website" }, data: { lastStatus: "failed", lastError: message.slice(0, 300) } });
    return bad(C.errors.scanFailed, 502);
  }
  return NextResponse.json({ scanId: created.scanId }, { status: 202 });
}

/** GET ?scanId=: the scan's status and counters (polled while running). */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const scanId = new URL(req.url).searchParams.get("scanId") ?? "";
  const scan = await db.competitorScan.findFirst({
    where: { id: scanId, workspaceId: ctx.workspaceId },
    select: { id: true, status: true, pagesFetched: true, pagesChanged: true, startedAt: true, finishedAt: true, error: true, errorKind: true },
  });
  if (!scan) return bad("Not found", 404);
  return NextResponse.json({ scan });
}
