import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { nextPosition } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

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

/** POST: add a capability by hand. */
export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (!name) return bad("A name is required.");
  const domainId = typeof body.domainId === "string" ? body.domainId : "";
  const domain = domainId ? await db.competitorDomain.findFirst({ where: { id: domainId, workspaceId: ctx.workspaceId }, select: { id: true } }) : null;
  if (!domain) return bad(C.settings.domainRequired);
  const dup = await db.capability.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true, state: true },
  });
  if (dup) return bad("A capability with this name already exists.", 409);
  const productLines = await cleanProductLines(ctx.workspaceId, body.productLines);
  const cap = await db.capability.create({
    data: {
      workspaceId: ctx.workspaceId,
      domainId: domain.id,
      name,
      description: cleanText(body.description, MAX_DESCRIPTION) ?? "",
      productLines: productLines as unknown as Prisma.InputJsonValue,
      position: await nextPosition("capability", ctx.workspaceId),
      origin: "manual",
      state: "active",
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "capability", action: "create", entityId: cap.id, field: null });
  return stateResponse(ctx, 201);
}
