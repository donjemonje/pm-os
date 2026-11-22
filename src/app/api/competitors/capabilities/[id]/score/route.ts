import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { reevaluateAfter } from "@/lib/competitors/reevaluate-api";
import { parseScore, REASONING_MAX, valueOfScore } from "@/lib/competitors/scores";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH the organization's OWN cell of a capability of the coverage model — the same three actions as a competitor's
 * cell (statuses/[id]/score): {score: 0..5} sets and locks it, {release: true} takes the lock off and has the row
 * scored again, {reasoning: "…"} saves the PM's reasoning and has the row re-evaluated with it.
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const cap = await db.capability.findFirst({ where: { id, workspaceId: ctx.workspaceId, state: { not: "removed" } }, select: { id: true, ourScore: true } });
  if (!cap || cap.ourScore == null) return bad("Not found", 404);

  // "Try again" after a re-evaluation that did not finish.
  if (body.reevaluate === true) {
    await reevaluateAfter(ctx, id, body);
    return stateResponse(ctx);
  }
  if (body.release === true) {
    await db.capability.update({ where: { id }, data: { ourScoreLockedAt: null, ourScoreLockedById: null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_score_released", { capabilityId: id, competitorId: "own", score: cap.ourScore });
    await reevaluateAfter(ctx, id, body);
    return stateResponse(ctx);
  }
  if (body.reasoning !== undefined) {
    if (typeof body.reasoning !== "string" || body.reasoning.trim().length > REASONING_MAX) return bad(C.errors.reasoningTooLong);
    const text = body.reasoning.trim();
    await db.capability.update({ where: { id }, data: { ourPmReasoning: text || null, ourPmReasoningAt: text ? new Date() : null, ourPmReasoningById: text ? ctx.user.id : null } });
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_reasoning_added", { capabilityId: id, competitorId: "own", length: text.length, cleared: !text });
    await reevaluateAfter(ctx, id, body);
    return stateResponse(ctx);
  }
  const score = parseScore(body.score);
  if (score === undefined) return bad(C.errors.pickScore);
  // The found / not found value follows the score; a value a PM had set by hand on the earlier cell is replaced by this newer call of theirs.
  await db.capability.update({ where: { id }, data: { ourScore: score, ourStatus: valueOfScore(score), ourScoreLockedAt: new Date(), ourScoreLockedById: ctx.user.id } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_capability_score_set", { capabilityId: id, competitorId: "own", from: cap.ourScore, to: score });
  return stateResponse(ctx);
}
