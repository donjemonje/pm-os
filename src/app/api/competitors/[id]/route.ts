import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { InvalidUrlError, normalizeWebsite } from "@/lib/competitors/url";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

type Params = { params: Promise<{ id: string }> };

/** PATCH: rename / new website / logo. DELETE: remove the competitor and everything under it. */
export async function PATCH(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const existing = await db.competitor.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!existing) return bad("Not found", 404);

  const data: { name?: string; websiteUrl?: string; host?: string; logoUrl?: string | null } = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return bad(C.settings.nameRequired);
    const dup = await db.competitor.findFirst({
      where: { workspaceId: ctx.workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (dup) return bad(C.settings.duplicateName, 409);
    data.name = name;
  }
  if (body.website !== undefined) {
    try {
      const site = normalizeWebsite(typeof body.website === "string" ? body.website : "");
      const dup = await db.competitor.findFirst({ where: { workspaceId: ctx.workspaceId, id: { not: id }, host: site.host }, select: { id: true } });
      if (dup) return bad(C.settings.duplicateHost, 409);
      data.websiteUrl = site.url;
      data.host = site.host;
    } catch (e) {
      return bad(e instanceof InvalidUrlError && e.reason === "private" ? C.settings.privateHost : C.settings.invalidUrl);
    }
  }
  if (body.logoUrl !== undefined) {
    data.logoUrl = typeof body.logoUrl === "string" && body.logoUrl.trim() ? body.logoUrl.trim().slice(0, 500) : null;
  }
  await db.competitor.update({ where: { id }, data });
  if (data.websiteUrl) {
    await db.competitorSource.updateMany({ where: { competitorId: id, type: "website" }, data: { url: data.websiteUrl } });
  }
  return stateResponse(ctx);
}

export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const existing = await db.competitor.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    select: { id: true, sources: { select: { lastScanAt: true } } },
  });
  if (!existing) return bad("Not found", 404);
  const running = await db.competitorScan.findFirst({
    where: { workspaceId: ctx.workspaceId, status: { in: ["queued", "running"] }, source: { competitorId: id } },
    select: { id: true },
  });
  if (running) return bad(C.settings.scanRunning, 409);
  await db.competitor.delete({ where: { id } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_competitor_removed", {
    competitorId: id,
    hadScans: existing.sources.some((s) => s.lastScanAt != null),
  });
  return stateResponse(ctx);
}
