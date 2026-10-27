import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, cleanName, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { fetchPlain } from "@/lib/competitors/fetcher";
import { siteLogoOf, siteNameOf } from "@/lib/competitors/html";
import { nextPosition } from "@/lib/competitors/store";
import { InvalidUrlError, normalizeWebsite } from "@/lib/competitors/url";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** GET: the whole Competitors state for the page. */
export async function GET() {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  return stateResponse(ctx);
}

/**
 * POST {website, name?}: add a competitor by its website. The name comes
 * from the site (og:site_name, else the title) unless given; a PM can rename
 * it afterwards. The address must answer — a bot wall counts as answering.
 */
export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;

  let site: { url: string; host: string };
  try {
    site = normalizeWebsite(typeof body.website === "string" ? body.website : "");
  } catch (e) {
    return bad(e instanceof InvalidUrlError && e.reason === "private" ? C.settings.privateHost : C.settings.invalidUrl);
  }
  const dupHost = await db.competitor.findFirst({ where: { workspaceId: ctx.workspaceId, host: site.host }, select: { id: true } });
  if (dupHost) return bad(C.settings.duplicateHost, 409);

  const probe = await fetchPlain(site.url);
  if (probe.status === 0) return bad(C.settings.unreachable, 422);

  let name = body.name !== undefined && body.name !== "" ? cleanName(body.name) : null;
  if (body.name !== undefined && body.name !== "" && !name) return bad(C.settings.nameRequired);
  if (!name) name = siteNameOf(probe.html, site.host).slice(0, 80);
  // Two sites may share a brand word; keep both by suffixing the host.
  const dupName = await db.competitor.findFirst({
    where: { workspaceId: ctx.workspaceId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (dupName) {
    if (body.name) return bad(C.settings.duplicateName, 409);
    name = `${name} (${site.host})`.slice(0, 80);
  }

  const competitor = await db.competitor.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      websiteUrl: probe.finalUrl && probe.finalUrl.startsWith("http") ? new URL(probe.finalUrl).origin : site.url,
      host: site.host,
      logoUrl: probe.html ? siteLogoOf(probe.html, probe.finalUrl && probe.finalUrl.startsWith("http") ? new URL(probe.finalUrl).origin : site.url) : null,
      position: await nextPosition("competitor", ctx.workspaceId),
      sources: { create: { workspaceId: ctx.workspaceId, type: "website", url: site.url } },
    },
    select: { id: true },
  });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_competitor_added", { competitorId: competitor.id, source: "settings", nameFromSite: !body.name });
  return stateResponse(ctx, 201);
}
