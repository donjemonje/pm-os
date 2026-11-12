import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { ANALYSIS_TOKEN_BUDGET_DEFAULT, ANALYSIS_TOKEN_BUDGET_MAX, ANALYSIS_TOKEN_BUDGET_MIN, checkAnalysisTokenBudget } from "@/lib/competitors/analysis/budget";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { MAX_SCAN_EVERY_DAYS, MIN_SCAN_EVERY_DAYS } from "@/lib/competitors/config";
import { listScannerKeys } from "@/lib/competitors/local";
import { getGlobalScanSettings, setGlobalScanSettings, testKnobsEnabled } from "@/lib/competitors/settings";

/**
 * Administration → Competitors → Scanning (PM-OS admin only). The global
 * switches of the Website Scanning story and every source's frequency:
 *
 *   GET   → { settings: { remoteScanEnabled, analysisDisabled, analysisTokenBudget }, budgetLimits, keys, sources, testKnobs }
 *   PATCH { remoteScanEnabled?, analysisDisabled? }        → the switches
 *   PATCH { analysisTokenBudget }                          → the token budget of one analysis run of one competitor
 *                                                            (a whole number between the limits; analysis/budget.ts)
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
  return { settings, budgetLimits: { min: ANALYSIS_TOKEN_BUDGET_MIN, max: ANALYSIS_TOKEN_BUDGET_MAX, default: ANALYSIS_TOKEN_BUDGET_DEFAULT }, keys, sources: src, testKnobs: testKnobsEnabled() };
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
  const patch: { remoteScanEnabled?: boolean; analysisDisabled?: boolean; analysisTokenBudget?: number } = {};
  if (body.analysisTokenBudget !== undefined) {
    const checked = checkAnalysisTokenBudget(body.analysisTokenBudget);
    if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
    patch.analysisTokenBudget = checked.value;
  }
  if (body.analysisDisabled !== undefined) {
    if (typeof body.analysisDisabled !== "boolean") return NextResponse.json({ error: "analysisDisabled must be true or false" }, { status: 400 });
    patch.analysisDisabled = body.analysisDisabled;
  }
  if (body.remoteScanEnabled !== undefined) {
    if (typeof body.remoteScanEnabled !== "boolean") return NextResponse.json({ error: "remoteScanEnabled must be true or false" }, { status: 400 });
    patch.remoteScanEnabled = body.remoteScanEnabled;
  }
  const before = patch.analysisTokenBudget !== undefined ? (await getGlobalScanSettings()).analysisTokenBudget : null;
  await setGlobalScanSettings(patch);
  // Recorded like a workspace's own settings (cmp_settings_changed: setting, from, to), on the admin's workspace —
  // the setting is the installation's, an event needs a workspace. An admin with no workspace leaves no event.
  if (patch.analysisTokenBudget !== undefined && before !== patch.analysisTokenBudget && admin.workspaceId) {
    await recordCompetitorEvent(admin.workspaceId, admin.id, "cmp_settings_changed", { setting: "analysisTokenBudget", scope: "installation", from: before, to: patch.analysisTokenBudget });
  }
  return NextResponse.json(await payload());
}
