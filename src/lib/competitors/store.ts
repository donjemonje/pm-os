import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { collectFeed, type FeedItem } from "./feed";
import { mergeCompetitorsConfig, STALE_AFTER_SCANS, STALE_MS, type CompetitorsConfig, type OwnStatus, type ScanBadge, type StatusValue } from "./config";
import { isScannedAddress, readAddressSearch, searchLooking, searchRunning } from "./addresses";
import { orgSetupState, type OrgSetupState } from "./analysis/setup-rules";
import { NOT_OWN, readOwnEvidence, type OwnEvidence } from "./own";
import { siteHost } from "./url";

/**
 * Reads for the Competitors pages — one query set, returned in the shape the
 * client renders — plus the small helpers the API routes share. Every query
 * is scoped by workspaceId. Everything here comes out of the scan pipeline
 * (sources → scans → pages → statuses, history, facts) or a PM's own edits;
 * there is no other way in.
 *
 * The organization's own site (Competitor.isOwn, own.ts) is never in any list served here: not a competitor, not a
 * scan in progress, not a cell, not a fact. What it found of ours is on the rows (ourStatus, ownEvidence).
 */

export interface SourceRow {
  id: string;
  type: string;
  url: string;
  lastScanAt: string | null;
  lastStatus: string;
  lastError: string | null;
  /** Pages the last finished scan of this source read. */
  pages: number;
  badge: ScanBadge | null;
}

/** One of a company's other addresses (addresses.ts): a help center, developer docs or release notes, scanned whole like the website. */
export interface AddressRow {
  id: string;
  /** helpcenter | apidocs | changelog */
  kind: string;
  url: string;
  host: string;
  /** Pages stored from it that are there now. */
  pages: number;
  lastScanAt: string | null;
  /** A scan of it waits its turn. */
  pending: { since: string } | null;
  /** A scan is reading it right now. */
  running: { pagesSoFar: number; startedAt: string } | null;
  /** How its last finished scan ended, as users see it. */
  badge: ScanBadge | null;
  /** "link" | "llms" | "guess" (found by PM-OS) | "manual" (a PM added it) | null (added before this was recorded). */
  foundVia: string | null;
}

/** The search for a company's other addresses, as the pages show it. */
export interface AddressSearchRow {
  /** A search is working right now. */
  running: boolean;
  /** How the last search that finished ended: "done", "undecided" (PMOS AI could not say what the candidates are; nothing was added), or null — none finished yet. */
  status: "done" | "undecided" | null;
}

/**
 * The organization's own website and its other addresses — "Your company" in Settings → Competitors. Stored and
 * scanned like a competitor's site (lib/competitors/own.ts) and never one: it is in no list of competitors.
 */
export interface OwnSiteRow {
  id: string;
  name: string;
  websiteUrl: string;
  host: string;
  /** Pages stored from the website that are there now. */
  pages: number;
  lastScanAt: string | null;
  /** When the schedule scans it next; null before its first scan. */
  nextScanAt: string | null;
  pending: { since: string } | null;
  running: { pagesSoFar: number; startedAt: string } | null;
  /** How the last finished scan of the website ended, as users see it, and why when it did not end well. */
  badge: ScanBadge | null;
  lastError: string | null;
  addresses: AddressRow[];
  addressSearch: AddressSearchRow;
}

export interface CompetitorRow {
  id: string;
  name: string;
  websiteUrl: string;
  host: string;
  logoUrl: string | null;
  position: number;
  /** The website source (the one the scanner crawls). */
  source: {
    id: string;
    lastScanAt: string | null;
    lastStatus: string;
    lastError: string | null;
    /** Scan frequency in days (set per source in Administration). */
    scanEveryDays: number;
  } | null;
  /** A scan is waiting its turn (Website Scanning PRD: customers see "Scan pending"). Since = when it was created. */
  pending: { since: string } | null;
  /** A scan is reading pages right now. */
  running: { pagesSoFar: number; startedAt: string } | null;
  /** Every source of the competitor, website first — never an address a PM removed. */
  sources: SourceRow[];
  /** Its other addresses that are scanned (help center, developer docs, release notes), in the order they were added. */
  addresses: AddressRow[];
  addressSearch: AddressSearchRow;
  /** The last finished website scan, as users see it. */
  lastScan: {
    id: string;
    badge: ScanBadge | null;
    startedAt: string;
    pagesFetched: number;
    pagesSkipped: number;
    outcomes: Record<string, number>;
    robotsDisallowed: string[];
    removedPages: number;
    error: string | null;
  } | null;
  /** The last website scan that ended "full" or "incomplete" — what the matrix shows when the latest is blocked. */
  lastGoodScanAt: string | null;
  /** Most recent finished scan of any source. */
  lastAnyScanAt: string | null;
  /** Scan currently queued or running, if any. */
  activeScanId: string | null;
  /** The competitor's analysis run: the active one (queued, running, waiting) when there is one, else its latest finished one. */
  analysis: AnalysisRow | null;
  media: MediaRow[];
}

/** An analysis run as the pages show it (never its log). */
export interface AnalysisRow {
  id: string;
  /** "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" */
  status: string;
  /** "map" | "reading" | "match" | "second_look" | "apply" | "done" */
  step: string;
  pagesDone: number;
  pagesTotal: number;
  /** While waiting for PMOS AI: when it continues. */
  resumeAt: string | null;
  error: string | null;
  finishedAt: string | null;
}


export interface MediaRow { id: string; label: string; kind: string | null; mediaPath: string; sourceLabel: string | null; capturedAt: string | null }

export interface DomainRow {
  id: string;
  name: string;
  /** The PMOS AI definition text. */
  description: string;
  /** Plain text for people; "" when not written yet. */
  summary: string;
  color: string | null;
  position: number;
  /** "manual" | "ai" */
  origin: string;
  /** "active" | "suggested" | "dismissed" — removed domains are not in this list, see `removed`. */
  state: string;
  suggestedById: string | null;
}

/** A domain or capability a PM removed: kept so scans never add it back, restorable from Settings. */
export interface RemovedRow {
  id: string;
  name: string;
  removedAt: string | null;
  removedByName: string | null;
}
export interface RemovedCapabilityRow extends RemovedRow {
  domainId: string;
  domainName: string;
  /** False when its domain is removed too (or was never accepted): a restore must pick an active domain. */
  domainActive: boolean;
}

export interface CapabilityRow {
  id: string;
  domainId: string;
  name: string;
  description: string;
  /** The org's own product or module that carries it; "" when none. */
  ownProduct: string;
  productLines: string[];
  /** The org's own cell: found | not_found, no confidence — what the own site's analysis found, or a PM's value (which wins). */
  ourStatus: OwnStatus;
  /** A PM set the own cell by hand: no run changes it. */
  ourStatusByPm: boolean;
  /** The top evidence of ours behind the own cell (from the organization's own site); null = none. */
  ownEvidence: OwnEvidence | null;
  position: number;
  origin: string;
  state: string;
  suggestedById: string | null;
  suggestedQuote: string | null;
  /** Ideas linked to this roadmap row (created from it or matched), each with its Jira key and live Jira status when known. */
  ideas: { id: string; title: string; batchStatus: string; origin: string; jiraKey: string | null; jiraStatus: string | null }[];
}

/** One cell — of a capability row or of a feature row (same shape; exactly one of the two ids is set). */
export interface CellRow {
  id: string;
  competitorId: string;
  capabilityId: string | null;
  featureId: string | null;
  /** Effective value: override when set, else scanned. */
  value: StatusValue;
  scannedValue: StatusValue;
  /** The top-ranked evidence: the quote, its page, why it means they offer it, and the competitor's own name for it. */
  quote: string | null;
  sourceUrl: string | null;
  reasoning: string | null;
  wording: string | null;
  /** One plain sentence of what it does at this competitor: the description of the best-ranked evidence that has one. */
  description: string | null;
  /** Distinct pages that carry evidence for the cell. */
  evidenceCount: number;
  changedAt: string | null;
  override: { value: StatusValue; note: string | null; userName: string | null; at: string } | null;
  /** The competitor's product/module that ships this capability, as the pages name it. */
  product: string | null;
  /** Earlier values of the cell, newest first ([] for a feature cell: features carry no history). */
  history: { value: StatusValue; quote: string | null; sourceUrl: string | null; at: string }[];
}

/** A feature: the level under a capability. */
export interface FeatureRow {
  id: string;
  capabilityId: string;
  name: string;
  description: string;
  /** The org's own mark: found | not_found. */
  ourStatus: OwnStatus;
  ourStatusByPm: boolean;
  ownEvidence: OwnEvidence | null;
  position: number;
  origin: string;
}

export interface FactRow {
  id: string;
  competitorId: string;
  kind: string;
  value: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
  tone: string | null;
  /** The date the source states for the fact (timeline); null when undated. */
  factDate: string | null;
  /** Null = found by the source's first scan (baseline, not a change). */
  changedAt: string | null;
  /** Typed by a PM — no page behind it. */
  manual: boolean;
  /** Not seen on the site for STALE_AFTER_SCANS scans. */
  stale: boolean;
  /** Its page vanished or was blocked in a later scan. */
  unreachable: boolean;
  override: { value: string; userName: string | null; at: string } | null;
}

export interface CompetitorsState {
  orgName: string;
  /** The organization's own website is analysed (lib/competitors/own.ts): its own column is filled from it where no PM set a value. */
  ownSite: boolean;
  /** The own website with its scan and its other addresses; null = the organization has not added it yet. */
  own: OwnSiteRow | null;
  /** A scan of the own site or of one of its addresses is waiting or reading: Settings keeps refreshing (it is not a competitor scan — `scanning` does not count it). */
  ownScanning: boolean;
  config: CompetitorsConfig;
  productLines: string[];
  competitors: CompetitorRow[];
  /** Active, suggested and dismissed domains — never the removed ones. */
  domains: DomainRow[];
  /** Active, suggested and dismissed capabilities — never the removed ones. */
  capabilities: CapabilityRow[];
  /** Cells of the capabilities above. */
  cells: CellRow[];
  /** Active features of the capabilities above, and their cells. */
  features: FeatureRow[];
  featureCells: CellRow[];
  /** What PMs removed (Settings → Removed). */
  removed: { domains: RemovedRow[]; capabilities: RemovedCapabilityRow[] };
  facts: FactRow[];
  /** Most recent finished scan across the workspace (header "scanned X ago"). */
  lastScanAt: string | null;
  scanning: boolean;
  /**
   * The setup state of the organization (analysis/setup-rules.ts): required | in_setup | done. Until it is "done"
   * the pages say "being set up" instead of an empty table, and the catalog cannot be typed in by hand.
   */
  setup: OrgSetupState;
  /** An analysis run of the workspace is queued or in progress: the table is still being filled. */
  analyzing: boolean;
  /** A search for a company's other addresses is working: Settings keeps refreshing until it has ended. */
  searching: boolean;
  /** Active users of the organization — the notification recipients list. */
  members: { id: string; name: string; email: string }[];
  /** The Scan run in progress (header progress), if any. */
  activeRun: { id: string; total: number; done: number; current: string | null } | null;
  /** The last finished run and what its notification said. */
  lastRun: { id: string; finishedAt: string | null; status: string; summary: Record<string, unknown> } | null;
  /** News feed items since the baseline, newest first, with the signed-in user's read marks. */
  feed: FeedItem[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function getCompetitorsState(workspaceId: string, orgName: string, userId: string | null = null, opts: { /** Settings → Removed is for admins: only they are sent the list. */ withRemoved?: boolean } = {}): Promise<CompetitorsState> {
  const [workspace, productLines, competitors, allDomains, allCapabilities, statuses, facts, activeScans, recentScans, features, featureStatuses, activeAnalyses, finishedAnalyses, ownSite, lastSetupRun] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, include: { organization: true } }),
    db.productLine.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true } }),
    db.competitor.findMany({
      where: { workspaceId, deletedAt: null, ...NOT_OWN },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: {
        sources: { orderBy: { createdAt: "asc" } },
        media: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
    }),
    db.competitorDomain.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capability.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: { ideas: { orderBy: { createdAt: "asc" }, select: { origin: true, idea: { select: { id: true, title: true, batchStatus: true, sources: { where: { kind: "jira" }, select: { jiraKey: true }, take: 1 } } } } } },
    }),
    db.capabilityStatus.findMany({ where: { workspaceId, competitor: NOT_OWN, capability: { state: { not: "removed" } } }, include: { history: { orderBy: { at: "desc" }, take: 10 } } }),
    db.profileFact.findMany({ where: { workspaceId, competitor: NOT_OWN, dismissedAt: null }, orderBy: [{ kind: "asc" }, { value: "asc" }] }),
    // A scan of the organization's own site is not a competitor scan: it is not "scanning" on the Competitors pages.
    db.competitorScan.findMany({
      where: { workspaceId, source: { competitor: NOT_OWN }, status: { in: ["queued", "pending_local", "running"] } },
      select: { id: true, sourceId: true, status: true, startedAt: true, heartbeatAt: true, pagesFetched: true },
      orderBy: { startedAt: "asc" },
    }),
    // Finished scans, newest first — the badge, the staleness horizon and today's manual count come from here.
    // Never the page log: it is one row per page of every scan ever, and this query runs every 3 s while a scan is active
    // (Tomer's review 2026-11-10). The counts the cards need are in `outcomes`.
    db.competitorScan.findMany({
      where: { workspaceId, source: { competitor: NOT_OWN }, status: { in: ["ok", "partial", "failed", "stale"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true, sourceId: true, badge: true, trigger: true, startedAt: true, pagesFetched: true, outcomes: true, robotsDisallowed: true, removedPages: true, error: true },
    }),
    db.feature.findMany({ where: { workspaceId, state: "active", capability: { state: { not: "removed" } } }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.featureStatus.findMany({ where: { workspaceId, competitor: NOT_OWN, feature: { state: "active", capability: { state: { not: "removed" } } } } }),
    // Analysis runs — never their log (this query runs every 3 s while one is active). The own site's runs and the
    // setup run are in this list on purpose: while one works, the table is still being filled (`analyzing`).
    db.competitorAnalysis.findMany({
      where: { workspaceId, status: { in: ["queued", "running", "waiting"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, competitorId: true, status: true, step: true, pagesDone: true, pagesTotal: true, resumeAt: true, error: true, finishedAt: true },
    }),
    db.competitorAnalysis.findMany({
      where: { workspaceId, status: { in: ["done", "failed", "cancelled"] } },
      orderBy: { createdAt: "desc" },
      distinct: ["competitorId"],
      select: { id: true, competitorId: true, status: true, step: true, pagesDone: true, pagesTotal: true, resumeAt: true, error: true, finishedAt: true },
    }),
    db.competitor.findFirst({ where: { workspaceId, isOwn: true, deletedAt: null }, orderBy: { createdAt: "asc" }, include: { sources: { orderBy: { createdAt: "asc" } } } }),
    db.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true } }),
  ]);
  const analysisRow = (a: (typeof activeAnalyses)[number]): AnalysisRow => ({ id: a.id, status: a.status, step: a.step, pagesDone: a.pagesDone, pagesTotal: a.pagesTotal, resumeAt: a.resumeAt?.toISOString() ?? null, error: a.error, finishedAt: a.finishedAt?.toISOString() ?? null });
  const analysisOf = (competitorId: string): AnalysisRow | null => {
    // The run that is working wins over one that waits its turn; with none active, the latest finished one.
    const active = activeAnalyses.filter((a) => a.competitorId === competitorId);
    const a = active.find((x) => x.status !== "queued") ?? active[0] ?? finishedAnalyses.find((x) => x.competitorId === competitorId);
    return a ? analysisRow(a) : null;
  };
  const scansBySource = new Map<string, typeof recentScans>();
  const sourceOfScan = new Map<string, string>();
  for (const s of recentScans) {
    const list = scansBySource.get(s.sourceId) ?? [];
    list.push(s);
    scansBySource.set(s.sourceId, list);
    sourceOfScan.set(s.id, s.sourceId);
  }
  const asRecord = (v: unknown): Record<string, number> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {});

  // Removed rows leave every list the product reads; they are served apart, for Settings → Removed.
  const domains = allDomains.filter((d) => d.state !== "removed");
  const capabilities = allCapabilities.filter((k) => k.state !== "removed");
  const removedDomains = allDomains.filter((d) => d.state === "removed");
  const removedCapabilities = allCapabilities.filter((k) => k.state === "removed");
  const userIds = new Set<string>();
  for (const r of [...removedDomains, ...removedCapabilities]) if (r.removedById) userIds.add(r.removedById);
  for (const s of statuses) if (s.overrideUserId) userIds.add(s.overrideUserId);
  for (const s of featureStatuses) if (s.overrideUserId) userIds.add(s.overrideUserId);
  for (const f of facts) if (f.overrideUserId) userIds.add(f.overrideUserId);
  const users = userIds.size
    ? await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true } })
    : [];
  const userName = (id: string | null) => {
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u ? u.name || u.email : null;
  };
  // One active scan per source: a running one wins over a pending/queued one. A running scan whose heartbeat stopped
  // for 10 minutes is stale (the tick sweeps it); until then the row still says "in progress".
  const nowMs = Date.now();
  const activeBySource = new Map<string, (typeof activeScans)[number]>();
  for (const s of activeScans) {
    const cur = activeBySource.get(s.sourceId);
    if (!cur || (s.status === "running" && cur.status !== "running")) activeBySource.set(s.sourceId, s);
  }
  const isStaleRow = (s: (typeof activeScans)[number]) => s.status === "running" && nowMs - s.heartbeatAt.getTime() > STALE_MS;
  // The own site's scans are read apart — they are no competitor scans — and join the same maps: its row and its addresses are built like a competitor's.
  const ownWebsite = ownSite?.sources.find((s) => s.type === "website") ?? null;
  const ownSourceIds = ownSite ? ownSite.sources.filter((s) => s.type === "website" || isScannedAddress(s, ownSite.host)).map((s) => s.id) : [];
  const [ownActive, ownFinished] = ownSourceIds.length
    ? await Promise.all([
        db.competitorScan.findMany({ where: { sourceId: { in: ownSourceIds }, status: { in: ["queued", "pending_local", "running"] } }, select: { id: true, sourceId: true, status: true, startedAt: true, heartbeatAt: true, pagesFetched: true }, orderBy: { startedAt: "asc" } }),
        db.competitorScan.findMany({
          where: { sourceId: { in: ownSourceIds }, status: { in: ["ok", "partial", "failed", "stale"] } },
          orderBy: { startedAt: "desc" },
          distinct: ["sourceId"],
          select: { id: true, sourceId: true, badge: true, trigger: true, startedAt: true, pagesFetched: true, outcomes: true, robotsDisallowed: true, removedPages: true, error: true },
        }),
      ])
    : [[], []];
  for (const s of ownActive) {
    const cur = activeBySource.get(s.sourceId);
    if (!cur || (s.status === "running" && cur.status !== "running")) activeBySource.set(s.sourceId, s);
  }
  for (const s of ownFinished) scansBySource.set(s.sourceId, [s]);
  // A company's other addresses: its sources that are scanned besides the website, with the pages stored from each.
  const addressSources = [...competitors, ...(ownSite ? [ownSite] : [])].flatMap((c) => c.sources.filter((s) => isScannedAddress(s, c.host)));
  const countedSources = [...addressSources.map((s) => s.id), ...(ownWebsite ? [ownWebsite.id] : [])];
  const pagesOfSource = new Map(
    countedSources.length
      ? // Pages a scan stored: never the site's llms.txt, which the address search keeps for the map step.
        (await db.sourcePage.groupBy({ by: ["sourceId"], where: { sourceId: { in: countedSources }, state: { not: "removed" }, discoveredVia: { not: "discovery" } }, _count: { _all: true } })).map((g) => [g.sourceId, g._count._all])
      : [],
  );
  const addressRow = (s: (typeof addressSources)[number]): AddressRow => {
    const a = activeBySource.get(s.id);
    return {
      id: s.id,
      kind: s.type,
      url: s.url,
      host: siteHost(new URL(s.url)),
      pages: pagesOfSource.get(s.id) ?? 0,
      lastScanAt: s.lastScanAt?.toISOString() ?? null,
      pending: a && (a.status === "queued" || a.status === "pending_local" || isStaleRow(a)) ? { since: a.startedAt.toISOString() } : null,
      running: a && a.status === "running" && !isStaleRow(a) ? { pagesSoFar: a.pagesFetched, startedAt: a.startedAt.toISOString() } : null,
      badge: (scansBySource.get(s.id)?.[0]?.badge as ScanBadge | null) ?? null,
      foundVia: s.foundVia ?? null,
    };
  };
  // A search that waits for the scan station (remote scanning OFF) is "looking" while a scan of the company's main
  // website is waiting or being read: that scan brings what the search needs. With no such scan it shows nothing.
  const addressSearchRow = (c: { addressSearchStartedAt?: Date | null; addressSearch?: unknown; sources: { id: string; type: string }[] }): AddressSearchRow => {
    const stored = readAddressSearch(c.addressSearch);
    const website = c.sources.find((s) => s.type === "website");
    return {
      running: searchLooking(c.addressSearchStartedAt, stored, website != null && activeBySource.has(website.id), nowMs),
      status: stored && stored.status !== "waiting" ? stored.status : null,
    };
  };
  const config = mergeCompetitorsConfig(workspace?.competitorsConfig);
  const [members, activeRun, lastRun, feed] = await Promise.all([
    workspace
      ? db.user.findMany({ where: { organizationId: workspace.organizationId, deactivatedAt: null }, orderBy: [{ name: "asc" }, { email: "asc" }], select: { id: true, name: true, email: true } })
      : [],
    db.competitorScanRun.findFirst({ where: { workspaceId, status: "running" }, orderBy: { startedAt: "desc" }, select: { id: true, total: true, done: true, current: true } }),
    db.competitorScanRun.findFirst({ where: { workspaceId, status: { in: ["ok", "failed"] } }, orderBy: { startedAt: "desc" }, select: { id: true, finishedAt: true, status: true, summary: true } }),
    collectFeed(workspaceId, config.baselineUntil, userId),
  ]);

  let lastScanAt: Date | null = null;
  for (const c of competitors) {
    for (const s of c.sources) {
      if (s.lastScanAt && (!lastScanAt || s.lastScanAt > lastScanAt)) lastScanAt = s.lastScanAt;
    }
  }

  // Live Jira status for linked ideas (the snapshot is a render cache replaced on every import).
  const jiraKeys = [...new Set(capabilities.flatMap((k) => k.ideas.map((l) => l.idea.sources[0]?.jiraKey).filter((v): v is string => Boolean(v))))];
  const jiraStatusOf = new Map(
    jiraKeys.length
      ? (await db.jiraIdeaSnapshot.findMany({ where: { workspaceId, key: { in: jiraKeys } }, select: { key: true, status: true } })).map((j) => [j.key, j.status])
      : [],
  );
  const ownScan = ownWebsite ? activeBySource.get(ownWebsite.id) : undefined;
  const own: OwnSiteRow | null = ownSite
    ? {
        id: ownSite.id,
        name: ownSite.name,
        websiteUrl: ownSite.websiteUrl,
        host: ownSite.host,
        pages: ownWebsite ? pagesOfSource.get(ownWebsite.id) ?? 0 : 0,
        lastScanAt: ownWebsite?.lastScanAt?.toISOString() ?? null,
        nextScanAt: ownWebsite?.lastScanAt ? new Date(ownWebsite.lastScanAt.getTime() + ownWebsite.scanEveryDays * 86_400_000).toISOString() : null,
        pending: ownScan && (ownScan.status === "queued" || ownScan.status === "pending_local" || isStaleRow(ownScan)) ? { since: ownScan.startedAt.toISOString() } : null,
        running: ownScan && ownScan.status === "running" && !isStaleRow(ownScan) ? { pagesSoFar: ownScan.pagesFetched, startedAt: ownScan.startedAt.toISOString() } : null,
        badge: ownWebsite ? ((scansBySource.get(ownWebsite.id)?.[0]?.badge as ScanBadge | null) ?? null) : null,
        lastError: ownWebsite ? scansBySource.get(ownWebsite.id)?.[0]?.error ?? null : null,
        addresses: ownSite.sources.filter((s) => isScannedAddress(s, ownSite.host)).map(addressRow),
        addressSearch: addressSearchRow(ownSite),
      }
    : null;
  return {
    orgName,
    ownSite: ownSite != null,
    own,
    ownScanning: ownActive.length > 0,
    // The stored state, else what the data says (domains and capabilities in any state, the latest setup run).
    setup: orgSetupState(workspace?.organization.competitorsSetup, { domains: allDomains.length, capabilities: allCapabilities.length, lastSetupStatus: lastSetupRun?.status ?? null }),
    config,
    productLines: productLines.map((p) => p.name),
    competitors: competitors.map((c) => {
      const website = c.sources.find((s) => s.type === "website") ?? null;
      const websiteScans = website ? scansBySource.get(website.id) ?? [] : [];
      const last = websiteScans[0];
      const lastAny = c.sources.map((s) => s.lastScanAt).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        id: c.id,
        name: c.name,
        websiteUrl: c.websiteUrl,
        host: c.host,
        logoUrl: c.logoUrl,
        position: c.position,
        source: website
          ? { id: website.id, lastScanAt: website.lastScanAt?.toISOString() ?? null, lastStatus: website.lastStatus, lastError: website.lastError, scanEveryDays: website.scanEveryDays }
          : null,
        pending: (() => {
          const a = website ? activeBySource.get(website.id) : undefined;
          return a && (a.status === "queued" || a.status === "pending_local" || isStaleRow(a)) ? { since: a.startedAt.toISOString() } : null;
        })(),
        running: (() => {
          const a = website ? activeBySource.get(website.id) : undefined;
          return a && a.status === "running" && !isStaleRow(a) ? { pagesSoFar: a.pagesFetched, startedAt: a.startedAt.toISOString() } : null;
        })(),
        addresses: c.sources.filter((s) => isScannedAddress(s, c.host)).map(addressRow),
        addressSearch: addressSearchRow(c),
        sources: c.sources
          .filter((s) => !s.removedAt)
          .sort((a, b) => (a.type === "website" ? -1 : b.type === "website" ? 1 : 0))
          .map((s) => {
            const sl = scansBySource.get(s.id)?.[0];
            return { id: s.id, type: s.type, url: s.url, lastScanAt: s.lastScanAt?.toISOString() ?? null, lastStatus: s.lastStatus, lastError: s.lastError, pages: sl?.pagesFetched ?? 0, badge: (sl?.badge as ScanBadge | null) ?? null };
          }),
        lastScan: last
          ? (() => {
              return {
                id: last.id,
                badge: (last.badge as ScanBadge | null) ?? null,
                startedAt: last.startedAt.toISOString(),
                pagesFetched: last.pagesFetched,
                // Every page not read, whatever the reason (not read by category, robots, time limit, storage): the outcome counts.
                pagesSkipped: Object.values(asRecord(last.outcomes)).reduce((n, v) => n + v, 0),
                outcomes: asRecord(last.outcomes),
                robotsDisallowed: asStringArray(last.robotsDisallowed),
                removedPages: asStringArray(last.removedPages).length,
                error: last.error,
              };
            })()
          : null,
        lastGoodScanAt: websiteScans.find((s) => s.badge === "full" || s.badge === "incomplete")?.startedAt.toISOString() ?? null,
        lastAnyScanAt: lastAny?.toISOString() ?? null,
        activeScanId: website ? activeBySource.get(website.id)?.id ?? null : null,
        analysis: analysisOf(c.id),
        media: c.media.map((m) => ({ id: m.id, label: m.label, kind: m.kind, mediaPath: m.mediaPath, sourceLabel: m.sourceLabel, capturedAt: m.capturedAt?.toISOString() ?? null })),
      };
    }),
    domains: domains.map((d) => ({ id: d.id, name: d.name, description: d.description, summary: d.summary, color: d.color, position: d.position, origin: d.origin, state: d.state, suggestedById: d.suggestedById })),
    capabilities: capabilities.map((k) => ({
      id: k.id,
      domainId: k.domainId,
      name: k.name,
      description: k.description,
      ownProduct: k.ownProduct,
      productLines: asStringArray(k.productLines),
      ourStatus: (k.ourStatus === "not_found" ? "not_found" : "found") as OwnStatus,
      ourStatusByPm: k.ourStatusSetAt != null,
      ownEvidence: readOwnEvidence(k.ourEvidence),
      position: k.position,
      origin: k.origin,
      state: k.state,
      suggestedById: k.suggestedById,
      suggestedQuote: k.suggestedQuote,
      ideas: k.ideas.map((l) => {
        const key = l.idea.sources[0]?.jiraKey ?? null;
        return { id: l.idea.id, title: l.idea.title, batchStatus: l.idea.batchStatus, origin: l.origin, jiraKey: key, jiraStatus: key ? jiraStatusOf.get(key) ?? null : null };
      }),
    })),
    cells: statuses.map((s) => {
      const scanned = s.value as StatusValue;
      const ov = s.overrideValue as StatusValue | null;
      return {
        id: s.id,
        competitorId: s.competitorId,
        capabilityId: s.capabilityId,
        featureId: null,
        value: ov ?? scanned,
        scannedValue: scanned,
        quote: s.quote,
        sourceUrl: s.sourceUrl,
        reasoning: s.reasoning,
        wording: s.wording,
        description: s.description ?? null,
        evidenceCount: s.evidenceCount,
        changedAt: s.changedAt?.toISOString() ?? null,
        override: ov && s.overrideAt ? { value: ov, note: s.overrideNote, userName: userName(s.overrideUserId), at: s.overrideAt.toISOString() } : null,
        product: s.product,
        history: s.history.map((h) => ({ value: h.value as StatusValue, quote: h.quote, sourceUrl: h.sourceUrl, at: h.at.toISOString() })),
      };
    }),
    features: features.map((f) => ({ id: f.id, capabilityId: f.capabilityId, name: f.name, description: f.description, ourStatus: (f.ourStatus === "found" ? "found" : "not_found") as OwnStatus, ourStatusByPm: f.ourStatusSetAt != null, ownEvidence: readOwnEvidence(f.ourEvidence), position: f.position, origin: f.origin })),
    featureCells: featureStatuses.map((s) => {
      const scanned = s.value as StatusValue;
      const ov = s.overrideValue as StatusValue | null;
      return {
        id: s.id,
        competitorId: s.competitorId,
        capabilityId: null,
        featureId: s.featureId,
        value: ov ?? scanned,
        scannedValue: scanned,
        quote: s.quote,
        sourceUrl: s.sourceUrl,
        reasoning: s.reasoning,
        wording: s.wording,
        description: s.description ?? null,
        evidenceCount: s.evidenceCount,
        changedAt: s.changedAt?.toISOString() ?? null,
        override: ov && s.overrideAt ? { value: ov, note: s.overrideNote, userName: userName(s.overrideUserId), at: s.overrideAt.toISOString() } : null,
        product: null,
        history: [],
      };
    }),
    removed: !opts.withRemoved ? { domains: [], capabilities: [] } : {
      domains: removedDomains
        .map((d) => ({ id: d.id, name: d.name, removedAt: d.removedAt?.toISOString() ?? null, removedByName: userName(d.removedById) }))
        .sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? "")),
      capabilities: removedCapabilities
        .map((k) => {
          const domain = allDomains.find((d) => d.id === k.domainId);
          return { id: k.id, name: k.name, removedAt: k.removedAt?.toISOString() ?? null, removedByName: userName(k.removedById), domainId: k.domainId, domainName: domain?.name ?? "", domainActive: domain?.state === "active" };
        })
        .sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? "")),
    },
    facts: facts.map((f) => {
      // Stale = the last STALE_AFTER_SCANS finished scans of the fact's own source all missed it.
      const sourceId = f.scanId ? sourceOfScan.get(f.scanId) : undefined;
      const recent = sourceId ? (scansBySource.get(sourceId) ?? []).filter((s) => s.badge === "full" || s.badge === "incomplete").slice(0, STALE_AFTER_SCANS) : [];
      const stale = !f.manual && recent.length >= STALE_AFTER_SCANS && !recent.some((s) => s.id === f.lastSeenScanId);
      return {
        id: f.id,
        competitorId: f.competitorId,
        kind: f.kind,
        value: f.overrideValue ?? f.value,
        sourceUrl: f.sourceUrl,
        sourceLabel: f.sourceLabel,
        tone: f.tone,
        factDate: f.factDate?.toISOString() ?? null,
        changedAt: f.changedAt?.toISOString() ?? null,
        manual: f.manual,
        stale,
        unreachable: f.unreachableAt != null,
        override: f.overrideValue && f.overrideAt ? { value: f.overrideValue, userName: userName(f.overrideUserId), at: f.overrideAt.toISOString() } : null,
      };
    }),
    lastScanAt: lastScanAt?.toISOString() ?? null,
    scanning: activeScans.length > 0 || activeRun != null,
    analyzing: activeAnalyses.length > 0,
    searching: competitors.some((c) => searchRunning(c.addressSearchStartedAt, nowMs)) || searchRunning(ownSite?.addressSearchStartedAt, nowMs),
    members,
    activeRun,
    feed,
    lastRun: lastRun
      ? { id: lastRun.id, finishedAt: lastRun.finishedAt?.toISOString() ?? null, status: lastRun.status, summary: lastRun.summary && typeof lastRun.summary === "object" && !Array.isArray(lastRun.summary) ? (lastRun.summary as Record<string, unknown>) : {} }
      : null,
  };
}

/** Workspace config, merged over defaults. */
export async function getCompetitorsConfig(workspaceId: string): Promise<CompetitorsConfig> {
  const w = await db.workspace.findUnique({ where: { id: workspaceId }, select: { competitorsConfig: true } });
  return mergeCompetitorsConfig(w?.competitorsConfig);
}

export async function saveCompetitorsConfig(workspaceId: string, config: CompetitorsConfig): Promise<void> {
  await db.workspace.update({ where: { id: workspaceId }, data: { competitorsConfig: config as unknown as Prisma.InputJsonValue } });
}

/** Next free position at the end of a list. Domains and capabilities count active rows only: suggestions are parked at 9999 until a PM decides. */
export async function nextPosition(model: "competitor" | "competitorDomain" | "capability", workspaceId: string): Promise<number> {
  const agg =
    model === "competitor"
      ? await db.competitor.aggregate({ where: { workspaceId, ...NOT_OWN }, _max: { position: true } })
      : model === "competitorDomain"
        ? await db.competitorDomain.aggregate({ where: { workspaceId, state: "active" }, _max: { position: true } })
        : await db.capability.aggregate({ where: { workspaceId, state: "active" }, _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}
