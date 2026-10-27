import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { LOW_CONFIDENCE, mergeCompetitorsConfig, rescanLimitEnforced, STALE_AFTER_SCANS, type CompetitorsConfig, type ScanBadge, type StatusValue } from "./config";

/**
 * Reads for the Competitors pages — one query set, returned in the shape the
 * client renders — plus the small helpers the API routes share. Every query
 * is scoped by workspaceId. Everything here comes out of the scan pipeline
 * (sources → scans → pages → statuses, history, facts) or a PM's own edits;
 * there is no other way in.
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
  } | null;
  /** Every source of the competitor, website first. */
  sources: SourceRow[];
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
  /** Manual scans started today (the per-day limit applies to these). */
  manualScansToday: number;
  /** Scan currently queued or running, if any. */
  activeScanId: string | null;
  media: MediaRow[];
}

export interface MediaRow { id: string; label: string; kind: string | null; mediaPath: string; sourceLabel: string | null; capturedAt: string | null }

export interface DomainRow {
  id: string;
  name: string;
  description: string;
  color: string | null;
  position: number;
}

export interface CapabilityRow {
  id: string;
  domainId: string;
  name: string;
  description: string;
  productLines: string[];
  /** The org's own cell: has | partial | missing. */
  ourStatus: StatusValue;
  position: number;
  origin: string;
  state: string;
  suggestedById: string | null;
  suggestedQuote: string | null;
}

export interface CellRow {
  id: string;
  competitorId: string;
  capabilityId: string;
  /** Effective value: override when set, else scanned. */
  value: StatusValue;
  scannedValue: StatusValue;
  confidence: number | null;
  lowConfidence: boolean;
  quote: string | null;
  sourceUrl: string | null;
  changedAt: string | null;
  override: { value: StatusValue; note: string | null; userName: string | null; at: string } | null;
  /** The competitor's product/module that ships this capability, as the pages name it. */
  product: string | null;
  /** Earlier values of the cell, newest first. */
  history: { value: StatusValue; quote: string | null; sourceUrl: string | null; at: string }[];
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
  changedAt: string;
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
  config: CompetitorsConfig;
  productLines: string[];
  competitors: CompetitorRow[];
  domains: DomainRow[];
  capabilities: CapabilityRow[];
  cells: CellRow[];
  facts: FactRow[];
  /** Most recent finished scan across the workspace (header "scanned X ago"). */
  lastScanAt: string | null;
  scanning: boolean;
  /** False in local dev: Scan now is never limited there. */
  rescanLimitEnforced: boolean;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function getCompetitorsState(workspaceId: string, orgName: string): Promise<CompetitorsState> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const [workspace, productLines, competitors, domains, capabilities, statuses, facts, activeScans, recentScans] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, select: { competitorsConfig: true } }),
    db.productLine.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true } }),
    db.competitor.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: {
        sources: { orderBy: { createdAt: "asc" } },
        media: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
    }),
    db.competitorDomain.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capability.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capabilityStatus.findMany({ where: { workspaceId }, include: { history: { orderBy: { at: "desc" }, take: 10 } } }),
    db.profileFact.findMany({ where: { workspaceId, dismissedAt: null }, orderBy: [{ kind: "asc" }, { value: "asc" }] }),
    db.competitorScan.findMany({
      where: { workspaceId, status: { in: ["queued", "running"] } },
      select: { id: true, sourceId: true },
    }),
    // Finished scans, newest first — the badge, the staleness horizon and today's manual count come from here.
    db.competitorScan.findMany({
      where: { workspaceId, status: { in: ["ok", "partial", "failed"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true, sourceId: true, badge: true, trigger: true, startedAt: true, pagesFetched: true, pages: true, outcomes: true, robotsDisallowed: true, removedPages: true, error: true },
    }),
  ]);
  const scansBySource = new Map<string, typeof recentScans>();
  const sourceOfScan = new Map<string, string>();
  for (const s of recentScans) {
    const list = scansBySource.get(s.sourceId) ?? [];
    list.push(s);
    scansBySource.set(s.sourceId, list);
    sourceOfScan.set(s.id, s.sourceId);
  }
  const asRecord = (v: unknown): Record<string, number> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {});

  const userIds = new Set<string>();
  for (const s of statuses) if (s.overrideUserId) userIds.add(s.overrideUserId);
  for (const f of facts) if (f.overrideUserId) userIds.add(f.overrideUserId);
  const users = userIds.size
    ? await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true } })
    : [];
  const userName = (id: string | null) => {
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u ? u.name || u.email : null;
  };
  const activeBySource = new Map(activeScans.map((s) => [s.sourceId, s.id]));

  let lastScanAt: Date | null = null;
  for (const c of competitors) {
    for (const s of c.sources) {
      if (s.lastScanAt && (!lastScanAt || s.lastScanAt > lastScanAt)) lastScanAt = s.lastScanAt;
    }
  }

  return {
    orgName,
    config: mergeCompetitorsConfig(workspace?.competitorsConfig),
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
          ? { id: website.id, lastScanAt: website.lastScanAt?.toISOString() ?? null, lastStatus: website.lastStatus, lastError: website.lastError }
          : null,
        sources: [...c.sources]
          .sort((a, b) => (a.type === "website" ? -1 : b.type === "website" ? 1 : 0))
          .map((s) => {
            const sl = scansBySource.get(s.id)?.[0];
            return { id: s.id, type: s.type, url: s.url, lastScanAt: s.lastScanAt?.toISOString() ?? null, lastStatus: s.lastStatus, lastError: s.lastError, pages: sl?.pagesFetched ?? 0, badge: (sl?.badge as ScanBadge | null) ?? null };
          }),
        lastScan: last
          ? (() => {
              const pages = Array.isArray(last.pages) ? (last.pages as { outcome?: string }[]) : [];
              return {
                id: last.id,
                badge: (last.badge as ScanBadge | null) ?? null,
                startedAt: last.startedAt.toISOString(),
                pagesFetched: last.pagesFetched,
                pagesSkipped: pages.filter((p) => p.outcome === "failed" || p.outcome === "skipped").length + Object.entries(asRecord(last.outcomes)).filter(([k]) => k === "robots" || k === "policy" || k === "cap").reduce((n, [, v]) => n + v, 0),
                outcomes: asRecord(last.outcomes),
                robotsDisallowed: asStringArray(last.robotsDisallowed),
                removedPages: asStringArray(last.removedPages).length,
                error: last.error,
              };
            })()
          : null,
        lastGoodScanAt: websiteScans.find((s) => s.badge === "full" || s.badge === "incomplete")?.startedAt.toISOString() ?? null,
        lastAnyScanAt: lastAny?.toISOString() ?? null,
        manualScansToday: website ? websiteScans.filter((s) => s.trigger === "manual" && s.startedAt >= dayStart).length + (activeBySource.has(website.id) ? 1 : 0) : 0,
        activeScanId: website ? activeBySource.get(website.id) ?? null : null,
        media: c.media.map((m) => ({ id: m.id, label: m.label, kind: m.kind, mediaPath: m.mediaPath, sourceLabel: m.sourceLabel, capturedAt: m.capturedAt?.toISOString() ?? null })),
      };
    }),
    domains: domains.map((d) => ({ id: d.id, name: d.name, description: d.description, color: d.color, position: d.position })),
    capabilities: capabilities.map((k) => ({
      id: k.id,
      domainId: k.domainId,
      name: k.name,
      description: k.description,
      productLines: asStringArray(k.productLines),
      ourStatus: (k.ourStatus === "partial" || k.ourStatus === "missing" ? k.ourStatus : "has") as StatusValue,
      position: k.position,
      origin: k.origin,
      state: k.state,
      suggestedById: k.suggestedById,
      suggestedQuote: k.suggestedQuote,
    })),
    cells: statuses.map((s) => {
      const scanned = s.value as StatusValue;
      const ov = s.overrideValue as StatusValue | null;
      return {
        id: s.id,
        competitorId: s.competitorId,
        capabilityId: s.capabilityId,
        value: ov ?? scanned,
        scannedValue: scanned,
        confidence: s.confidence,
        lowConfidence: !ov && s.confidence != null && s.confidence < LOW_CONFIDENCE && (scanned === "has" || scanned === "partial"),
        quote: s.quote,
        sourceUrl: s.sourceUrl,
        changedAt: s.changedAt?.toISOString() ?? null,
        override: ov && s.overrideAt ? { value: ov, note: s.overrideNote, userName: userName(s.overrideUserId), at: s.overrideAt.toISOString() } : null,
        product: s.product,
        history: s.history.map((h) => ({ value: h.value as StatusValue, quote: h.quote, sourceUrl: h.sourceUrl, at: h.at.toISOString() })),
      };
    }),
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
        changedAt: f.changedAt.toISOString(),
        manual: f.manual,
        stale,
        unreachable: f.unreachableAt != null,
        override: f.overrideValue && f.overrideAt ? { value: f.overrideValue, userName: userName(f.overrideUserId), at: f.overrideAt.toISOString() } : null,
      };
    }),
    lastScanAt: lastScanAt?.toISOString() ?? null,
    scanning: activeScans.length > 0,
    rescanLimitEnforced: rescanLimitEnforced(),
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

/** Next free position at the end of a list. */
export async function nextPosition(model: "competitor" | "competitorDomain" | "capability", workspaceId: string): Promise<number> {
  const agg =
    model === "competitor"
      ? await db.competitor.aggregate({ where: { workspaceId }, _max: { position: true } })
      : model === "competitorDomain"
        ? await db.competitorDomain.aggregate({ where: { workspaceId }, _max: { position: true } })
        : await db.capability.aggregate({ where: { workspaceId }, _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}
