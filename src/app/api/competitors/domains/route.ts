import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { MAX_DOMAIN_DESCRIPTION, MAX_DOMAIN_SUMMARY } from "@/lib/competitors/config";
import { nextChipColor } from "@/lib/ideas/colors";
import { nextPosition } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** POST {name, description?, summary?}: add a domain; it gets the least-used palette color. */
export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (!name) return bad("A name is required.");
  const dup = await db.competitorDomain.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (dup) return bad("A domain with this name already exists.", 409);
  const used = (await db.competitorDomain.findMany({ where: { workspaceId: ctx.workspaceId }, select: { color: true } })).map((d) => d.color);
  const domain = await db.competitorDomain.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      description: cleanText(body.description, MAX_DOMAIN_DESCRIPTION) ?? "",
      summary: cleanText(body.summary, MAX_DOMAIN_SUMMARY) ?? "",
      color: nextChipColor(used),
      position: await nextPosition("competitorDomain", ctx.workspaceId),
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "create", entityId: domain.id, field: null });
  return stateResponse(ctx, 201);
}

/** PUT {order: [ids]}: the manual order of the active domains (matrix groups and filters follow it). Suggested, dismissed and removed domains have no place in the order. */
export async function PUT(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === "string") : [];
  const rows = await db.competitorDomain.findMany({ where: { workspaceId: ctx.workspaceId, state: "active" }, select: { id: true } });
  const known = new Set(rows.map((r) => r.id));
  if (order.length !== rows.length || new Set(order).size !== rows.length || !order.every((id) => known.has(id))) {
    return bad("The order must list every domain exactly once.");
  }
  await db.$transaction(order.map((id, index) => db.competitorDomain.update({ where: { id }, data: { position: index } })));
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "reorder", entityId: null, field: "position" });
  return stateResponse(ctx);
}
