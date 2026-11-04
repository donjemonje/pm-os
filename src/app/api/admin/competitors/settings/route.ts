import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { MAX_SCAN_EVERY_DAYS, MIN_SCAN_EVERY_DAYS } from "@/lib/competitors/config";
import { listScannerKeys } from "@/lib/competitors/local";
import { getGlobalScanSettings, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, setGlobalScanSettings, testKnobsEnabled } from "@/lib/competitors/settings";

/**
 * Administration → Competitors → Scanning (PM-OS admin only). The global
 * switches of the Website Scanning story and every source's frequency:
 *
 *   GET   → { settings: { remoteScanEnabled, retentionDays }, keys, sources, testKnobs }
 *   PATCH { remoteScanEnabled?, retentionDays? }           → the switches
 *   PATCH { sourceId, scanEveryDays }                      → one source's frequency (days)
 */
export interface AdminSourceRow {
  id: string;
  orgName: string;
  competitorName: string;
  url: string;
  scanEveryDays: number;
  lastScanAt: string | null;
  lastStatus: string;
  /** Scan waiting for the local lane, if any. */
  pendingSince: string | null;
}

async function sources(): Promise<AdminSourceRow[]> {
  const rows = await db.competitorSource.findMany({
    where: { type: "website", competitor: { deletedAt: null } },
    include: {
      competitor: { select: { name: true, workspace: { select: { organization: { select: { name: true } } } } } },
      localRequests: { where: { state: { in: ["waiting", "running"] } }, select: { createdAt: true }, take: 1 },
    },
    orderBy: [{ competitor: { workspace: { organization: { name: "asc" } } } }, { competitor: { name: "asc" } }],
  });
  return rows.map((s) => ({
    id: s.id,
    orgName: s.competitor.workspace.organization.name,
    competitorName: s.competitor.name,
    url: s.url,
    scanEveryDays: s.scanEveryDays,
    lastScanAt: s.lastScanAt?.toISOString() ?? null,
    lastStatus: s.lastStatus,
    pendingSince: s.localRequests[0]?.createdAt.toISOString() ?? null,
  }));
}

async function payload() {
  const [settings, keys, src] = await Promise.all([getGlobalScanSettings(), listScannerKeys(), sources()]);
  return { settings, keys, sources: src, testKnobs: testKnobsEnabled() };
}

export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json(await payload());
}

export async function PATCH(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.sourceId === "string") {
    const n = typeof body.scanEveryDays === "number" ? Math.round(body.scanEveryDays) : NaN;
    if (!Number.isFinite(n) || n < MIN_SCAN_EVERY_DAYS || n > MAX_SCAN_EVERY_DAYS) return NextResponse.json({ error: `Scan frequency must be between ${MIN_SCAN_EVERY_DAYS} and ${MAX_SCAN_EVERY_DAYS} days.` }, { status: 400 });
    const r = await db.competitorSource.updateMany({ where: { id: body.sourceId, type: "website" }, data: { scanEveryDays: n } });
    if (!r.count) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(await payload());
  }
  const patch: { remoteScanEnabled?: boolean; retentionDays?: number } = {};
  if (body.remoteScanEnabled !== undefined) {
    if (typeof body.remoteScanEnabled !== "boolean") return NextResponse.json({ error: "remoteScanEnabled must be true or false" }, { status: 400 });
    patch.remoteScanEnabled = body.remoteScanEnabled;
  }
  if (body.retentionDays !== undefined) {
    const n = typeof body.retentionDays === "number" ? Math.round(body.retentionDays) : NaN;
    if (!Number.isFinite(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) return NextResponse.json({ error: `Retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.` }, { status: 400 });
    patch.retentionDays = n;
  }
  await setGlobalScanSettings(patch);
  return NextResponse.json(await payload());
}
