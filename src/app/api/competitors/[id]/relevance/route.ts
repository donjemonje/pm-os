import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { parseRelevance } from "@/lib/competitors/relevance";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH {level: 1 | 2 | 3 | null} — the signed-in user's own relevance level for one company (null clears it).
 * Per user: it changes nothing for anyone else. Every role may set it (no admin gate).
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const level = parseRelevance(body.level);
  if (level === undefined) return bad("The level is 1, 2 or 3.");
  const competitor = await db.competitor.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null, isOwn: false }, select: { id: true } });
  if (!competitor) return bad("Company not found.", 404);
  if (level === null) await db.competitorRelevance.deleteMany({ where: { userId: ctx.user.id, competitorId: id } });
  else await db.competitorRelevance.upsert({ where: { userId_competitorId: { userId: ctx.user.id, competitorId: id } }, create: { workspaceId: ctx.workspaceId, userId: ctx.user.id, competitorId: id, level }, update: { level } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_relevance_set", { competitorId: id, level });
  return stateResponse(ctx);
}
