import { db } from "../db";
import { recordCompetitorEvent } from "./analytics";
import { fetchPlain } from "./fetcher";
import { contentHash, siteLogoOf, siteNameOf } from "./html";
import { isPublicWebsite } from "./netguard";
import { OWN_MATERIAL_SOURCE_TYPE, PRODUCT_LINES_PAGE_URL, productLinesPageText, productLinesPageTitle } from "./own";
import type { CreateScanResult } from "./scan";
import { noteStoredChars } from "./settings";
import { InvalidUrlError, normalizeWebsite } from "./url";

/**
 * The database side of the organization's own site (own.ts has the rules). No customer-facing screen in this build:
 * the own site is added from the scanner CLI (`--own-site <workspaceId> <url>`), so nothing here may import
 * next/headers (lib/auth.ts and what imports it).
 */

export interface OwnSource {
  id: string;
  name: string;
  host: string;
  websiteUrl: string;
}

/** The workspace's own source, or null. A removed one does not count. */
export async function ownSourceOf(workspaceId: string): Promise<OwnSource | null> {
  return db.competitor.findFirst({ where: { workspaceId, isOwn: true, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, host: true, websiteUrl: true } });
}

export type AddOwnSiteResult =
  | {
      competitorId: string; name: string; host: string; websiteUrl: string; scan: CreateScanResult; frozenCapabilities: number; frozenFeatures: number;
      /** The home page this add fetched, for the search for the site's other addresses (address-search.ts) the caller starts next; null when it was not a readable page. */
      home: { html: string; finalUrl: string } | null;
    }
  | { error: "no_workspace" | "invalid_url" | "private" | "unreachable" | "exists" | "is_competitor"; message: string };

/**
 * Add the organization's own website: one per workspace, created like a competitor (a Competitor row with its
 * website source) but flagged `isOwn`, and its first scan queued exactly as adding a competitor does (onboarding).
 *
 * Refused, with nothing written: the workspace already has an own site; the site is tracked as a competitor in this
 * workspace; the address is not a public website; the address does not answer.
 *
 * The rows the catalog already has keep the own status they carry: it was typed by the team before any own site
 * existed, so it is frozen as a PM's value (ourStatusSetAt) and no run of the own source changes it.
 *
 * The site's other addresses — its help center, developer docs, release notes — are looked for next, by the caller
 * (address-search.ts searchAddresses, with the home page returned here): the CLI waits for the search, a route
 * runs it after its answer.
 */
export async function addOwnSite(workspaceId: string, website: string): Promise<AddOwnSiteResult> {
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, organization: { select: { name: true } } } });
  if (!workspace) return { error: "no_workspace", message: `no workspace with the id ${workspaceId}` };
  let site: { url: string; host: string };
  try {
    site = normalizeWebsite(website);
  } catch (e) {
    return e instanceof InvalidUrlError && e.reason === "private"
      ? { error: "private", message: `${website} is a private address, not a public website` }
      : { error: "invalid_url", message: `${website} is not a website address` };
  }
  const refusal = async (): Promise<AddOwnSiteResult | null> => {
    const own = await db.competitor.findFirst({ where: { workspaceId, isOwn: true }, select: { host: true, deletedAt: true } });
    if (own) return { error: "exists", message: `this organization already has an own site (${own.host}${own.deletedAt ? ", removed" : ""}) — one per organization` };
    const competitor = await db.competitor.findFirst({ where: { workspaceId, host: site.host }, select: { name: true, deletedAt: true } });
    if (competitor) return { error: "is_competitor", message: `${site.host} is ${competitor.deletedAt ? "a removed competitor" : "tracked as a competitor"} of this organization (${competitor.name}) — a site is either the own site or a competitor` };
    return null;
  };
  const early = await refusal();
  if (early) return early;
  // Name AND addresses must be public before anything is fetched from it (the same check as adding a competitor).
  if (!(await isPublicWebsite(site.url))) return { error: "private", message: `${site.host} does not resolve to a public address` };
  const probe = await fetchPlain(site.url);
  if (probe.status === 0) return { error: "unreachable", message: `${site.url} does not answer` };
  const origin = probe.finalUrl && probe.finalUrl.startsWith("http") ? new URL(probe.finalUrl).origin : site.url;
  const name = (workspace.organization.name.trim() || siteNameOf(probe.html, site.host)).slice(0, 80);

  const created = await db.$transaction(async (tx) => {
    // One per workspace: two requests in the same instant make one own site, not two.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-own-site:${workspaceId}`}))`;
    const own = await tx.competitor.findFirst({ where: { workspaceId, isOwn: true }, select: { id: true } });
    if (own) return null;
    const row = await tx.competitor.create({
      data: {
        workspaceId, name, websiteUrl: origin, host: site.host, isOwn: true, position: 0,
        logoUrl: probe.html ? siteLogoOf(probe.html, origin) : null,
        sources: { create: { workspaceId, type: "website", url: site.url } },
      },
      select: { id: true },
    });
    const at = new Date();
    const capabilities = await tx.capability.updateMany({ where: { workspaceId, ourStatusSetAt: null }, data: { ourStatusSetAt: at } });
    const features = await tx.feature.updateMany({ where: { workspaceId, ourStatusSetAt: null }, data: { ourStatusSetAt: at } });
    return { id: row.id, capabilities: capabilities.count, features: features.count };
  });
  if (!created) return (await refusal()) ?? { error: "exists", message: "this organization already has an own site — one per organization" };
  await recordCompetitorEvent(workspaceId, null, "cmp_own_site_added", { competitorId: created.id, host: site.host, via: "cli", frozenCapabilities: created.capabilities, frozenFeatures: created.features });
  // Loaded here, not at the top: the analysis engine imports this file (the product-lines page) and scan.ts imports the engine.
  const { createAndRouteScan } = await import("./scan");
  const scan = await createAndRouteScan(workspaceId, created.id, "onboarding", null);
  const home = probe.html && !probe.error ? { html: probe.html, finalUrl: probe.finalUrl || site.url } : null;
  return { competitorId: created.id, name, host: site.host, websiteUrl: origin, scan, frozenCapabilities: created.capabilities, frozenFeatures: created.features, home };
}

export type ProductLinesSync = "written" | "unchanged" | "removed" | "none";

/**
 * Write the organization's product lines as ONE stored page of its own source — called before every analysis of
 * the own source, so the research reads them and its quotes are checked against them like any page.
 *
 * The page lives in a source of its own (OWN_MATERIAL_SOURCE_TYPE), at a fixed internal address, so the scanner
 * never sees it. Its hash moves exactly when the text moves: a changed product line makes the page due again
 * (SourcePage.analyzedKey no longer matches), with the text before the change held until it was read, like a
 * scanned page. No product line → the page is marked removed (its findings go with the next run's clean-up).
 */
export async function syncProductLinesPage(workspaceId: string, ownCompetitorId: string): Promise<ProductLinesSync> {
  const [workspace, lines] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, select: { organization: { select: { name: true } } } }),
    db.productLine.findMany({ where: { workspaceId }, select: { name: true, description: true, position: true } }),
  ]);
  const orgName = workspace?.organization.name ?? "";
  const text = productLinesPageText(orgName, lines);
  const source = await db.competitorSource.findFirst({ where: { competitorId: ownCompetitorId, type: OWN_MATERIAL_SOURCE_TYPE }, select: { id: true } });
  const page = source ? await db.sourcePage.findUnique({ where: { sourceId_url: { sourceId: source.id, url: PRODUCT_LINES_PAGE_URL } }, select: { id: true, hash: true, text: true, chars: true, state: true, previousText: true, previousHash: true } }) : null;
  const now = new Date();

  if (text === null) {
    if (!page || page.state === "removed") return "none";
    await db.sourcePage.update({ where: { id: page.id }, data: { state: "removed", removedAt: now } });
    return "removed";
  }
  const hash = contentHash(text);
  const title = productLinesPageTitle(orgName);
  const sourceId = source?.id ?? (await db.competitorSource.create({ data: { workspaceId, competitorId: ownCompetitorId, type: OWN_MATERIAL_SOURCE_TYPE, url: PRODUCT_LINES_PAGE_URL, lastStatus: "ok" }, select: { id: true } })).id;
  if (!page) {
    await db.sourcePage.create({
      data: { workspaceId, sourceId, url: PRODUCT_LINES_PAGE_URL, title, kind: "page", hash, text, chars: text.length, state: "present", discoveredVia: "handin", lastReadAt: now },
    });
    noteStoredChars(text.length);
    return "written";
  }
  if (page.hash === hash && page.text === text && page.state === "present") return "unchanged";
  const changed = page.hash !== hash;
  await db.sourcePage.update({
    where: { id: page.id },
    data: {
      title, hash, text, chars: text.length, state: "present", removedAt: null, notFoundStreak: 0, lastReadAt: now,
      // Like a scanned page that changed (pages.ts): the text before the change is held until the analysis has read the change.
      ...(changed ? { changedAt: now, previousText: page.previousText ?? page.text, previousHash: page.previousHash ?? page.hash } : {}),
    },
  });
  noteStoredChars(text.length - (page.text == null ? 0 : page.chars));
  return "written";
}
