/**
 * The news feed — the archive of what scans found, item by item, newest
 * first: a status that moved (a gap when the org lacks it), a new dated fact,
 * a capability or domain a scan suggested. Derived from the pipeline's rows
 * (CapabilityStatus + history, ProfileFact, Capability), never stored twice.
 * Items dated before the workspace's `baselineUntil` are history, not news:
 * what the set-up imports brought in is the starting picture, and only what
 * scans find from then on is new. Read state is per user (CompetitorFeedRead).
 */
import { db } from "../db";
import type { OwnStatus, StatusValue } from "./config";

export type FeedKind = "gap" | "raised" | "lowered" | "fact" | "suggestion";
export type FeedImpact = "High" | "Medium" | "Low";

export interface FeedItem {
  /** kind:rowId:timestamp — the read-state key. */
  key: string;
  kind: FeedKind;
  impact: FeedImpact;
  at: string;
  competitorId: string;
  competitorName: string;
  /** Capability name, fact value or suggested name. */
  title: string;
  domain: string | null;
  capabilityId: string | null;
  from: StatusValue | null;
  to: StatusValue | null;
  own: OwnStatus | null;
  factKind: string | null;
  factDate: string | null;
  product: string | null;
  quote: string | null;
  sourceUrl: string | null;
  /** The source type the finding came from (website, press, …), when known. */
  sourceType: string | null;
  /** For suggestions: suggested | active (accepted) | dismissed. */
  suggestionState: string | null;
  /** The suggestion's domain was itself proposed by the scan. */
  newDomain: boolean;
  read: boolean;
}

const RANK: Record<StatusValue, number> = { has: 3, partial: 2, missing: 1, unknown: 0 };

export function statusKind(from: StatusValue, to: StatusValue, own: OwnStatus): Exclude<FeedKind, "fact" | "suggestion"> | null {
  if (RANK[to] === RANK[from]) return null;
  if (RANK[to] < RANK[from]) return "lowered";
  return own === "missing" && (to === "has" || to === "partial") ? "gap" : "raised";
}

export function impactOf(kind: FeedKind): FeedImpact {
  return kind === "gap" ? "High" : kind === "raised" || kind === "lowered" ? "Medium" : "Low";
}

export const FEED_LIMIT = 500;

/** Every news item of the workspace since the baseline, newest first, with the user's read marks. */
export async function collectFeed(workspaceId: string, baselineUntil: string | null, userId: string | null): Promise<FeedItem[]> {
  const since = baselineUntil ? new Date(baselineUntil) : null;
  const after = since ? { gt: since } : { not: null as unknown as Date };
  const [statuses, facts, suggestions, competitors, reads] = await Promise.all([
    db.capabilityStatus.findMany({
      where: { workspaceId, changedAt: since ? { gt: since } : { not: null } },
      orderBy: { changedAt: "desc" },
      take: FEED_LIMIT,
      include: {
        capability: { select: { name: true, ourStatus: true, domain: { select: { name: true } } } },
        history: { orderBy: { at: "desc" }, take: 8 },
      },
    }),
    db.profileFact.findMany({
      where: { workspaceId, dismissedAt: null, changedAt: since ? { gt: since } : { not: null } },
      orderBy: { changedAt: "desc" },
      take: FEED_LIMIT,
    }),
    db.capability.findMany({
      where: { workspaceId, origin: "ai", suggestedById: { not: null }, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "desc" },
      take: FEED_LIMIT,
      include: { domain: { select: { name: true, state: true } } },
    }),
    db.competitor.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
    userId ? db.competitorFeedRead.findMany({ where: { workspaceId, userId }, select: { key: true } }) : [],
  ]);
  void after;
  const nameOf = new Map(competitors.map((c) => [c.id, c.name]));
  const readKeys = new Set(reads.map((r) => r.key));
  const scanIds = [...new Set([...statuses.map((s) => s.scanId), ...facts.map((f) => f.scanId)].filter((id): id is string => Boolean(id)))];
  const scans = scanIds.length ? await db.competitorScan.findMany({ where: { id: { in: scanIds } }, select: { id: true, source: { select: { type: true } } } }) : [];
  const sourceTypeOf = new Map(scans.map((s) => [s.id, s.source.type]));

  const items: FeedItem[] = [];
  for (const s of statuses) {
    if (!s.changedAt) continue;
    const at = s.changedAt;
    // The value before the change: the newest history row written at (or just before) the change.
    const before = s.history.find((h) => h.at.getTime() <= at.getTime() + 2000) ?? s.history[0];
    if (!before) continue;
    const own = (s.capability.ourStatus === "partial" || s.capability.ourStatus === "missing" ? s.capability.ourStatus : "has") as OwnStatus;
    const kind = statusKind(before.value as StatusValue, s.value as StatusValue, own);
    if (!kind) continue;
    const key = `status:${s.id}:${at.getTime()}`;
    items.push({
      key, kind, impact: impactOf(kind), at: at.toISOString(),
      competitorId: s.competitorId, competitorName: nameOf.get(s.competitorId) ?? "",
      title: s.capability.name, domain: s.capability.domain.name, capabilityId: s.capabilityId,
      from: before.value as StatusValue, to: s.value as StatusValue, own,
      factKind: null, factDate: null, product: s.product, quote: s.quote, sourceUrl: s.sourceUrl,
      sourceType: s.scanId ? sourceTypeOf.get(s.scanId) ?? null : null, suggestionState: null, newDomain: false,
      read: readKeys.has(key),
    });
  }
  for (const f of facts) {
    if (!f.changedAt) continue;
    const key = `fact:${f.id}:${f.changedAt.getTime()}`;
    items.push({
      key, kind: "fact", impact: "Low", at: f.changedAt.toISOString(),
      competitorId: f.competitorId, competitorName: nameOf.get(f.competitorId) ?? "",
      title: f.overrideValue ?? f.value, domain: null, capabilityId: null, from: null, to: null, own: null,
      factKind: f.kind, factDate: f.factDate?.toISOString() ?? null, product: null, quote: null, sourceUrl: f.sourceUrl,
      sourceType: f.scanId ? sourceTypeOf.get(f.scanId) ?? null : null, suggestionState: null, newDomain: false,
      read: readKeys.has(key),
    });
  }
  for (const k of suggestions) {
    const key = `suggestion:${k.id}:${k.createdAt.getTime()}`;
    const m = k.suggestedQuote?.match(/^(.*?)\s—\s(https?:\/\/\S+)$/);
    items.push({
      key, kind: "suggestion", impact: "Low", at: k.createdAt.toISOString(),
      competitorId: k.suggestedById!, competitorName: nameOf.get(k.suggestedById!) ?? "",
      title: k.name, domain: k.domain.name, capabilityId: k.id, from: null, to: null, own: null,
      factKind: null, factDate: null, product: null, quote: m ? m[1] : k.suggestedQuote, sourceUrl: m ? m[2] : null,
      sourceType: null, suggestionState: k.state, newDomain: k.domain.state === "suggested",
      read: readKeys.has(key),
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return items.slice(0, FEED_LIMIT);
}
