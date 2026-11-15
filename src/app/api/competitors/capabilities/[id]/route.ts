import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { isOwnStatus, MAX_OWN_PRODUCT, splitSuggestedQuote } from "@/lib/competitors/config";
import { cleanProductLines } from "../route";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH: rename, describe, set the org's own product, move to another domain, set product lines, set the
 * org's own status (`ourStatus`: has / partial / missing — any member), or
 * decide a suggestion (`state`: "active" = accept, "dismissed" = dismiss).
 * DELETE: remove the row and every status on it.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  // The own status alone is a PM's call, like correcting a competitor's cell; everything else is admin.
  const onlyOwnStatus = Object.keys(body).every((k) => k === "ourStatus");
  const ctx = await competitorsGuard({ admin: !onlyOwnStatus });
  if (ctx instanceof NextResponse) return ctx;
  const existing = await db.capability.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!existing) return bad("Not found", 404);

  const data: Prisma.CapabilityUncheckedUpdateInput = {};
  let action = "update";
  let field: string | null = null;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return bad("A name is required.");
    const dup = await db.capability.findFirst({
      where: { workspaceId: ctx.workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (dup) return bad("A capability with this name already exists.", 409);
    data.name = name;
    action = "rename";
    field = "name";
  }
  const description = cleanText(body.description, MAX_DESCRIPTION);
  if (description !== undefined) {
    data.description = description;
    field = field ?? "description";
  }
  const ownProduct = cleanText(body.ownProduct, MAX_OWN_PRODUCT);
  if (ownProduct !== undefined) {
    data.ownProduct = ownProduct;
    field = field ?? "ownProduct";
  }
  if (body.domainId !== undefined) {
    const domain = typeof body.domainId === "string"
      ? await db.competitorDomain.findFirst({ where: { id: body.domainId, workspaceId: ctx.workspaceId }, select: { id: true } })
      : null;
    if (!domain) return bad("Pick a domain.");
    if (domain.id !== existing.domainId) {
      data.domainId = domain.id;
      action = "move";
      field = "domain";
    }
  }
  if (body.productLines !== undefined) {
    const lines = await cleanProductLines(ctx.workspaceId, body.productLines);
    data.productLines = lines as unknown as Prisma.InputJsonValue;
    const before = Array.isArray(existing.productLines) ? (existing.productLines as string[]) : [];
    action = lines.length > before.length ? "attachProductLine" : lines.length < before.length ? "detachProductLine" : action;
    field = "productLines";
  }
  if (typeof body.position === "number" && Number.isFinite(body.position)) data.position = Math.max(0, Math.round(body.position));
  if (body.ourStatus !== undefined) {
    if (!isOwnStatus(body.ourStatus)) return bad("Pick has, partial or missing.");
    data.ourStatus = body.ourStatus;
    action = "ourStatus";
    field = "ourStatus";
  }

  let decision: "accepted" | "dismissed" | null = null;
  if (body.state === "active" || body.state === "dismissed") {
    if (existing.state === "suggested") {
      decision = body.state === "active" ? "accepted" : "dismissed";
      data.state = body.state;
      if (body.state === "active") {
        data.position = await nextActivePosition(ctx.workspaceId);
        // Accepting a capability inside a suggested domain accepts the domain with it.
        const domain = await db.competitorDomain.findUnique({ where: { id: (data.domainId as string | undefined) ?? existing.domainId }, select: { id: true, state: true } });
        if (domain?.state === "suggested") {
          const agg = await db.competitorDomain.aggregate({ where: { workspaceId: ctx.workspaceId, state: "active" }, _max: { position: true } });
          await db.competitorDomain.update({ where: { id: domain.id }, data: { state: "active", position: (agg._max.position ?? -1) + 1 } });
          await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_domain_suggestion", { domainId: domain.id, competitorId: existing.suggestedById, decision: "accepted", via: "capability" });
        }
      }
    } else if (body.state === "active" && existing.state === "dismissed") {
      data.state = "active";
      decision = "accepted";
    }
  }

  await db.capability.update({ where: { id }, data });
  if (decision === "accepted" && existing.suggestedById) {
    // The competitor whose scan proposed the row has it: write that cell from the
    // suggestion's evidence, unless a later scan already classified it.
    const { quote, url } = splitSuggestedQuote(existing.suggestedQuote);
    const current = await db.capabilityStatus.findUnique({ where: { competitorId_capabilityId: { competitorId: existing.suggestedById, capabilityId: id } }, select: { id: true, value: true } });
    const evidence = { value: "has", quote: quote || null, sourceUrl: url, confidence: null, scanId: null, changedAt: null };
    if (!current) {
      await db.capabilityStatus.create({ data: { workspaceId: ctx.workspaceId, competitorId: existing.suggestedById, capabilityId: id, ...evidence } });
    } else if (current.value === "unknown") {
      await db.capabilityStatus.update({ where: { id: current.id }, data: evidence });
    }
  }
  if (decision) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_suggestion", {
      capabilityId: id,
      competitorId: existing.suggestedById,
      decision,
      domainChanged: data.domainId !== undefined,
    });
  } else {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action, entityId: id, field });
  }
  return stateResponse(ctx);
}

async function nextActivePosition(workspaceId: string): Promise<number> {
  const agg = await db.capability.aggregate({ where: { workspaceId, state: "active" }, _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}

export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const existing = await db.capability.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true } });
  if (!existing) return bad("Not found", 404);
  await db.capability.delete({ where: { id } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "delete", entityId: id, field: null });
  return stateResponse(ctx);
}
