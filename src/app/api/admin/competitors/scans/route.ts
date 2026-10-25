import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";

/**
 * Every organization's competitor scans, newest first — PM-OS Admin's view of
 * the scanner's health (Admin → Competitors). Read-only; no usage events.
 */
export interface AdminScanRow {
  id: string;
  orgName: string;
  competitorName: string;
  isSelf: boolean;
  url: string;
  trigger: string;
  status: string;
  fetchMode: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  pagesFetched: number;
  pagesChanged: number;
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
  aiCalls: number;
  errorKind: string | null;
  error: string | null;
  pages: unknown;
  log: unknown;
}

export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 60) || 60));
  const scans = await db.competitorScan.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    include: {
      source: { include: { competitor: { select: { name: true, isSelf: true, workspace: { select: { organization: { select: { name: true } } } } } } } },
    },
  });
  const rows: AdminScanRow[] = scans.map((s) => ({
    id: s.id,
    orgName: s.source.competitor.workspace.organization.name,
    competitorName: s.source.competitor.name,
    isSelf: s.source.competitor.isSelf,
    url: s.source.url,
    trigger: s.trigger,
    status: s.status,
    fetchMode: s.fetchMode,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
    pagesFetched: s.pagesFetched,
    pagesChanged: s.pagesChanged,
    statusesChanged: s.statusesChanged,
    factsChanged: s.factsChanged,
    suggestions: s.suggestions,
    aiCalls: s.aiCalls,
    errorKind: s.errorKind,
    error: s.error,
    pages: s.pages,
    log: s.log,
  }));
  return NextResponse.json({ scans: rows });
}
