/**
 * A scan run — the Scan button on the Competitors page (or a scheduled
 * round): every competitor scanned one after another, then ONE notification
 * email about what the run changed (lib/competitors/notify.ts).
 *
 * Mode (per organization, Admin → Enablements "Scan reads demo news"):
 * - live: the scanner crawls each competitor's website (createScan + runScan).
 * - bundle: each competitor's pages come from the collector bundle under
 *   COMPETITORS_BUNDLE_DIR/<host>/ (importPages + runScan) — the same hand-in
 *   the CLI `--import` uses; competitors without a bundle are not scanned.
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { envFeatureDefault, resolveFeature } from "../feature-flags";
import { recordCompetitorEvent } from "./analytics";
import { bundleForHost, hasBundleForHost } from "./bundle";
import { rescanLimitEnforced } from "./config";
import { importPages } from "./import";
import { notifyRun } from "./notify";
import { createScan, manualScansToday, runScan } from "./scan";
import { getCompetitorsConfig } from "./store";

export type RunMode = "live" | "bundle";

export async function runModeFor(workspaceId: string): Promise<RunMode> {
  const w = await db.workspace.findUnique({ where: { id: workspaceId }, select: { organization: { select: { features: true } } } });
  return resolveFeature(w?.organization.features, "competitorsDemoNews", envFeatureDefault("competitorsDemoNews")) ? "bundle" : "live";
}

interface PlanItem {
  competitorId: string;
  name: string;
  host: string;
}

/** Which competitors a run would scan, in matrix order, and which it leaves out (with the reason). */
async function planRun(workspaceId: string, mode: RunMode, opts: { exemptFromLimit: boolean }): Promise<{ plan: PlanItem[]; skipped: { name: string; reason: string }[] }> {
  const competitors = await db.competitor.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true, name: true, host: true, sources: { where: { type: "website" }, select: { id: true } } },
  });
  const plan: PlanItem[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const config = mode === "live" ? await getCompetitorsConfig(workspaceId) : null;
  for (const c of competitors) {
    if (mode === "bundle") {
      if (hasBundleForHost(c.host)) plan.push({ competitorId: c.id, name: c.name, host: c.host });
      else skipped.push({ name: c.name, reason: "no pages handed in" });
      continue;
    }
    const website = c.sources[0];
    if (!website) {
      skipped.push({ name: c.name, reason: "no website" });
      continue;
    }
    if (config && rescanLimitEnforced() && !opts.exemptFromLimit && (await manualScansToday(website.id)) >= config.manualRescansPerDay) {
      skipped.push({ name: c.name, reason: "daily manual scan limit" });
      continue;
    }
    plan.push({ competitorId: c.id, name: c.name, host: c.host });
  }
  return { plan, skipped };
}

export type StartRunResult = { runId: string; total: number; mode: RunMode } | { error: "running" | "nothing" };

/** Create the run (and, in live mode, its queued scans). The caller launches it with launchRun. */
export async function startRun(
  workspaceId: string,
  startedById: string | null,
  opts: { trigger: "manual" | "scheduled"; exemptFromLimit: boolean },
): Promise<StartRunResult> {
  const [activeScan, activeRun] = await Promise.all([
    db.competitorScan.findFirst({ where: { workspaceId, status: { in: ["queued", "running"] } }, select: { id: true } }),
    db.competitorScanRun.findFirst({ where: { workspaceId, status: "running" }, select: { id: true } }),
  ]);
  if (activeScan || activeRun) return { error: "running" };
  const mode = await runModeFor(workspaceId);
  if (mode === "bundle") {
    // Demo news: the prepared pages must read as new each time the button is pressed.
    const undone = await undoDemoRuns(workspaceId);
    if (undone.runs) await recordCompetitorEvent(workspaceId, startedById, "cmp_demo_reset", { runs: undone.runs, statuses: undone.statuses, facts: undone.facts, suggestions: undone.suggestions });
  }
  const { plan, skipped } = await planRun(workspaceId, mode, opts);
  if (plan.length === 0) return { error: "nothing" };
  const run = await db.competitorScanRun.create({
    data: { workspaceId, trigger: opts.trigger, startedById, mode, total: plan.length, summary: { skipped } as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  if (mode === "live") {
    for (const item of plan) {
      const created = await createScan(workspaceId, item.competitorId, opts.trigger, startedById, "website", { runId: run.id });
      if ("error" in created) skipped.push({ name: item.name, reason: created.error });
    }
  }
  await recordCompetitorEvent(workspaceId, startedById, "cmp_run_started", { runId: run.id, trigger: opts.trigger, mode, competitors: plan.length, skipped: skipped.length });
  return { runId: run.id, total: plan.length, mode };
}

/** Run every scan of the run in order, close the run, then send the notification. Safe to call once per run. */
export async function executeRun(runId: string): Promise<void> {
  const run = await db.competitorScanRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "running") return;
  const t0 = Date.now();
  let done = 0;
  let failed: string | null = null;
  const progress = (current: string | null) => db.competitorScanRun.update({ where: { id: runId }, data: { done, current } });
  try {
    if (run.mode === "live") {
      const scans = await db.competitorScan.findMany({
        where: { runId, status: "queued" },
        orderBy: { startedAt: "asc" },
        select: { id: true, source: { select: { competitor: { select: { name: true } } } } },
      });
      for (const s of scans) {
        await progress(s.source.competitor.name);
        // Scans waiting their turn are alive: keep failStaleScans off them.
        await db.competitorScan.updateMany({ where: { runId, status: "queued" }, data: { heartbeatAt: new Date() } });
        await runScan(s.id);
        done++;
      }
    } else {
      const { plan } = await planRun(run.workspaceId, "bundle", { exemptFromLimit: true });
      for (const item of plan) {
        await progress(item.name);
        const bundle = bundleForHost(item.host);
        if (bundle) {
          for (const src of bundle.sources) {
            const imported = await importPages({
              workspaceId: run.workspaceId,
              competitorId: item.competitorId,
              sourceType: src.type,
              sourceUrl: src.url,
              pages: src.pages,
              startedById: run.startedById,
              runId,
              trigger: run.trigger === "scheduled" ? "scheduled" : "manual",
            });
            if ("error" in imported) continue;
            await runScan(imported.scanId);
          }
        }
        done++;
      }
    }
  } catch (e) {
    failed = e instanceof Error ? e.message.slice(0, 300) : String(e);
    console.error("[competitors] run failed", runId, e);
  }
  await db.competitorScanRun.update({
    where: { id: runId },
    data: { status: failed ? "failed" : "ok", done, current: null, finishedAt: new Date() },
  });
  // Scans the run never reached (a failure mid-way) must not block the next run.
  await db.competitorScan.updateMany({
    where: { runId, status: "queued" },
    data: { status: "failed", finishedAt: new Date(), errorKind: "other", error: failed ? `the run stopped before this scan: ${failed}` : "the run stopped before this scan" },
  });
  await recordCompetitorEvent(run.workspaceId, run.startedById, "cmp_run_finished", { runId, mode: run.mode, competitors: done, failed: failed ?? null, durationMs: Date.now() - t0 });
  try {
    await notifyRun(runId);
  } catch (e) {
    console.error("[competitors] run notification failed", runId, e);
  }
}

/**
 * Showcase only (bundle mode): before a demo run starts, undo what earlier
 * demo runs did, so the same prepared pages read as new again — statuses
 * back to the value before the first demo change, facts and suggestions the
 * demo scans added removed, the runs and their scans (and pages) deleted.
 * Nothing the set-up imports or a live crawl wrote is touched.
 */
export async function undoDemoRuns(workspaceId: string): Promise<{ runs: number; statuses: number; facts: number; suggestions: number }> {
  const runs = await db.competitorScanRun.findMany({ where: { workspaceId, mode: "bundle" }, select: { id: true, startedAt: true } });
  const out = { runs: runs.length, statuses: 0, facts: 0, suggestions: 0 };
  if (runs.length === 0) return out;
  const minStart = runs.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), runs[0].startedAt);
  const scans = await db.competitorScan.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, select: { id: true, source: { select: { competitorId: true } } } });
  const scanIds = scans.map((s) => s.id);
  const competitorIds = [...new Set(scans.map((s) => s.source.competitorId))];

  const touched = await db.capabilityStatus.findMany({ where: { scanId: { in: scanIds } }, select: { id: true } });
  for (const st of touched) {
    const before = await db.statusHistory.findFirst({ where: { statusId: st.id, at: { gte: minStart } }, orderBy: { at: "asc" } });
    if (before) {
      await db.capabilityStatus.update({ where: { id: st.id }, data: { value: before.value, quote: before.quote, sourceUrl: before.sourceUrl, scanId: before.scanId, changedAt: null } });
      await db.statusHistory.deleteMany({ where: { statusId: st.id, at: { gte: minStart } } });
    } else {
      // First evidence the demo scan set on an empty cell: back to unknown.
      await db.capabilityStatus.update({ where: { id: st.id }, data: { value: "unknown", quote: null, sourceUrl: null, confidence: null, product: null, scanId: null, changedAt: null } });
    }
    out.statuses++;
  }
  out.facts = (await db.profileFact.deleteMany({ where: { scanId: { in: scanIds } } })).count;
  out.suggestions = (await db.capability.deleteMany({ where: { workspaceId, origin: "ai", suggestedById: { in: competitorIds }, createdAt: { gte: minStart } } })).count;
  await db.competitorDomain.deleteMany({ where: { workspaceId, origin: "ai", suggestedById: { in: competitorIds }, createdAt: { gte: minStart } } });
  await db.competitorScan.deleteMany({ where: { id: { in: scanIds } } });
  await db.competitorScanRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
  await db.competitorSource.updateMany({ where: { competitorId: { in: competitorIds }, lastStatus: { in: ["running", "failed"] } }, data: { lastStatus: "ok", lastError: null } });
  return out;
}
