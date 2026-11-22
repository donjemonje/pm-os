import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { reevaluateAfter } from "@/lib/competitors/reevaluate-api";
import { parseScore, REASONING_MAX, valueOfScore } from "@/lib/competitors/scores";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH a competitor's capability cell of the coverage model — any member of the organization, one action per request:
 *   {score: 0..5}        the PM sets the number: it is locked (no run and no re-evaluation overwrites it) and marked as edited
 *   {release: true}      the lock is taken off and PMOS AI scores the row again
 *   {reasoning: "…"}     the PM's reasoning for this cell (at most 350 characters; "" clears it): PMOS AI re-evaluates
 *                        the capability's whole row with it and uses it in every later run
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const cell = await db.capabilityStatus.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, competitorId: true, capabilityId: true, score: true, value: true, scoreLockedAt: true } });
  if (!cell || cell.score == null) return bad("Not found", 404);

  if (body.release === true) {
    await db.capabilityStatus.update({ where: { id }, data: { scoreLockedAt: null, scoreLockedById: null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_score_released", { capabilityId: cell.capabilityId, competitorId: cell.competitorId, score: cell.score });
    await reevaluateAfter(ctx, cell.capabilityId, body);
    return stateResponse(ctx);
  }
  if (body.reasoning !== undefined) {
    if (typeof body.reasoning !== "string" || body.reasoning.trim().length > REASONING_MAX) return bad(C.errors.reasoningTooLong);
    const text = body.reasoning.trim();
    await db.capabilityStatus.update({ where: { id }, data: { pmReasoning: text || null, pmReasoningAt: text ? new Date() : null, pmReasoningById: text ? ctx.user.id : null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_reasoning_added", { capabilityId: cell.capabilityId, competitorId: cell.competitorId, length: text.length, cleared: !text });
    await reevaluateAfter(ctx, cell.capabilityId, body);
    return stateResponse(ctx);
  }
  const score = parseScore(body.score);
  if (score === undefined) return bad(C.errors.pickScore);
  const value = valueOfScore(score);
  await db.capabilityStatus.update({ where: { id }, data: { score, value, scoreLockedAt: new Date(), scoreLockedById: ctx.user.id, ...(cell.value !== value ? { changedAt: new Date() } : {}) } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_score_set", { capabilityId: cell.capabilityId, competitorId: cell.competitorId, from: cell.score, to: score });
  return stateResponse(ctx);
}
