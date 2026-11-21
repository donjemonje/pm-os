import { NextResponse } from "next/server";
import { bad, competitorsGuard, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { ownSourceOf } from "@/lib/competitors/own-site";
import { failStaleScans } from "@/lib/competitors/run";
import { createAndRouteScan } from "@/lib/competitors/scan";

/**
 * POST: Scan now for the organization's own website (Settings → Competitors → "Your company") — any member, as
 * often as they like, like a competitor's Scan now. A site that is already scanning gets the new scan queued
 * behind the running one. Answers with the whole state; the page polls until nothing is active.
 */
export async function POST() {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const own = await ownSourceOf(ctx.workspaceId);
  if (!own) return bad(C.settings.own.noSite, 404);
  await failStaleScans();
  try {
    const created = await createAndRouteScan(ctx.workspaceId, own.id, "manual", ctx.user.id);
    if ("error" in created) return bad(C.errors.scanFailed, 409);
  } catch (e) {
    console.error("[competitors] scan now of the own site failed", e);
    return bad(C.errors.scanFailed, 502);
  }
  return stateResponse(ctx, 202);
}
