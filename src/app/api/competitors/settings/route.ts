import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { getCompetitorsConfig, saveCompetitorsConfig } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/**
 * PATCH {notifyUserIds?} — customer admin. The scan frequency is set per
 * source in Administration, there is no page cap (Website Scanning PRD
 * 2026-11-04) and no daily manual-scan limit (Daniel 2026-11-12); those are
 * ignored here if sent.
 */
export async function PATCH(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const current = await getCompetitorsConfig(ctx.workspaceId);
  const next = { ...current };
  if (body.notifyUserIds !== undefined) {
    if (!Array.isArray(body.notifyUserIds) || !body.notifyUserIds.every((x) => typeof x === "string")) return bad("Pick users from the list.");
    const ids = [...new Set(body.notifyUserIds as string[])];
    // Only active users of this organization can be recipients.
    const workspace = await db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { organizationId: true } });
    const members = workspace ? await db.user.findMany({ where: { id: { in: ids }, organizationId: workspace.organizationId, deactivatedAt: null }, select: { id: true } }) : [];
    if (members.length !== ids.length) return bad("Pick users from the list.");
    next.notifyUserIds = ids;
  }
  await saveCompetitorsConfig(ctx.workspaceId, next);
  if (next.notifyUserIds.join(",") !== current.notifyUserIds.join(",")) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_settings_changed", { setting: "notifyUserIds", from: current.notifyUserIds.length, to: next.notifyUserIds.length });
  }
  return stateResponse(ctx);
}
