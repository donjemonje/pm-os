import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { MAX_DOMAIN_DESCRIPTION } from "@/lib/competitors/config";
import { isChipColorId } from "@/lib/ideas/colors";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { getCompetitorsState } from "@/lib/competitors/store";
import { mentionsName, renameMentions } from "@/lib/competitors/mentions";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH: rename, describe (the PMOS AI definition text) or recolor a domain.
 * A rename cascades: every other domain's and every capability's description
 * that mentions the old name is rewritten with the new one (the texts
 * cross-reference domains by name); the answer carries `renamedReferences`.
 * DELETE: remove it with its capabilities.
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const existing = await db.competitorDomain.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, name: true } });
  if (!existing) return bad("Not found", 404);
  const data: { name?: string; description?: string; color?: string } = {};
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
  const description = cleanText(body.description, MAX_DOMAIN_DESCRIPTION);
  if (description !== undefined) {
    data.description = description;
    field = field ?? "description";
  }
  if (body.color !== undefined) {
    if (!isChipColorId(body.color)) return bad("Unknown color.");
    data.color = body.color;
    field = field ?? "color";
  }
  let renamedReferences = 0;
  if (data.name && data.name !== existing.name) {
    const oldName = existing.name;
    const newName = data.name;
    const [domains, capabilities] = await Promise.all([
      db.competitorDomain.findMany({ where: { workspaceId: ctx.workspaceId, id: { not: id } }, select: { id: true, description: true } }),
      db.capability.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, description: true } }),
    ]);
    const domainWrites = domains.filter((d) => mentionsName(d.description, oldName));
    const capabilityWrites = capabilities.filter((k) => mentionsName(k.description, oldName));
    renamedReferences = domainWrites.length + capabilityWrites.length;
    await db.$transaction([
      db.competitorDomain.update({ where: { id }, data }),
      ...domainWrites.map((d) => db.competitorDomain.update({ where: { id: d.id }, data: { description: renameMentions(d.description, oldName, newName) } })),
      ...capabilityWrites.map((k) => db.capability.update({ where: { id: k.id }, data: { description: renameMentions(k.description, oldName, newName) } })),
    ]);
  } else {
    await db.competitorDomain.update({ where: { id }, data });
  }
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: data.name && data.name !== existing.name ? "rename" : "update", entityId: id, field, renamedReferences });
  const state = await getCompetitorsState(ctx.workspaceId, ctx.orgName);
  return NextResponse.json({ state, renamedReferences });
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
