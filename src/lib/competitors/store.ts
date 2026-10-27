import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { LOW_CONFIDENCE, mergeCompetitorsConfig, rescanLimitEnforced, STALE_AFTER_SCANS, type CompetitorsConfig, type ScanBadge, type StatusValue } from "./config";


/**
 * Reads for the Competitors pages — one query set, returned in the shape the
 * client renders — plus the small helpers the API routes share. Every query
 * is scoped by workspaceId.
 */

export interface CompetitorRow {
  id: string;
  name: string;
  websiteUrl: string;
  host: string;
  logoUrl: string | null;
  position: number;
  source: {
    id: string;
    lastScanAt: string | null;
    lastStatus: string;
    lastError: string | null;
  } | null;
  /** The last finished scan, as users see it. */
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
  /** The last scan that ended "full" or "incomplete" — what the matrix shows when the latest is blocked. */
  lastGoodScanAt: string | null;
  /** Manual scans started today (the per-day limit applies to these). */
  manualScansToday: number;
  /** Scan currently queued or running, if any. */
  activeScanId: string | null;
  profile: ProfileRow | null;
  events: EventRow[];
  products: ProductRow[];
  people: PeopleRow | null;
  media: MediaRow[];
  /** What changed in the last 30 days (the news feed's rows, story 3). */
  signals: SignalRow[];
}

export interface ProfileRow {
  ownership: string | null;
  hq: string | null;
  foundedYear: number | null;
  headcount: string | null;
  tags: { label: string; kind: "int" | "pos" | "gtm" }[];
  risk: { score: number; level: "high" | "medium" | "low"; note: string | null } | null;
  sourcesSummary: { label: string; n: number | string }[];
  lastFullScanAt: string | null;
}
export interface EventRow {
  id: string;
  date: string;
  title: string;
  type: "company" | "funding" | "domain" | "capability" | "hr" | "website";
  projected: boolean;
  confidence: number | null;
  sourceUrl: string | null;
}
export interface ProductRow { id: string; code: string; name: string; since: string | null; tier: string | null; position: number }
export interface PeopleRow { windowLabel: string; hires: { team: string; n: number }[]; leftCount: number | null; leftNote: string | null; leadership: string | null }
export interface MediaRow { id: string; label: string; kind: string | null; mediaPath: string; sourceLabel: string | null; capturedAt: string | null }
export interface SignalRow { id: string; kind: string; title: string; source: string; sourceUrl: string | null; impact: "high" | "medium" | "low"; at: string }
export interface InsightRow {
  summary: string | null;
  summarySource: string | null;
  sources: { label: string; tone?: "int" | "pos" | "gtm" }[];
  scope: string | null;
  packaging: string | null;
  confidenceNote: string | null;
  media: { label: string; kind: string; caption: string; mediaPath?: string }[];
  evidence: { kind: string; kindTone?: "int" | "pos" | "gtm"; text: string; date: string }[];
  riskLevel: "high" | "medium" | "low" | null;
  riskText: string | null;
  differentiation: string | null;
  ideaTitle: string | null;
  evidenceCount: number | null;
}

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
  /** The competitor's product this capability ships in (profile grouping). */
  productId: string | null;
  insight: InsightRow | null;
}

export interface FactRow {
  id: string;
  competitorId: string;
  kind: string;
  value: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
  tone: string | null;
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

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
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
        sources: { where: { type: "website" }, take: 1 },
        profile: true,
        events: { orderBy: { date: "asc" } },
        products: { orderBy: [{ position: "asc" }, { name: "asc" }] },
        people: true,
        media: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
        signals: { where: { at: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { at: "desc" }, take: 20 },
      },
    }),
    db.competitorDomain.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capability.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capabilityStatus.findMany({ where: { workspaceId }, include: { insight: true } }),
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
  for (const s of recentScans) {
    const list = scansBySource.get(s.sourceId) ?? [];
    list.push(s);
    scansBySource.set(s.sourceId, list);
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
    const at = c.sources[0]?.lastScanAt ?? null;
    if (at && (!lastScanAt || at > lastScanAt)) lastScanAt = at;
  }

  return {
    orgName,
    config: mergeCompetitorsConfig(workspace?.competitorsConfig),
    productLines: productLines.map((p) => p.name),
    competitors: competitors.map((c) => ({
      id: c.id,
      name: c.name,
      websiteUrl: c.websiteUrl,
      host: c.host,
      logoUrl: c.logoUrl,
      position: c.position,
      source: c.sources[0]
        ? {
            id: c.sources[0].id,
            lastScanAt: c.sources[0].lastScanAt?.toISOString() ?? null,
            lastStatus: c.sources[0].lastStatus,
            lastError: c.sources[0].lastError,
          }
        : null,
      lastScan: (() => {
        const s = c.sources[0] ? scansBySource.get(c.sources[0].id)?.[0] : undefined;
        if (!s) return null;
        const pages = Array.isArray(s.pages) ? (s.pages as { outcome?: string }[]) : [];
        return {
          id: s.id,
          badge: (s.badge as ScanBadge | null) ?? null,
          startedAt: s.startedAt.toISOString(),
          pagesFetched: s.pagesFetched,
          pagesSkipped: pages.filter((p) => p.outcome === "failed" || p.outcome === "skipped").length + Object.entries(asRecord(s.outcomes)).filter(([k]) => k === "robots" || k === "policy" || k === "cap").reduce((n, [, v]) => n + v, 0),
          outcomes: asRecord(s.outcomes),
          robotsDisallowed: asStringArray(s.robotsDisallowed),
          removedPages: asStringArray(s.removedPages).length,
          error: s.error,
        };
      })(),
      lastGoodScanAt: c.sources[0] ? scansBySource.get(c.sources[0].id)?.find((s) => s.badge === "full" || s.badge === "incomplete")?.startedAt.toISOString() ?? null : null,
      manualScansToday: c.sources[0] ? (scansBySource.get(c.sources[0].id) ?? []).filter((s) => s.trigger === "manual" && s.startedAt >= dayStart).length + (activeBySource.has(c.sources[0].id) ? 1 : 0) : 0,
      activeScanId: c.sources[0] ? activeBySource.get(c.sources[0].id) ?? null : null,
      profile: c.profile
        ? {
            ownership: c.profile.ownership,
            hq: c.profile.hq,
            foundedYear: c.profile.foundedYear,
            headcount: c.profile.headcount,
            tags: asArray<{ label: string; kind: "int" | "pos" | "gtm" }>(c.profile.tags),
            risk: c.profile.riskScore != null && (c.profile.riskLevel === "high" || c.profile.riskLevel === "medium" || c.profile.riskLevel === "low")
              ? { score: c.profile.riskScore, level: c.profile.riskLevel, note: c.profile.riskNote }
              : null,
            sourcesSummary: asArray<{ label: string; n: number | string }>(c.profile.sourcesSummary),
            lastFullScanAt: c.profile.lastFullScanAt?.toISOString() ?? null,
          }
        : null,
      events: c.events.map((e) => ({ id: e.id, date: e.date.toISOString(), title: e.title, type: e.type as EventRow["type"], projected: e.projected, confidence: e.confidence, sourceUrl: e.sourceUrl })),
      products: c.products.map((p) => ({ id: p.id, code: p.code, name: p.name, since: p.since, tier: p.tier, position: p.position })),
      people: c.people ? { windowLabel: c.people.windowLabel, hires: asArray<{ team: string; n: number }>(c.people.hires), leftCount: c.people.leftCount, leftNote: c.people.leftNote, leadership: c.people.leadership } : null,
      media: c.media.map((m) => ({ id: m.id, label: m.label, kind: m.kind, mediaPath: m.mediaPath, sourceLabel: m.sourceLabel, capturedAt: m.capturedAt?.toISOString() ?? null })),
      signals: c.signals.map((g) => ({ id: g.id, kind: g.kind, title: g.title, source: g.source, sourceUrl: g.sourceUrl, impact: (g.impact === "high" || g.impact === "low" ? g.impact : "medium") as SignalRow["impact"], at: g.at.toISOString() })),
    })),
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
        productId: s.productId,
        insight: s.insight
          ? {
              summary: s.insight.summary,
              summarySource: s.insight.summarySource,
              sources: asArray<InsightRow["sources"][number]>(s.insight.sources),
              scope: s.insight.scope,
              packaging: s.insight.packaging,
              confidenceNote: s.insight.confidenceNote,
              media: asArray<InsightRow["media"][number]>(s.insight.media),
              evidence: asArray<InsightRow["evidence"][number]>(s.insight.evidence),
              riskLevel: (s.insight.riskLevel === "high" || s.insight.riskLevel === "medium" || s.insight.riskLevel === "low" ? s.insight.riskLevel : null),
              riskText: s.insight.riskText,
              differentiation: s.insight.differentiation,
              ideaTitle: s.insight.ideaTitle,
              evidenceCount: s.insight.evidenceCount,
            }
          : null,
      };
    }),
    facts: facts.map((f) => {
      // Stale = the site's last STALE_AFTER_SCANS finished scans all missed it.
      const sourceId = competitors.find((c) => c.id === f.competitorId)?.sources[0]?.id;
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
