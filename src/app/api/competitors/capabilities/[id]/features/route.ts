import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { bad, catalogLocked, cleanName, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { reevaluateAfter } from "@/lib/competitors/reevaluate-api";

type Params = { params: Promise<{ id: string }> };

/**
 * POST {name} — a PM adds a feature row under a capability (any member of the organization). The new row starts
 * "not found" for every company. A feature of that name that was removed comes back instead (with its marks).
 * In the coverage model the capability's row is re-evaluated: the score must agree with the features.
 */
export async function POST(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const locked = await catalogLocked(ctx);
  if (locked) return locked;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (!name) return bad(C.errors.featureName);
  const cap = await db.capability.findFirst({ where: { id, workspaceId: ctx.workspaceId, state: { not: "removed" } }, select: { id: true } });
  if (!cap) return bad("Not found", 404);
  const same = (await db.feature.findMany({ where: { capabilityId: id }, select: { id: true, name: true, state: true } })).find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (same?.state === "active") return bad(C.errors.featureExists, 409);
  if (same) {
    await db.feature.update({ where: { id: same.id }, data: { state: "active", removedAt: null, removedById: null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_feature_row_restored", { capabilityId: id, featureId: same.id, via: "add" });
  } else {
    const last = await db.feature.aggregate({ where: { capabilityId: id }, _max: { position: true } });
    const made = await db.feature.create({ data: { workspaceId: ctx.workspaceId, capabilityId: id, name, origin: "manual", state: "active", ourStatus: "not_found", position: (last._max.position ?? -1) + 1 } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_feature_row_added", { capabilityId: id, featureId: made.id });
  }
  await reevaluateAfter(ctx, id, body);
  return stateResponse(ctx);
}
