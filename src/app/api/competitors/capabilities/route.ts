import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bad, catalogLocked, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { queueCatalogAnalyses } from "@/lib/competitors/analysis/engine";
import { nextPosition } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { isOwnStatus, MAX_CAPABILITY_AI_DEFINITION, MAX_OWN_PRODUCT } from "@/lib/competitors/config";
import { aliasesWithout, aliasList, nameKey } from "@/lib/competitors/decisions";

/**
 * A name a PM gives by hand wins over an alias: when a row takes `name`, every other
 * capability that kept it as a replaced name lets it go.
 */
export async function releaseCapabilityAlias(workspaceId: string, name: string, exceptId: string | null): Promise<void> {
  const rows = await db.capability.findMany({ where: { workspaceId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, aliases: true } });
  for (const r of rows) {
    if (!aliasList(r.aliases).some((a) => nameKey(a) === nameKey(name))) continue;
    await db.capability.update({ where: { id: r.id }, data: { aliases: aliasesWithout(r.aliases, name) as unknown as Prisma.InputJsonValue } });
  }
}

/** Only names from the org's product-line catalog survive. */
export async function cleanProductLines(workspaceId: string, v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) return [];
  const catalog = await db.productLine.findMany({ where: { workspaceId }, select: { name: true } });
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const hit = catalog.find((p) => p.name.toLowerCase() === raw.trim().toLowerCase());
    if (hit && !out.includes(hit.name)) out.push(hit.name);
  }
  return out;
}

/**
 * POST: add a capability by hand. A name the team removed (or dismissed as a suggestion) is not
 * a duplicate: adding it by hand brings that row back and clears the recorded removal, with
 * everything scans found for it.
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  // Until the organization's setup is done, the setup run builds the catalog: nothing is added by hand.
  const locked = await catalogLocked(ctx);
  if (locked) return locked;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (!name) return bad("A name is required.");
  const domainId = typeof body.domainId === "string" ? body.domainId : "";
  const domain = domainId ? await db.competitorDomain.findFirst({ where: { id: domainId, workspaceId: ctx.workspaceId, state: "active" }, select: { id: true } }) : null;
  if (!domain) return bad(C.settings.domainRequired);
  const dup = await db.capability.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true, state: true },
  });
  if (dup && (dup.state === "active" || dup.state === "suggested")) return bad("A capability with this name already exists.", 409);
  const productLines = await cleanProductLines(ctx.workspaceId, body.productLines);
  await releaseCapabilityAlias(ctx.workspaceId, name, dup?.id ?? null);
  if (dup) {
    // Removed or dismissed earlier: the PM's own add wins, and the recorded decision is cleared.
    const description = cleanText(body.description, MAX_DESCRIPTION);
    const ownProduct = cleanText(body.ownProduct, MAX_OWN_PRODUCT);
    const aiDefinition = cleanText(body.aiDefinition, MAX_CAPABILITY_AI_DEFINITION);
    await db.capability.update({
      where: { id: dup.id },
      data: {
        name,
        domainId: domain.id,
        state: "active",
        removedAt: null,
        removedById: null,
        // A suggestion the team declined and a PM now adds himself is his row, not the scan's.
        ...(dup.state === "dismissed" ? { origin: "manual", suggestedById: null, suggestedQuote: null } : {}),
        position: await nextPosition("capability", ctx.workspaceId),
        ...(description !== undefined ? { description } : {}),
        ...(ownProduct !== undefined ? { ownProduct } : {}),
        ...(aiDefinition !== undefined ? { aiDefinition: aiDefinition || null } : {}),
        ...(body.productLines !== undefined ? { productLines: productLines as unknown as Prisma.InputJsonValue } : {}),
        // An own status given by hand is the PM's value: no run of the organization's own site changes it (lib/competitors/own.ts).
        ...(isOwnStatus(body.ourStatus) ? { ourStatus: body.ourStatus, ourStatusSetAt: new Date(), ourStatusSetById: ctx.user.id } : {}),
      },
    });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "restore", entityId: dup.id, field: "state", from: dup.state, to: "active", name, via: "add" });
    // The row is back in the table: it is looked for at every competitor (no page is read again).
    await queueCatalogAnalyses(ctx.workspaceId, { startedById: ctx.user.id });
    return stateResponse(ctx, 201);
  }
  const cap = await db.capability.create({
    data: {
      workspaceId: ctx.workspaceId,
      domainId: domain.id,
      name,
      description: cleanText(body.description, MAX_DESCRIPTION) ?? "",
      ownProduct: cleanText(body.ownProduct, MAX_OWN_PRODUCT) ?? "",
      aiDefinition: cleanText(body.aiDefinition, MAX_CAPABILITY_AI_DEFINITION) || null,
      productLines: productLines as unknown as Prisma.InputJsonValue,
      ourStatus: isOwnStatus(body.ourStatus) ? body.ourStatus : "found",
      // A row typed by hand carries the own status its PM gave it: the PM's value, never changed by a run (lib/competitors/own.ts).
      ourStatusSetAt: new Date(),
      ourStatusSetById: ctx.user.id,
      position: await nextPosition("capability", ctx.workspaceId),
      origin: "manual",
      state: "active",
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "create", entityId: cap.id, field: null, from: null, to: name, name });
  // A row of ours the competitors were never checked for: it is looked for at every competitor (no page is read again).
  await queueCatalogAnalyses(ctx.workspaceId, { startedById: ctx.user.id });
  return stateResponse(ctx, 201);
}
