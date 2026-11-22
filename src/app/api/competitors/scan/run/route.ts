import { NextResponse } from "next/server";
import { bad, competitorsGuard, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { launchRun } from "@/lib/competitors/run";
import { startRun } from "@/lib/competitors/runs";

/**
 * POST — the Scan button on the Competitors page: one run over every
 * competitor (in matrix order). A run sends no email of its own; what a
 * competitor's pages newly show is reported by the news notification, per
 * scan (news/after-scan.ts). Any member may press it, as often as they like (no daily
 * limit, Daniel 2026-11-12). Answers at once; the page polls the
 * state until the run finishes.
 */
export async function POST() {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const started = await startRun(ctx.workspaceId, ctx.user.id, { trigger: "manual" });
  if ("error" in started) return bad(started.error === "running" ? C.run.alreadyRunning : C.run.nothingToScan, started.error === "running" ? 409 : 400);
  try {
    await launchRun(started.runId);
  } catch {
    return bad(C.run.failedToStart, 502);
  }
  return stateResponse(ctx, 202);
}
