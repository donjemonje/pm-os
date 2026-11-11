import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanText, competitorsGuard, MAX_NOTE, readJson, stateResponse } from "@/lib/competitors/api";
import { isOwnStatus } from "@/lib/competitors/config";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH a matrix cell — any member of the org:
 *   {value, note?, surface?}  set a correction that wins over later scans
 *   {reset: true}             drop the correction, show what the scan found
 * `surface` ("matrix" | "profile") only tags the usage event.
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const cell = await db.capabilityStatus.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!cell) return bad("Not found", 404);
  const from = cell.overrideValue ?? cell.value;
  const surface = body.surface === "profile" ? "profile" : "matrix";

  if (body.reset === true) {
    await db.capabilityStatus.update({
      where: { id },
      data: { overrideValue: null, overrideNote: null, overrideUserId: null, overrideAt: null },
    });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_status_overridden", {
      competitorId: cell.competitorId, capabilityId: cell.capabilityId, from, to: cell.value, hasNote: false, reset: true, surface,
    });
    return stateResponse(ctx);
  }

  // A PM corrects a cell to found or not found; "low confidence" is a value only the analysis sets.
  if (!isOwnStatus(body.value)) return bad(C.errors.pickStatus);
  const note = cleanText(body.note, MAX_NOTE) || null;
  await db.capabilityStatus.update({
    where: { id },
    data: { overrideValue: body.value, overrideNote: note, overrideUserId: ctx.user.id, overrideAt: new Date() },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_status_overridden", {
    competitorId: cell.competitorId, capabilityId: cell.capabilityId, from, to: body.value, hasNote: note != null, reset: false, surface,
  });
  return stateResponse(ctx);
}
