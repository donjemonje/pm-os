import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { STALE_HEARTBEAT_MS, type BatchTrace } from "@/lib/ideas/trace";

/**
 * Import run history for one organization — the batch rows with their
 * traces, newest first. Read-only; the trace is written by the import
 * itself (src/lib/ideas/trace.ts). A batch still "running" whose heartbeat
 * is older than the stale window is reported as "stale" so the page never
 * shows a dead run as alive.
 */

const MAX_RUNS = 50;

export interface RunView {
  id: string;
  status: "running" | "completed" | "failed" | "aborted" | "stale";
  startedAt: string;
  completedAt: string | null;
  heartbeatAt: string;
  durationMs: number | null;
  error: string | null;
  stats: Record<string, unknown> | null;
  trace: BatchTrace | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    select: { id: true },
  });
  if (!workspace) {
    return NextResponse.json(
      { error: "Organization has no workspace" },
      { status: 404 },
    );
  }
  const limitRaw = parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_RUNS) : 20;

  const rows = await db.ideaBatch.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  const now = Date.now();
  const runs: RunView[] = rows.map((b) => {
    const running = b.status === "running";
    const stale =
      running && now - b.heartbeatAt.getTime() > STALE_HEARTBEAT_MS;
    const end = b.completedAt ?? (running ? new Date(now) : null);
    return {
      id: b.id,
      status: stale ? "stale" : (b.status as RunView["status"]),
      startedAt: b.startedAt.toISOString(),
      completedAt: b.completedAt?.toISOString() ?? null,
      heartbeatAt: b.heartbeatAt.toISOString(),
      durationMs: end ? end.getTime() - b.startedAt.getTime() : null,
      error: b.error,
      stats: (b.stats as Record<string, unknown> | null) ?? null,
      trace: (b.trace as unknown as BatchTrace | null) ?? null,
    };
  });
  return NextResponse.json({ runs });
}
