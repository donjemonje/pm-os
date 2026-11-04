import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { getGlobalScanSettings } from "@/lib/competitors/settings";

/**
 * Every organization's competitor scans, newest first — PM-OS Admin's view of
 * the scanner's health (Admin → Competitors). Read-only; no usage events.
 */
export interface AdminScanRow {
  id: string;
  orgName: string;
  competitorName: string;
  url: string;
  trigger: string;
  status: string;
  /** remote | local | bundle — admin only. */
  lane: string;
  fetchMode: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  pagesFetched: number;
  pagesChanged: number;
  pagesNotAttempted: number;
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
  aiCalls: number;
  errorKind: string | null;
  error: string | null;
  badge: string | null;
  outcomes: Record<string, number>;
  robotsDisallowed: string[];
  removedPages: string[];
  piiHits: number;
  pages: unknown;
  log: unknown;
}

/** Internal-only health numbers (scanner rules, "internal only"). */
export interface AdminScanMetrics {
  /** Per registrable host, last 30 days: scans, blocked/unreachable count, pages requested, PII hits. */
  domains: { host: string; orgName: string; scans: number; blocked: number; pagesRequested: number; piiHits: number; lastBadge: string | null; lastScanAt: string }[];
  /** Pages requested per day, last 14 days, all domains. */
  requestsPerDay: { day: string; requests: number }[];
  piiHitsTotal: number;
  /** Page texts older than the retention window still holding text — should be 0 when cleanup runs. */
  textsPastRetention: number;
}

export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 60) || 60));
  const scans = await db.competitorScan.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    include: {
      source: { include: { competitor: { select: { name: true, workspace: { select: { organization: { select: { name: true } } } } } } } },
    },
  });
  const rows: AdminScanRow[] = scans.map((s) => ({
    id: s.id,
    orgName: s.source.competitor.workspace.organization.name,
    competitorName: s.source.competitor.name,
    url: s.source.url,
    trigger: s.trigger,
    status: s.status,
    lane: s.lane,
    fetchMode: s.fetchMode,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
    pagesFetched: s.pagesFetched,
    pagesChanged: s.pagesChanged,
    pagesNotAttempted: s.pagesNotAttempted,
    statusesChanged: s.statusesChanged,
    factsChanged: s.factsChanged,
    suggestions: s.suggestions,
    aiCalls: s.aiCalls,
    errorKind: s.errorKind,
    error: s.error,
    badge: s.badge,
    outcomes: (s.outcomes && typeof s.outcomes === "object" && !Array.isArray(s.outcomes) ? s.outcomes : {}) as Record<string, number>,
    robotsDisallowed: Array.isArray(s.robotsDisallowed) ? (s.robotsDisallowed as string[]) : [],
    removedPages: Array.isArray(s.removedPages) ? (s.removedPages as string[]) : [],
    piiHits: s.piiHits,
    pages: s.pages,
    log: s.log,
  }));
  return NextResponse.json({ scans: rows, metrics: await metrics() });
}

async function metrics(): Promise<AdminScanMetrics> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const finished = await db.competitorScan.findMany({
    where: { startedAt: { gte: since }, status: { in: ["ok", "partial", "failed", "stale"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, badge: true, pages: true, piiHits: true, source: { select: { competitor: { select: { host: true, workspace: { select: { organization: { select: { name: true } } } } } } } } },
  });
  const byHost = new Map<string, AdminScanMetrics["domains"][number]>();
  const byDay = new Map<string, number>();
  let piiHitsTotal = 0;
  for (const s of finished) {
    const host = s.source.competitor.host;
    const requested = Array.isArray(s.pages) ? (s.pages as { outcome?: string }[]).filter((p) => p.outcome !== "skipped").length : 0;
    const row = byHost.get(host) ?? { host, orgName: s.source.competitor.workspace.organization.name, scans: 0, blocked: 0, pagesRequested: 0, piiHits: 0, lastBadge: s.badge, lastScanAt: s.startedAt.toISOString() };
    row.scans++;
    if (s.badge === "blocked" || s.badge === "unreachable") row.blocked++;
    row.pagesRequested += requested;
    row.piiHits += s.piiHits;
    byHost.set(host, row);
    const day = s.startedAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + requested);
    piiHitsTotal += s.piiHits;
  }
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  // Superseded page texts past the retention window still holding text — should be 0 when the tick's retention ran.
  const { retentionDays } = await getGlobalScanSettings();
  const textsPastRetention = await db.sourcePageVersion.count({ where: { supersededAt: { lt: new Date(Date.now() - retentionDays * 86_400_000) }, text: { not: null } } });
  return {
    domains: [...byHost.values()].sort((a, b) => b.blocked - a.blocked || b.scans - a.scans),
    requestsPerDay: [...byDay.entries()].filter(([d]) => d >= cutoff).sort(([a], [b]) => a.localeCompare(b)).map(([day, requests]) => ({ day, requests })),
    piiHitsTotal,
    textsPastRetention,
  };
}
