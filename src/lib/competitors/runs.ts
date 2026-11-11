/**
 * A scan run — the Scan button on the Competitors page (or a scheduled
 * round): every competitor scanned one after another, then ONE notification
 * email about what the run changed (lib/competitors/notify.ts).
 *
 * A run always reads the real websites: the scanner crawls each competitor's
 * site (createScan + runScan), or parks the scan for the local station.
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { recordCompetitorEvent } from "./analytics";
import { rescanLimitEnforced } from "./config";
import { notifyRun } from "./notify";
import { failStaleScans } from "./run";
import { createScan, manualScansToday, runScan } from "./scan";
import { getCompetitorsConfig } from "./store";
import { routeScan } from "./tick";

interface PlanItem {
  competitorId: string;
  name: string;
  host: string;
}

/** Which competitors a run would scan, in matrix order, and which it leaves out (with the reason). */
async function planRun(workspaceId: string, opts: { exemptFromLimit: boolean }): Promise<{ plan: PlanItem[]; skipped: { name: string; reason: string }[] }> {
  const competitors = await db.competitor.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true, name: true, host: true, sources: { where: { type: "website" }, select: { id: true } } },
  });
  const plan: PlanItem[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const config = await getCompetitorsConfig(workspaceId);
  for (const c of competitors) {
    const website = c.sources[0];
    if (!website) {
      skipped.push({ name: c.name, reason: "no website" });
      continue;
    }
    if (rescanLimitEnforced() && !opts.exemptFromLimit && (await manualScansToday(website.id)) >= config.manualRescansPerDay) {
      skipped.push({ name: c.name, reason: "daily manual scan limit" });
      continue;
    }
    plan.push({ competitorId: c.id, name: c.name, host: c.host });
  }
  return { plan, skipped };
}

export type StartRunResult = { runId: string; total: number } | { error: "running" | "nothing" };

/** Create the run and its queued scans. The caller launches it with launchRun. */
export async function startRun(
  workspaceId: string,
  startedById: string | null,
  opts: { trigger: "manual" | "scheduled"; exemptFromLimit: boolean },
): Promise<StartRunResult> {
  // A press must never be blocked by a run whose runner died (dev server reload, crash): 10 min without a heartbeat = stale.
  await failStaleScans();
  const [activeScan, activeRun] = await Promise.all([
    db.competitorScan.findFirst({ where: { workspaceId, status: { in: ["queued", "pending_local", "running"] } }, select: { id: true } }),
    db.competitorScanRun.findFirst({ where: { workspaceId, status: "running" }, select: { id: true } }),
  ]);
  if (activeScan || activeRun) return { error: "running" };
  const { plan, skipped } = await planRun(workspaceId, opts);
  if (plan.length === 0) return { error: "nothing" };
  const run = await db.competitorScanRun.create({
    data: { workspaceId, trigger: opts.trigger, startedById, total: plan.length, summary: { skipped } as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  for (const item of plan) {
    const created = await createScan(workspaceId, item.competitorId, opts.trigger, startedById, "website", { runId: run.id });
    if ("error" in created) skipped.push({ name: item.name, reason: created.error });
  }
  await recordCompetitorEvent(workspaceId, startedById, "cmp_run_started", { runId: run.id, trigger: opts.trigger, competitors: plan.length, skipped: skipped.length });
  return { runId: run.id, total: plan.length };
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
    const scans = await db.competitorScan.findMany({
      where: { runId, status: "queued" },
      orderBy: { startedAt: "asc" },
      select: { id: true, source: { select: { competitor: { select: { name: true } } } } },
    });
    for (const s of scans) {
      await progress(s.source.competitor.name);
      // Scans waiting their turn are alive: keep the stale sweep off them.
      await db.competitorScan.updateMany({ where: { runId, status: "queued" }, data: { heartbeatAt: new Date() } });
      // Remote OFF: the scan is parked in the local lane and the run moves on (its result arrives when the station reads the site).
      const routed = await routeScan(s.id);
      if (routed === "queued") await runScan(s.id);
      done++;
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
  await recordCompetitorEvent(run.workspaceId, run.startedById, "cmp_run_finished", { runId, competitors: done, failed: failed ?? null, durationMs: Date.now() - t0 });
  try {
    await notifyRunWhenAnalyzed(runId);
  } catch (e) {
    console.error("[competitors] run notification failed", runId, e);
  }
}

/**
 * The run's one notification, sent once, after the analyses its scans queued: the scans only store pages, what
 * changed in the table is known when the analyses are done. Called at the end of the run and at the end of every
 * analysis; `summarizedAt` is the claim that makes it happen once.
 */
export async function notifyRunWhenAnalyzed(runId: string): Promise<void> {
  const run = await db.competitorScanRun.findUnique({ where: { id: runId }, select: { status: true, summarizedAt: true, scans: { select: { id: true } } } });
  // While the run is still scanning, an analysis that ends early must not send the email: later scans queue more.
  if (!run || run.summarizedAt || run.status === "running") return;
  const scanIds = run.scans.map((s) => s.id);
  if (scanIds.length) {
    const pending = await db.competitorAnalysis.count({ where: { scanId: { in: scanIds }, status: { in: ["queued", "running", "waiting"] } } });
    if (pending > 0) return;
  }
  const claimed = await db.competitorScanRun.updateMany({ where: { id: runId, summarizedAt: null }, data: { summarizedAt: new Date() } });
  if (claimed.count !== 1) return;
  await notifyRun(runId);
}
