import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { competitorsPartOff } from "@/lib/competitors/parts-server";
import { isFactKind } from "@/lib/competitors/config";
import { checkPii } from "@/lib/competitors/pii";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * POST {competitorId, kind, value}: a fact typed by a PM — for a blocked or
 * unreachable site, or anything the scan missed. No source page; never
 * stale. The PII check applies to typed facts too (rule 6).
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const off = await competitorsPartOff("profiles");
  if (off) return off;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const competitorId = typeof body.competitorId === "string" ? body.competitorId : "";
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: ctx.workspaceId, isOwn: false }, select: { id: true } });
  if (!competitor) return bad("Not found", 404);
  if (!isFactKind(body.kind)) return bad("Pick a fact kind.");
  const value = typeof body.value === "string" ? body.value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (!value) return bad("A value is required.");
  if (checkPii(value).hit) return bad("Facts about people (names, emails, phones, profiles) are not stored.");
  const existing = await db.profileFact.findUnique({ where: { competitorId_kind_value: { competitorId, kind: body.kind, value } } });
  if (existing) {
    if (existing.dismissedAt) await db.profileFact.update({ where: { id: existing.id }, data: { dismissedAt: null, manual: true } });
    else return bad("This fact is already there.", 409);
  } else {
    await db.profileFact.create({ data: { workspaceId: ctx.workspaceId, competitorId, kind: body.kind, value, manual: true, changedAt: new Date() } });
  }
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_fact_added", { competitorId, kind: body.kind });
  return stateResponse(ctx, 201);
}
