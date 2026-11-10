import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { MAX_DOMAIN_DESCRIPTION, MAX_DOMAIN_SUMMARY } from "@/lib/competitors/config";
import { nextChipColor } from "@/lib/ideas/colors";
import { nextPosition } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { aliasesWithout, aliasList, nameKey } from "@/lib/competitors/decisions";

/** A name a PM gives by hand wins over an alias: every other domain that kept it as a replaced name lets it go. */
export async function releaseDomainAlias(workspaceId: string, name: string, exceptId: string | null): Promise<void> {
  const rows = await db.competitorDomain.findMany({ where: { workspaceId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, aliases: true } });
  for (const r of rows) {
    if (!aliasList(r.aliases).some((a) => nameKey(a) === nameKey(name))) continue;
    await db.competitorDomain.update({ where: { id: r.id }, data: { aliases: aliasesWithout(r.aliases, name) } });
  }
}

/**
 * POST {name, description?, summary?}: add a domain; it gets the least-used palette color.
 * A name the team removed (or dismissed as a suggestion) brings that domain back, empty, and clears the recorded decision.
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (!name) return bad("A name is required.");
  const dup = await db.competitorDomain.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true, state: true },
  });
  if (dup && (dup.state === "active" || dup.state === "suggested")) return bad("A domain with this name already exists.", 409);
  await releaseDomainAlias(ctx.workspaceId, name, dup?.id ?? null);
  if (dup) {
    const description = cleanText(body.description, MAX_DOMAIN_DESCRIPTION);
    const summary = cleanText(body.summary, MAX_DOMAIN_SUMMARY);
    await db.competitorDomain.update({
      where: { id: dup.id },
      data: {
        name,
        state: "active",
        removedAt: null,
        removedById: null,
        ...(dup.state === "dismissed" ? { origin: "manual", suggestedById: null } : {}),
        position: await nextPosition("competitorDomain", ctx.workspaceId),
        ...(description !== undefined ? { description } : {}),
        ...(summary !== undefined ? { summary } : {}),
      },
    });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "restore", entityId: dup.id, field: "state", from: dup.state, to: "active", name, via: "add" });
    return stateResponse(ctx, 201);
  }
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
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "create", entityId: domain.id, field: null, from: null, to: name, name });
  return stateResponse(ctx, 201);
}

/** PUT {order: [ids]}: the manual order of the active domains (matrix groups and filters follow it). Suggested, dismissed and removed domains have no place in the order. */
export async function PUT(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === "string") : [];
  const rows = await db.competitorDomain.findMany({ where: { workspaceId: ctx.workspaceId, state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true } });
  const known = new Set(rows.map((r) => r.id));
  if (order.length !== rows.length || new Set(order).size !== rows.length || !order.every((id) => known.has(id))) {
    return bad("The order must list every domain exactly once.");
  }
  await db.$transaction(order.map((id, index) => db.competitorDomain.update({ where: { id }, data: { position: index } })));
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "reorder", entityId: null, field: "position", from: rows.map((r) => r.id).join(","), to: order.join(",") });
  return stateResponse(ctx);
}
