import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { queueAnalysis } from "@/lib/competitors/analysis/engine";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * PM-OS Admin: queue an analysis of one competitor's stored pages now (Capability Analysis, "How the analysis
 * runs"). A failed run is not retried by itself — the competitor's next scan queues a new one; this is the way to
 * queue one at once. The run reads only what is left: pages whose text it has not read yet.
 *
 *   POST { competitorId } → { analysisId, created } | { skipped: "ai_off" }
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const competitorId = typeof body?.competitorId === "string" ? body.competitorId : "";
  const competitor = competitorId ? await db.competitor.findUnique({ where: { id: competitorId }, select: { id: true, workspaceId: true, deletedAt: true } }) : null;
  if (!competitor || competitor.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await recordCompetitorEvent(competitor.workspaceId, admin.id, "cmp_analysis_requested", { competitorId: competitor.id, via: "admin" });
  const q = await queueAnalysis(competitor.workspaceId, competitor.id, "manual", { startedById: admin.id });
  if ("skipped" in q) return NextResponse.json({ skipped: q.skipped });
  return NextResponse.json({ analysisId: q.id, created: q.created });
}
