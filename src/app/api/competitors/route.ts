import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { fetchPlain } from "@/lib/competitors/fetcher";
import { nextPosition } from "@/lib/competitors/store";
import { InvalidUrlError, normalizeWebsite } from "@/lib/competitors/url";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** GET: the whole Competitors state for the page. POST: add a competitor (or the own site). */
export async function GET() {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  return stateResponse(ctx);
}

export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;

  const name = cleanName(body.name);
  if (!name) return bad(C.settings.nameRequired);
  let site: { url: string; host: string };
  try {
    site = normalizeWebsite(typeof body.website === "string" ? body.website : "");
  } catch (e) {
    return bad(e instanceof InvalidUrlError && e.reason === "private" ? C.settings.privateHost : C.settings.invalidUrl);
  }
  const isSelf = body.isSelf === true;

  const dupHost = await db.competitor.findFirst({ where: { workspaceId: ctx.workspaceId, host: site.host }, select: { id: true } });
  if (dupHost) return bad(C.settings.duplicateHost, 409);
  const dupName = await db.competitor.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (dupName) return bad(C.settings.duplicateName, 409);
  if (isSelf) {
    const self = await db.competitor.findFirst({ where: { workspaceId: ctx.workspaceId, isSelf: true }, select: { id: true } });
    if (self) return bad("The organization's own website is already set.", 409);
  }

  // Validation §6: the address must answer. A bot wall counts as answering.
  const probe = await fetchPlain(site.url);
  if (probe.status === 0) return bad(C.settings.unreachable, 422);

  const competitor = await db.competitor.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      websiteUrl: site.url,
      host: site.host,
      isSelf,
      position: await nextPosition("competitor", ctx.workspaceId),
      sources: { create: { workspaceId: ctx.workspaceId, type: "website", url: site.url } },
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_competitor_added", { competitorId: competitor.id, isSelf, source: "settings" });
  return stateResponse(ctx, 201);
}
