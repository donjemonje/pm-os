import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { isOwnStatus, MAX_OWN_PRODUCT, splitSuggestedQuote } from "@/lib/competitors/config";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { aliasesAfterRename } from "@/lib/competitors/decisions";
import { cleanProductLines, releaseCapabilityAlias } from "../route";

type EventProps = Record<string, string | number | boolean | null>;

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH: rename, describe, set the org's own product, move to another domain, set product lines, set the
 * org's own status (`ourStatus`: has / partial / missing — any member), or
 * decide a suggestion (`state`: "active" = accept, "dismissed" = dismiss), or restore a removed row
 * (`state`: "active", with an active `domainId` when its own domain is not in the table).
 * DELETE: the PM removes the row. It is not erased: it leaves the table, its statuses are kept,
 * scans never add it back, and it can be restored (Capability Analysis PRD, "PM and PMOS AI").
 *
 * A rename keeps the replaced name behind the row (aliases), so a scan that meets the old name
 * recognises the row. Every change records who, what, the value before and the value after.
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

  if (existing.state === "removed") {
    // The only thing a removed row accepts is its restore.
    if (body.state !== "active") return bad(C.settings.restoreFirst);
    const targetId = typeof body.domainId === "string" ? body.domainId : existing.domainId;
    const target = await db.competitorDomain.findFirst({ where: { id: targetId, workspaceId: ctx.workspaceId, state: "active" }, select: { id: true } });
    if (!target) return bad(C.settings.activeDomainRequired);
    await db.capability.update({ where: { id }, data: { state: "active", removedAt: null, removedById: null, domainId: target.id, position: await nextActivePosition(ctx.workspaceId) } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "restore", entityId: id, field: "state", from: "removed", to: "active", name: existing.name, via: "settings", fromDomainId: existing.domainId, toDomainId: target.id, domainChanged: target.id !== existing.domainId });
    return stateResponse(ctx);
  }

  const data: Prisma.CapabilityUncheckedUpdateInput = {};
  /** One event per changed field, each with its own before and after. */
  const events: EventProps[] = [];
  let field: string | null = null;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return bad("A name is required.");
    const dup = await db.capability.findFirst({
      where: { workspaceId: ctx.workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true, state: true },
    });
    if (dup && dup.state !== "dismissed") return bad(dup.state === "removed" ? C.settings.nameRemovedCapability : "A capability with this name already exists.", 409);
    // A suggestion the team declined holds no name against the PM: his name wins and the declined row goes (the name stays known through this row).
    if (dup) await db.capability.delete({ where: { id: dup.id } });
    if (name !== existing.name) {
      data.name = name;
      data.aliases = aliasesAfterRename(existing.aliases, existing.name, name) as unknown as Prisma.InputJsonValue;
      events.push({ action: "rename", field: "name", from: existing.name, to: name });
    }
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
    // A row in the table moves between domains that are in the table; a suggestion may also sit in a suggested domain.
    const domainStates = existing.state === "suggested" ? ["active", "suggested"] : ["active"];
    const domain = typeof body.domainId === "string"
      ? await db.competitorDomain.findFirst({ where: { id: body.domainId, workspaceId: ctx.workspaceId, state: { in: domainStates } }, select: { id: true, name: true } })
      : null;
    if (!domain) return bad("Pick a domain.");
    if (domain.id !== existing.domainId) {
      const before = await db.competitorDomain.findUnique({ where: { id: existing.domainId }, select: { name: true } });
      data.domainId = domain.id;
      events.push({ action: "move", field: "domain", from: existing.domainId, to: domain.id, fromName: before?.name ?? null, toName: domain.name });
      field = field ?? "domain";
    }
  }
  if (body.productLines !== undefined) {
    const lines = await cleanProductLines(ctx.workspaceId, body.productLines);
    data.productLines = lines as unknown as Prisma.InputJsonValue;
    const before = Array.isArray(existing.productLines) ? (existing.productLines as string[]) : [];
    events.push({ action: lines.length > before.length ? "attachProductLine" : lines.length < before.length ? "detachProductLine" : "update", field: "productLines", from: before.join(", "), to: lines.join(", ") });
    field = "productLines";
  }
  if (typeof body.position === "number" && Number.isFinite(body.position)) data.position = Math.max(0, Math.round(body.position));
  if (body.ourStatus !== undefined) {
    if (!isOwnStatus(body.ourStatus)) return bad("Pick has, partial or missing.");
    data.ourStatus = body.ourStatus;
    if (body.ourStatus !== existing.ourStatus) events.push({ action: "ourStatus", field: "ourStatus", from: existing.ourStatus, to: body.ourStatus });
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
        // A row enters the table only inside a domain that is in the table (or one accepted with it).
        if (domain?.state !== "active" && domain?.state !== "suggested") return bad(C.settings.activeDomainRequired);
        if (domain?.state === "suggested") {
          const agg = await db.competitorDomain.aggregate({ where: { workspaceId: ctx.workspaceId, state: "active" }, _max: { position: true } });
          await db.competitorDomain.update({ where: { id: domain.id }, data: { state: "active", position: (agg._max.position ?? -1) + 1 } });
          await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_domain_suggestion", { domainId: domain.id, competitorId: existing.suggestedById, decision: "accepted", via: "capability" });
        }
      }
    } else if (body.state === "active" && existing.state === "dismissed") {
      const domain = await db.competitorDomain.findUnique({ where: { id: (data.domainId as string | undefined) ?? existing.domainId }, select: { state: true } });
      if (domain?.state !== "active") return bad(C.settings.activeDomainRequired);
      data.state = "active";
      data.position = await nextActivePosition(ctx.workspaceId);
      decision = "accepted";
    }
  }

  await db.capability.update({ where: { id }, data });
  if (typeof data.name === "string") await releaseCapabilityAlias(ctx.workspaceId, data.name, id);
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
  // A decision and the edits sent with it (a rename or a move while accepting) are each recorded.
  for (const e of events) await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", entityId: id, ...e });
  if (decision) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_suggestion", {
      capabilityId: id,
      competitorId: existing.suggestedById,
      decision,
      domainChanged: data.domainId !== undefined,
    });
  } else if (!events.length) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "update", entityId: id, field, from: null, to: null });
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
  const existing = await db.capability.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, name: true, state: true, domainId: true } });
  if (!existing) return bad("Not found", 404);
  if (existing.state === "removed") return stateResponse(ctx);
  if (existing.state !== "active") return bad(C.settings.suggestionNotRemovable);
  // Not erased: the row, its statuses and idea links stay, so scans never add it back and a restore brings the evidence with it.
  await db.capability.update({ where: { id }, data: { state: "removed", removedAt: new Date(), removedById: ctx.user.id } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "remove", entityId: id, field: "state", from: "active", to: "removed", name: existing.name, domainId: existing.domainId });
  return stateResponse(ctx);
}
