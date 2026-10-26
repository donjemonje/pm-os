import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { LOW_CONFIDENCE, mergeCompetitorsConfig, type CompetitorsConfig, type StatusValue } from "./config";

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
  /** Scan currently queued or running, if any. */
  activeScanId: string | null;
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
}

export interface FactRow {
  id: string;
  competitorId: string;
  kind: string;
  value: string;
  sourceUrl: string | null;
  changedAt: string;
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
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function getCompetitorsState(workspaceId: string, orgName: string): Promise<CompetitorsState> {
  const [workspace, productLines, competitors, domains, capabilities, statuses, facts, activeScans] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, select: { competitorsConfig: true } }),
    db.productLine.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true } }),
    db.competitor.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: { sources: { where: { type: "website" }, take: 1 } },
    }),
    db.competitorDomain.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capability.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.capabilityStatus.findMany({ where: { workspaceId } }),
    db.profileFact.findMany({ where: { workspaceId, dismissedAt: null }, orderBy: [{ kind: "asc" }, { value: "asc" }] }),
    db.competitorScan.findMany({
      where: { workspaceId, status: { in: ["queued", "running"] } },
      select: { id: true, sourceId: true },
    }),
  ]);

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
      activeScanId: c.sources[0] ? activeBySource.get(c.sources[0].id) ?? null : null,
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
      };
    }),
    facts: facts.map((f) => ({
      id: f.id,
      competitorId: f.competitorId,
      kind: f.kind,
      value: f.overrideValue ?? f.value,
      sourceUrl: f.sourceUrl,
      changedAt: f.changedAt.toISOString(),
      override: f.overrideValue && f.overrideAt ? { value: f.overrideValue, userName: userName(f.overrideUserId), at: f.overrideAt.toISOString() } : null,
    })),
    lastScanAt: lastScanAt?.toISOString() ?? null,
    scanning: activeScans.length > 0,
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
