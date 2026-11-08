import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startLocalScan, verifyScanToken } from "@/lib/competitors/local";
import { launchScan, runnerMode } from "@/lib/competitors/run";
import { runScan } from "@/lib/competitors/scan";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — the station finished reading (scan token as bearer). Body:
 *   { notAttempted?: number }   pages the station discovered but did not read (ceiling)
 * The process half (page states, PMOS AI, badge) runs in the scanner job in
 * production (cloudrun mode: a 2,000-page site takes minutes, longer than one
 * HTTP request may live) and inline in local dev, where the answer carries the
 * result. A scan with no page handed in ends "failed".
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
  if (runnerMode() === "cloudrun") {
    await launchScan(id);
    const result = await db.competitorScan.findUnique({ where: { id }, select: { status: true, badge: true, pagesFetched: true, pagesChanged: true, pagesNotAttempted: true, error: true } });
    return NextResponse.json({ scan: result, processing: true });
  }
  await runScan(id);
  const result = await db.competitorScan.findUnique({ where: { id }, select: { status: true, badge: true, pagesFetched: true, pagesChanged: true, pagesNotAttempted: true, error: true } });
  return NextResponse.json({ scan: result });
}
