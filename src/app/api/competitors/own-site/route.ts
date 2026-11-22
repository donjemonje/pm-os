import { after, NextResponse } from "next/server";
import { claimAddressSearch, searchAddresses } from "@/lib/competitors/address-search";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { addOwnSite, changeOwnSite } from "@/lib/competitors/own-site";

/**
 * The organization's own website — Settings → Competitors → "Your company". Every member may (USER and
 * CUSTOMER_ADMIN have the same permissions). The own site is stored and scanned like a competitor's and is never
 * one (lib/competitors/own.ts).
 *
 *   POST  {website} → add it: what the scanner CLI `--own-site` does — one per organization, its first scan queued
 *                     like adding a competitor; refused when the organization has one or the site is a competitor.
 *   PATCH {website} → change it: the same site under another spelling keeps its pages; another site drops the old
 *                     site's pages and is scanned at once.
 * Either way the site's other addresses (help center, developer docs, release notes) are looked for after the
 * answer is sent (address-search.ts).
 */

function refusal(error: string): NextResponse {
  switch (error) {
    case "private":
      return bad(C.settings.privateHost);
    case "unreachable":
      return bad(C.settings.unreachable, 422);
    case "exists":
      return bad(C.settings.own.exists, 409);
    case "is_competitor":
      return bad(C.settings.own.isCompetitor, 409);
    case "no_own_site":
      return bad(C.settings.own.noSite, 409);
    default:
      return bad(C.settings.invalidUrl);
  }
}

/** The search for the site's other addresses: taken before the answer (the section already says "looking"), run after it. */
async function findOtherAddresses(competitorId: string, userId: string, home: { html: string; finalUrl: string } | null): Promise<void> {
  const claimedAt = await claimAddressSearch(competitorId).catch(() => null);
  if (!claimedAt) return;
  after(async () => {
    await searchAddresses(competitorId, { trigger: "added", userId, home, claimedAt });
  });
}

export async function POST(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const r = await addOwnSite(ctx.workspaceId, typeof body.website === "string" ? body.website : "", { via: "settings", userId: ctx.user.id });
  if ("error" in r) return refusal(r.error);
  await findOtherAddresses(r.competitorId, ctx.user.id, r.home);
  return stateResponse(ctx, 201);
}

export async function PATCH(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const r = await changeOwnSite(ctx.workspaceId, typeof body.website === "string" ? body.website : "", { userId: ctx.user.id });
  if ("error" in r) return refusal(r.error);
  // Another site has other addresses of its own: looked for now. The same site under another spelling has nothing new to find.
  if (r.newSite) await findOtherAddresses(r.competitorId, ctx.user.id, r.home);
  return stateResponse(ctx);
}
