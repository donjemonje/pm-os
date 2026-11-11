import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { isOwnStatus } from "@/lib/competitors/config";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH a feature — any member of the org:
 *   {ourStatus}  the org's own mark on the feature row: found | not_found
 * The own mark is a PM's call, like correcting a competitor's cell. Renaming, removing or moving a feature is not
 * in this build (the table carries the fields for it).
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const feature = await db.feature.findFirst({ where: { id, workspaceId: ctx.workspaceId, state: "active" }, select: { id: true, name: true, capabilityId: true, ourStatus: true } });
  if (!feature) return bad("Not found", 404);
  if (!isOwnStatus(body.ourStatus)) return bad(C.errors.pickOwnStatus);
  if (body.ourStatus !== feature.ourStatus) {
    await db.feature.update({ where: { id }, data: { ourStatus: body.ourStatus } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "feature", entityId: id, action: "ourStatus", field: "ourStatus", from: feature.ourStatus, to: body.ourStatus, name: feature.name, capabilityId: feature.capabilityId });
  }
  return stateResponse(ctx);
}
