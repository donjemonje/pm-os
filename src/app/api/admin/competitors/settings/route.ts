import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { ANALYSIS_TOKEN_BUDGET_DEFAULT, ANALYSIS_TOKEN_BUDGET_MAX, ANALYSIS_TOKEN_BUDGET_MIN, checkAnalysisTokenBudget } from "@/lib/competitors/analysis/budget";
import { checkReadSetting, READ_DEFAULTS, READ_KIND_TEXT, READ_KINDS, readsLine, type ReadKind, type ReadSetting } from "@/lib/competitors/analysis/reads";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { isScannedSource } from "@/lib/competitors/addresses";
import { ADDRESS_KINDS, MAX_SCAN_EVERY_DAYS, MIN_SCAN_EVERY_DAYS } from "@/lib/competitors/config";
import { listScannerKeys } from "@/lib/competitors/local";
import { analysisReads, getGlobalScanSettings, setAnalysisReads, setGlobalScanSettings, testKnobsEnabled } from "@/lib/competitors/settings";

/**
 * Administration → Competitors → Scanning (PM-OS admin only). The global
 * switches of the Website Scanning story and every source's frequency:
 *
 *   GET   → { settings: { remoteScanEnabled, analysisDisabled, analysisTokenBudget }, budgetLimits, reads, keys, sources, testKnobs }
 *   PATCH { remoteScanEnabled?, analysisDisabled? }        → the switches
 *   PATCH { analysisReads: { <kind>: true | false, … } }   → "What the analysis reads": one switch per kind of content,
 *                                                            for the installation (analysis/reads.ts). The kinds not
 *                                                            named keep what they have. Nothing is deleted either way.
 *   PATCH { analysisTokenBudget }                          → the token budget of one analysis run of one competitor
 *                                                            (a whole number between the limits; analysis/budget.ts)
 *   PATCH { sourceId, scanEveryDays }                      → one source's frequency (days)
 */
/** "What the analysis reads" as the screen shows it: every kind with its label, its help line, whether it is on and its default. */
export interface AdminReads {
  kinds: Array<{ kind: ReadKind; label: string; help: string; on: boolean; default: boolean }>;
  /** "Reading: product, pricing, … — not read: help center, blog and news" */
  line: string;
}

function readsView(setting: ReadSetting): AdminReads {
  return { kinds: READ_KINDS.map((kind) => ({ kind, label: READ_KIND_TEXT[kind].label, help: READ_KIND_TEXT[kind].help, on: setting[kind], default: READ_DEFAULTS[kind] })), line: readsLine(setting) };
}

export interface AdminSourceRow {
  id: string;
  orgName: string;
  competitorName: string;
  url: string;
  /** website, or the kind of one of the company's other addresses: helpcenter | apidocs | changelog. */
  type: string;
  scanEveryDays: number;
  lastScanAt: string | null;
  lastStatus: string;
  /** Scan waiting for the local lane, if any. */
  pendingSince: string | null;
}

async function sources(): Promise<AdminSourceRow[]> {
  // Every source the scanner crawls: the websites, and each company's other addresses under its website (addresses.ts).
  const rows = (
    await db.competitorSource.findMany({
      where: { type: { in: ["website", ...ADDRESS_KINDS] }, competitor: { deletedAt: null } },
      include: {
        competitor: { select: { name: true, host: true, isOwn: true, workspace: { select: { organization: { select: { name: true } } } } } },
        localRequests: { where: { state: { in: ["waiting", "running"] } }, select: { createdAt: true }, take: 1 },
      },
      orderBy: [{ competitor: { workspace: { organization: { name: "asc" } } } }, { competitor: { name: "asc" } }, { createdAt: "asc" }],
    })
  ).filter((s) => isScannedSource(s, s.competitor.host));
  return rows.map((s) => ({
    id: s.id,
    orgName: s.competitor.workspace.organization.name,
    // The organization's own site is scanned on a schedule like a competitor's (own.ts); the list says which it is.
    competitorName: s.competitor.isOwn ? `${s.competitor.name} — own site` : s.competitor.name,
    url: s.url,
    type: s.type,
    scanEveryDays: s.scanEveryDays,
    lastScanAt: s.lastScanAt?.toISOString() ?? null,
    lastStatus: s.lastStatus,
    pendingSince: s.localRequests[0]?.createdAt.toISOString() ?? null,
  }));
}

async function payload() {
  const [settings, keys, src, reads] = await Promise.all([getGlobalScanSettings(), listScannerKeys(), sources(), analysisReads()]);
  return { settings, reads: readsView(reads), budgetLimits: { min: ANALYSIS_TOKEN_BUDGET_MIN, max: ANALYSIS_TOKEN_BUDGET_MAX, default: ANALYSIS_TOKEN_BUDGET_DEFAULT }, keys, sources: src, testKnobs: testKnobsEnabled() };
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
    const r = await db.competitorSource.updateMany({ where: { id: body.sourceId, type: { in: ["website", ...ADDRESS_KINDS] } }, data: { scanEveryDays: n } });
    if (!r.count) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(await payload());
  }
  if (body.analysisReads !== undefined) {
    const checked = checkReadSetting(body.analysisReads);
    if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
    const { before, after } = await setAnalysisReads(checked.value);
    // Recorded like the token budget: the setting is the installation's, the event sits on the admin's workspace.
    const changed = READ_KINDS.filter((k) => before[k] !== after[k]);
    if (changed.length && admin.workspaceId) {
      await recordCompetitorEvent(admin.workspaceId, admin.id, "cmp_settings_changed", { setting: "analysisReads", scope: "installation", from: readsLine(before), to: readsLine(after), turnedOn: changed.filter((k) => after[k]).join(","), turnedOff: changed.filter((k) => !after[k]).join(",") });
    }
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
