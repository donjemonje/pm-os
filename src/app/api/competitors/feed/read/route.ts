import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** POST {keys: string[]} — mark these feed items read for the signed-in user (per user, idempotent). */
export async function POST(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const keys = Array.isArray(body.keys) ? [...new Set(body.keys.filter((k): k is string => typeof k === "string" && k.length <= 200))].slice(0, 2000) : [];
  if (keys.length === 0) return bad("Nothing to mark.");
  await db.competitorFeedRead.createMany({ data: keys.map((key) => ({ workspaceId: ctx.workspaceId, userId: ctx.user.id, key })), skipDuplicates: true });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_feed_read", { items: keys.length, all: keys.length > 1 });
  return stateResponse(ctx);
}
