import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { isSameSet } from "@/lib/competitors/order";

/**
 * PATCH {ids: string[]} — the organization's order of its companies, as dragged in the table: every company's id,
 * once, in the new order. It is the same order the Settings list shows; it changes for everyone in the organization.
 * Every role may set it (no admin gate). A list that is not exactly the organization's companies is refused: someone
 * added or removed a company meanwhile, and the page has to load again.
 */
export async function PATCH(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const current = (await db.competitor.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null, isOwn: false }, select: { id: true } })).map((c) => c.id);
  if (!isSameSet(current, body.ids)) return bad("The list of companies changed. Reload the page and try again.", 409);
  const ids: string[] = body.ids;
  await db.$transaction(ids.map((id, position) => db.competitor.update({ where: { id }, data: { position } })));
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_columns_reordered", { companies: ids.length });
  return stateResponse(ctx);
}
