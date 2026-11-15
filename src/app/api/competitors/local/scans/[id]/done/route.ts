import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startLocalScan, verifyScanToken } from "@/lib/competitors/local";
import { launchScan } from "@/lib/competitors/run";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — the station finished reading (scan token as bearer). Body:
 *   { notAttempted?: number }   pages the station discovered but did not read (time or storage limit, slow-down)
 * Answers "received" at once in every environment and hands the process half (page states, hash compare, badge —
 * then the PMOS AI step of the next story) to the runner: a Cloud Run job in production, a background task in
 * this Node process in local dev (lib/competitors/run.ts). The station never waits for processing; the result
 * shows in Settings → Competitors. A scan with no page handed in ends "failed".
 *
 * The request is "handed_in" from here on: should processing die (runner crash, dev server restart, a launch that
 * throws), the hourly stale sweep processes it again — it never sends the station back to re-read the site.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const tok = await verifyScanToken(req.headers.get("authorization"), id);
  if (!tok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const scan = await db.competitorScan.findUnique({ where: { id }, select: { status: true } });
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scan.status === "cancelled") return NextResponse.json({ error: "The scan was cancelled" }, { status: 410 });
  if (scan.status !== "running" && scan.status !== "pending_local" && scan.status !== "queued") {
    const done = await db.competitorScan.findUnique({ where: { id }, select: { status: true, badge: true, pagesFetched: true, pagesChanged: true } });
    return NextResponse.json({ scan: done }, { status: 200 });
  }
  if (scan.status !== "running") await startLocalScan(id, null);
  const notAttempted = typeof body.notAttempted === "number" && Number.isFinite(body.notAttempted) ? Math.max(0, Math.round(body.notAttempted)) : 0;
  await db.competitorScan.update({ where: { id }, data: { pagesNotAttempted: notAttempted, heartbeatAt: new Date() } });
  await db.localScanRequest.updateMany({ where: { scanId: id, state: "running" }, data: { state: "handed_in" } });
  try {
    await launchScan(id);
  } catch (e) {
    // The pages are in; the launch is what failed (a job trigger without rights, say). Answer "received" all the same —
    // the stale sweep relaunches processing in 10 minutes, and the server log says why it did not start now.
    console.error(`[competitors] scan ${id}: processing did not start after the hand-in`, e);
  }
  const result = await db.competitorScan.findUnique({ where: { id }, select: { status: true, badge: true, pagesFetched: true, pagesChanged: true, pagesNotAttempted: true, error: true } });
  return NextResponse.json({ scan: result, processing: true });
}
