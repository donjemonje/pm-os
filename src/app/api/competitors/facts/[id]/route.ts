import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { competitorsPartOff } from "@/lib/competitors/parts-server";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH a profile fact — any member of the org:
 *   {value}          correct the text (wins over later scans)
 *   {reset: true}    drop the correction
 *   {dismiss: true}  remove the fact; scans never re-add the same value
 */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const off = await competitorsPartOff("profiles");
  if (off) return off;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const fact = await db.profileFact.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true } });
  if (!fact) return bad("Not found", 404);

  if (body.dismiss === true) {
    await db.profileFact.update({ where: { id }, data: { dismissedAt: new Date() } });
  } else if (body.reset === true) {
    await db.profileFact.update({ where: { id }, data: { overrideValue: null, overrideUserId: null, overrideAt: null } });
  } else {
    const value = typeof body.value === "string" ? body.value.trim().slice(0, 80) : "";
    if (!value) return bad("A value is required.");
    await db.profileFact.update({ where: { id }, data: { overrideValue: value, overrideUserId: ctx.user.id, overrideAt: new Date() } });
  }
  return stateResponse(ctx);
}
