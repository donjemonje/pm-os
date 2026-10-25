import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

type Params = { params: Promise<{ id: string }> };

/** PATCH: rename / describe / reorder a domain. DELETE: remove it with its capabilities. */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const existing = await db.competitorDomain.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true } });
  if (!existing) return bad("Not found", 404);
  const data: { name?: string; description?: string; position?: number } = {};
  let field: string | null = null;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return bad("A name is required.");
    const dup = await db.competitorDomain.findFirst({
      where: { workspaceId: ctx.workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (dup) return bad("A domain with this name already exists.", 409);
    data.name = name;
    field = "name";
  }
  const description = cleanText(body.description, MAX_DESCRIPTION);
  if (description !== undefined) {
    data.description = description;
    field = field ?? "description";
  }
  if (typeof body.position === "number" && Number.isFinite(body.position)) data.position = Math.max(0, Math.round(body.position));
  await db.competitorDomain.update({ where: { id }, data });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: data.name ? "rename" : "update", entityId: id, field });
  return stateResponse(ctx);
}

export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const existing = await db.competitorDomain.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true } });
  if (!existing) return bad("Not found", 404);
  await db.competitorDomain.delete({ where: { id } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "delete", entityId: id, field: null });
  return stateResponse(ctx);
}
