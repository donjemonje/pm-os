import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, cleanText, competitorsGuard, MAX_DESCRIPTION, readJson, stateResponse } from "@/lib/competitors/api";
import { nextPosition } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** POST: add a domain. */
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
  const domain = await db.competitorDomain.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      description: cleanText(body.description, MAX_DESCRIPTION) ?? "",
      position: await nextPosition("competitorDomain", ctx.workspaceId),
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_catalog_edited", { entity: "domain", action: "create", entityId: domain.id, field: null });
  return stateResponse(ctx, 201);
}
