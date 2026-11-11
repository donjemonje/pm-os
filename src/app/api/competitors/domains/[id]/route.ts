import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { MAX_DOMAIN_DESCRIPTION, MAX_DOMAIN_SUMMARY } from "@/lib/competitors/config";
import { isChipColorId } from "@/lib/ideas/colors";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { getCompetitorsState } from "@/lib/competitors/store";
import { mentionsName, renameMentions } from "@/lib/competitors/mentions";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { aliasesAfterRename } from "@/lib/competitors/decisions";
import { releaseDomainAlias } from "../route";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH: rename, describe (the PMOS AI definition text), summarize (the plain text for people) or recolor a domain.
 * A rename cascades: every other domain's and every capability's description
 * that mentions the old name is rewritten with the new one (the texts
 * cross-reference domains by name); the answer carries `renamedReferences`.
 * A rename also keeps the replaced name behind the domain (aliases): a scan that meets the old name recognises it.
 * PATCH {state:"active"} on a removed domain restores it, empty, at the end of the order.
 * PATCH {state:"active"} on a suggested domain approves it; {state:"dismissed"} declines it: its capabilities move
 * to their closest existing domain and the domain is never suggested again (Capability Analysis, "How the analysis runs").
 * DELETE ?moveTo=<active domain id>: the PM removes the domain. It is not erased: it leaves the table, scans never
 * suggest it again, and it can be restored. Its capabilities stay in the table — they move to the domain the PM
 * picks, asked once (Capability Analysis PRD, "PM and PMOS AI").
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const existing = await db.competitorDomain.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, name: true, state: true, suggestedById: true, aliases: true } });
  if (!existing) return bad("Not found", 404);
  if (existing.state === "removed") {
    // The only thing a removed domain accepts is its restore.
    if (body.state !== "active") return bad(C.settings.restoreFirst);
    const agg = await db.competitorDomain.aggregate({ where: { workspaceId: ctx.workspaceId, state: "active" }, _max: { position: true } });
    await db.competitorDomain.update({ where: { id }, data: { state: "active", removedAt: null, removedById: null, position: (agg._max.position ?? -1) + 1 } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "restore", entityId: id, field: "state", from: "removed", to: "active", name: existing.name, via: "settings" });
    return stateResponse(ctx);
  }
  const data: { name?: string; description?: string; summary?: string; color?: string; state?: string; position?: number; aliases?: string[] } = {};
  let field: string | null = null;
  // Decide a domain an analysis suggested. Approve: it joins the table as it is. Decline: its capabilities stay in the
  // table — each moves to the existing domain PMOS AI named as closest for it — and the name is never suggested again.
  if (body.state === "active" || body.state === "dismissed") {
    if (existing.state !== "suggested") return bad(C.settings.onlySuggestedDecided);
    if (body.state === "active") {
      const agg = await db.competitorDomain.aggregate({ where: { workspaceId: ctx.workspaceId, state: "active" }, _max: { position: true } });
      await db.$transaction([
        db.competitorDomain.update({ where: { id }, data: { state: "active", position: (agg._max.position ?? -1) + 1 } }),
        db.capability.updateMany({ where: { workspaceId: ctx.workspaceId, domainId: id, closestDomainId: { not: null } }, data: { closestDomainId: null } }),
      ]);
      await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_domain_suggestion", { domainId: id, competitorId: existing.suggestedById, decision: "accepted" });
      return stateResponse(ctx);
    }
    const [rows, activeDomains] = await Promise.all([
      db.capability.findMany({ where: { workspaceId: ctx.workspaceId, domainId: id, state: "active" }, select: { id: true, name: true, closestDomainId: true } }),
      db.competitorDomain.findMany({ where: { workspaceId: ctx.workspaceId, state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true } }),
    ]);
    const active = new Set(activeDomains.map((d) => d.id));
    const fallback = activeDomains[0]?.id ?? null;
    if (rows.length > 0 && !fallback) return bad(C.settings.removeDomainLast);
    // The closest domain when it is still in the table, else the first domain of the table.
    const targetOf = (closestDomainId: string | null) => (closestDomainId && active.has(closestDomainId) ? closestDomainId : fallback!);
    await db.$transaction([
      ...rows.map((k) => db.capability.update({ where: { id: k.id }, data: { domainId: targetOf(k.closestDomainId), closestDomainId: null } })),
      // Rows of the declined domain that are not in the table (removed earlier) keep no pointer to it either.
      db.capability.updateMany({ where: { workspaceId: ctx.workspaceId, domainId: id, closestDomainId: { not: null } }, data: { closestDomainId: null } }),
      db.competitorDomain.update({ where: { id }, data: { state: "dismissed" } }),
    ]);
    const movedTo = [...new Set(rows.map((k) => targetOf(k.closestDomainId)))];
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_domain_suggestion", { domainId: id, competitorId: existing.suggestedById, decision: "dismissed", moved: rows.length, movedTo: movedTo.join(",") });
    for (const k of rows) {
      await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", entityId: k.id, action: "move", via: "domain_declined", field: "domainId", from: id, to: targetOf(k.closestDomainId), name: k.name });
    }
    return stateResponse(ctx);
  }
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return bad("A name is required.");
    const dup = await db.competitorDomain.findFirst({
      where: { workspaceId: ctx.workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true, state: true },
    });
    if (dup) return bad(dup.state === "removed" ? C.settings.nameRemovedDomain : "A domain with this name already exists.", 409);
    data.name = name;
    if (name !== existing.name) data.aliases = aliasesAfterRename(existing.aliases, existing.name, name);
    field = "name";
  }
  const description = cleanText(body.description, MAX_DOMAIN_DESCRIPTION);
  if (description !== undefined) {
    data.description = description;
    field = field ?? "description";
  }
  const summary = cleanText(body.summary, MAX_DOMAIN_SUMMARY);
  if (summary !== undefined) {
    data.summary = summary;
    field = field ?? "summary";
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
    await releaseDomainAlias(ctx.workspaceId, newName, id);
  } else {
    await db.competitorDomain.update({ where: { id }, data });
  }
  const renamed = Boolean(data.name && data.name !== existing.name);
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: renamed ? "rename" : "update", entityId: id, field, from: renamed ? existing.name : null, to: renamed ? data.name ?? null : null, renamedReferences });
  const state = await getCompetitorsState(ctx.workspaceId, ctx.orgName, ctx.user.id, { withRemoved: true });
  return NextResponse.json({ state, renamedReferences });
}

export async function DELETE(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const existing = await db.competitorDomain.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, name: true, state: true } });
  if (!existing) return bad("Not found", 404);
  if (existing.state === "removed") return stateResponse(ctx);
  if (existing.state !== "active") return bad(C.settings.suggestionNotRemovable);
  // The capabilities in the table (and suggestions waiting in it) outlive the domain: the PM says once where they go.
  const held = await db.capability.findMany({ where: { workspaceId: ctx.workspaceId, domainId: id, state: { in: ["active", "suggested"] } }, select: { id: true } });
  let moveTo: string | null = null;
  if (held.length) {
    const wanted = new URL(req.url).searchParams.get("moveTo");
    const target = wanted && wanted !== id
      ? await db.competitorDomain.findFirst({ where: { id: wanted, workspaceId: ctx.workspaceId, state: "active" }, select: { id: true } })
      : null;
    if (!target) {
      const others = await db.competitorDomain.count({ where: { workspaceId: ctx.workspaceId, state: "active", id: { not: id } } });
      return bad(others ? C.settings.removeDomainPickTarget : C.settings.removeDomainLast);
    }
    moveTo = target.id;
  }
  await db.$transaction([
    // By domain, not by the ids read above: a suggestion a running scan adds in between moves too.
    ...(moveTo ? [db.capability.updateMany({ where: { workspaceId: ctx.workspaceId, domainId: id, state: { in: ["active", "suggested"] } }, data: { domainId: moveTo } })] : []),
    db.competitorDomain.update({ where: { id }, data: { state: "removed", removedAt: new Date(), removedById: ctx.user.id } }),
  ]);
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", {
    entity: "domain", action: "remove", entityId: id, field: "state", from: "active", to: "removed", name: existing.name,
    movedCapabilities: held.length, movedCapabilityIds: held.map((k) => k.id).join(","), moveTo,
  });
  return stateResponse(ctx);
}
