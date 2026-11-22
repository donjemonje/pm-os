import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { bad, catalogLocked, cleanName, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { reevaluateAfter } from "@/lib/competitors/reevaluate-api";
import { isOwnStatus } from "@/lib/competitors/config";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH a feature — any member of the org, one action per request:
 *   {ourStatus}          the org's own mark on the feature row: found | not_found
 *   {name}               rename the row (the earlier name is kept as an alias, so an analysis recognises the row)
 *   {state: "removed"}   remove the row (kept, with its marks, so an analysis never adds it back and it can be restored)
 *   {state: "active"}    restore a removed row
 * In the coverage model every one of these re-evaluates the capability's row: the score must agree with the features.
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const feature = await db.feature.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, name: true, capabilityId: true, ourStatus: true, state: true, aliases: true } });
  if (!feature) return bad("Not found", 404);

  if (body.state === "removed" || body.state === "active") {
    if (body.state === feature.state) return stateResponse(ctx);
    const locked = await catalogLocked(ctx);
    if (locked) return locked;
    if (body.state === "removed") await db.feature.update({ where: { id }, data: { state: "removed", removedAt: new Date(), removedById: ctx.user.id } });
    else await db.feature.update({ where: { id }, data: { state: "active", removedAt: null, removedById: null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, body.state === "removed" ? "cmp_feature_row_removed" : "cmp_feature_row_restored", { capabilityId: feature.capabilityId, featureId: id, ...(body.state === "active" ? { via: "restore" } : {}) });
    await reevaluateAfter(ctx, feature.capabilityId, body);
    return stateResponse(ctx);
  }
  if (feature.state !== "active") return bad("Not found", 404);
  if (body.name !== undefined) {
    const locked = await catalogLocked(ctx);
    if (locked) return locked;
    const name = cleanName(body.name);
    if (!name) return bad(C.errors.featureName);
    if (name === feature.name) return stateResponse(ctx);
    const others = await db.feature.findMany({ where: { capabilityId: feature.capabilityId, NOT: { id } }, select: { name: true } });
    if (others.some((f) => f.name.toLowerCase() === name.toLowerCase())) return bad(C.errors.featureExists, 409);
    const aliases = Array.isArray(feature.aliases) ? feature.aliases.filter((x): x is string => typeof x === "string") : [];
    await db.feature.update({ where: { id }, data: { name, aliases: [...new Set([...aliases, feature.name])].filter((x) => x.toLowerCase() !== name.toLowerCase()) } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_feature_row_changed", { capabilityId: feature.capabilityId, featureId: id, field: "name" });
    await reevaluateAfter(ctx, feature.capabilityId, body);
    return stateResponse(ctx);
  }
  if (!isOwnStatus(body.ourStatus)) return bad(C.errors.pickOwnStatus);
  // Set by hand: the PM's value is the truth — no run of the organization's own site changes it again (lib/competitors/own.ts).
  await db.feature.update({ where: { id }, data: { ourStatus: body.ourStatus, ourStatusSetAt: new Date(), ourStatusSetById: ctx.user.id } });
  if (body.ourStatus !== feature.ourStatus) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "feature", entityId: id, action: "ourStatus", field: "ourStatus", from: feature.ourStatus, to: body.ourStatus, name: feature.name });
    await reevaluateAfter(ctx, feature.capabilityId, body);
  }
  return stateResponse(ctx);
}
