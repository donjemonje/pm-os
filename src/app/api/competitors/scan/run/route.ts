import { NextResponse } from "next/server";
import { bad, competitorsGuard, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { launchRun } from "@/lib/competitors/run";
import { startRun } from "@/lib/competitors/runs";
import { isPmosAdmin } from "@/lib/admin-auth";

/**
 * POST — the Scan button on the Competitors page: one run over every
 * competitor (in matrix order), then one notification email about what the
 * run changed. Any member may press it; the per-site daily limit still applies
 * per competitor (PM-OS admins exempt). Answers at once; the page polls the
 * state until the run finishes.
 */
export async function POST() {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const started = await startRun(ctx.workspaceId, ctx.user.id, { trigger: "manual", exemptFromLimit: isPmosAdmin(ctx.user) });
  if ("error" in started) return bad(started.error === "running" ? C.run.alreadyRunning : C.run.nothingToScan, started.error === "running" ? 409 : 400);
  try {
    await launchRun(started.runId);
  } catch {
    return bad(C.run.failedToStart, 502);
  }
  return stateResponse(ctx, 202);
}
