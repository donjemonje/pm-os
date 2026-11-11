import { db } from "../db";
import { envFeatureDefault, resolveFeature } from "../feature-flags";
import { ACTIVE_SCAN_STATUSES, MAX_PARALLEL_REMOTE, MAX_PROCESS_ATTEMPTS, STALE_MS } from "./config";
import { alertOldRequests, cleanupScanTokens, createLocalRequest, hasActiveScannerKey, requeueLocalScan } from "./local";
import { getGlobalScanSettings, now } from "./settings";

/**
 * The hourly tick (Website Scanning PRD 2026-11-04). Cloud Scheduler runs the
 * scanner job with `--tick` once an hour; local dev and the tests call
 * runTick() directly ("scheduler tick" knob). One pass over the tables:
 *
 *   1. stale sweep      — scans with no heartbeat for 10 minutes: remote ones
 *                         are marked stale (the next run resumes their pending
 *                         pages); a local one whose station died goes back to
 *                         waiting, one whose PROCESSING died (pages handed in,
 *                         the runner stopped) is processed again, three times at
 *                         most, then failed — the station never re-reads a site
 *                         it already handed in (Tomer's review 2026-11-10);
 *   2. due sources      — every website source whose last scan is older than
 *                         its own frequency gets a scan: remote ON → queued for
 *                         the remote lane, remote OFF → parked in the local lane;
 *   3. start queued     — remote scans start while fewer than 8 run, one per
 *                         site at a time;
 *   4. analysis queue   — an analysis run whose runner stopped reporting goes
 *                         back to the queue, and the head of the queue starts
 *                         when nothing is running (analysis/engine.ts);
 *   5. 24-hour alert    — waiting local requests older than a day email
 *                         support once.
 *
 * A finishing scan calls startQueuedScans() itself, so a freed slot is used at
 * once, not at the next tick.
 */

export interface TickResult {
  stale: number;
  due: number;
  started: number;
  alerts: number;
}

export type Launcher = (scanId: string) => Promise<void>;

export async function runTick(launch: Launcher, log: (msg: string) => void = () => undefined): Promise<TickResult> {
  const t = await now();
  const settings = await getGlobalScanSettings();
  const stale = await sweepStale(t);
  if (stale) log(`${stale} stale scan${stale === 1 ? "" : "s"}`);
  const due = await queueDueScans(t, settings.remoteScanEnabled, log);
  await promoteQueued(null, settings.remoteScanEnabled);
  const started = await startQueuedScans(launch, log);
  // The safety net of the analysis queue: a run whose runner died is put back and the head of the queue is started.
  const { kickAnalyses } = await import("./analysis/engine");
  await kickAnalyses();
  const alerts = await alertOldRequests(appUrl());
  if (alerts) log(`${alerts} waiting-request alert${alerts === 1 ? "" : "s"} sent to support`);
  await cleanupScanTokens(t);
  return { stale, due, started, alerts };
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Stale = running with no heartbeat for STALE_MS. Decided here and at read time (store.ts) from the same rule. */
export function isStale(status: string, heartbeatAt: Date, t: Date): boolean {
  return status === "running" && t.getTime() - heartbeatAt.getTime() > STALE_MS;
}

export async function sweepStale(t: Date): Promise<number> {
  const cutoff = new Date(t.getTime() - STALE_MS);
  const stale = await db.competitorScan.findMany({ where: { status: "running", heartbeatAt: { lt: cutoff } }, select: { id: true, sourceId: true, lane: true } });
  /** Scans this sweep ended: the email of their Scan run may be due now. */
  const ended: string[] = [];
  for (const s of stale) {
    if (s.lane === "local") {
      const req = await db.localScanRequest.findUnique({ where: { scanId: s.id }, select: { state: true, processAttempts: true } });
      if (req && (req.state === "handed_in" || req.state === "done")) {
        // Every page is already in PM-OS; the processing half died (runner crash, dev server restart, a launch that never
        // happened). Process again — never send the station back to read a site it handed in. Three tries, then failed.
        if (req.processAttempts >= MAX_PROCESS_ATTEMPTS) {
          await db.localScanRequest.updateMany({ where: { scanId: s.id }, data: { state: "failed", finishedAt: t } });
          await db.competitorScan.update({ where: { id: s.id }, data: { status: "failed", badge: "incomplete", finishedAt: t, errorKind: "other", error: `processing failed ${MAX_PROCESS_ATTEMPTS} times after the station handed the pages in — contact support@pm-os.io` } });
          await db.competitorSource.update({ where: { id: s.sourceId }, data: { lastStatus: "failed", lastError: "processing failed after the hand-in" } });
          console.error(`[competitors] scan ${s.id}: processing failed ${MAX_PROCESS_ATTEMPTS} times after the hand-in`);
          ended.push(s.id);
          continue;
        }
        await db.localScanRequest.updateMany({ where: { scanId: s.id }, data: { state: "handed_in", processAttempts: { increment: 1 } } });
        await db.competitorScan.update({ where: { id: s.id }, data: { heartbeatAt: t } });
        const { launchScan } = await import("./run");
        await launchScan(s.id).catch((e) => console.error("[competitors] relaunch after a stale hand-in failed", s.id, e));
        continue;
      }
      // The station died mid-scan: back to waiting, the next poll resumes it (read pages stay).
      await requeueLocalScan(s.id);
      continue;
    }
    await db.competitorScan.update({ where: { id: s.id }, data: { status: "stale", badge: "stale", finishedAt: t, errorKind: "other", error: "the scan stopped reporting; the next run continues from its pending pages" } });
    await db.competitorSource.update({ where: { id: s.sourceId }, data: { lastStatus: "failed", lastError: "the scan stopped reporting" } });
    ended.push(s.id);
  }
  if (ended.length) {
    const { notifyRunsOfScans } = await import("./runs");
    await notifyRunsOfScans(ended);
  }
  // Runs whose scans are all gone: close them so the next press can start.
  const runs = await db.competitorScanRun.findMany({ where: { status: "running", startedAt: { lt: cutoff } }, select: { id: true } });
  for (const r of runs) {
    const alive = await db.competitorScan.findFirst({ where: { runId: r.id, status: { in: [...ACTIVE_SCAN_STATUSES] } }, select: { id: true } });
    if (alive) continue;
    await db.competitorScanRun.update({ where: { id: r.id }, data: { status: "failed", finishedAt: t, current: null } });
  }
  return stale.length;
}

/** One scheduled scan per due website source (frequency per source, in days). */
export async function queueDueScans(t: Date, remoteOn: boolean, log: (msg: string) => void): Promise<number> {
  const sources = await db.competitorSource.findMany({
    where: { type: "website", competitor: { deletedAt: null } },
    select: { id: true, workspaceId: true, competitorId: true, scanEveryDays: true, lastScanAt: true, competitor: { select: { name: true, workspace: { select: { organization: { select: { features: true } } } } } } },
  });
  let queued = 0;
  for (const s of sources) {
    if (!resolveFeature(s.competitor.workspace.organization.features, "competitors", envFeatureDefault("competitors"))) continue;
    const dueAt = s.lastScanAt ? s.lastScanAt.getTime() + s.scanEveryDays * 86_400_000 : 0;
    if (dueAt > t.getTime()) continue;
    const active = await db.competitorScan.findFirst({ where: { sourceId: s.id, status: { in: [...ACTIVE_SCAN_STATUSES] } }, select: { id: true } });
    if (active) continue;
    const scan = await db.competitorScan.create({ data: { workspaceId: s.workspaceId, sourceId: s.id, trigger: "scheduled", status: "queued", startedAt: t, heartbeatAt: t }, select: { id: true } });
    await db.competitorSource.update({ where: { id: s.id }, data: { lastStatus: "running" } });
    await routeScan(scan.id, remoteOn);
    log(`due: ${s.competitor.name} (${scan.id})`);
    queued++;
  }
  return queued;
}

/**
 * Where a new scan goes. Remote ON → stays "queued" for startQueuedScans.
 * Remote OFF → the local lane, when a station is enrolled; with no machine key
 * the scan ends "failed — local scanning not set up" instead of waiting
 * forever (Tomer's review, Kela on day one).
 */
export async function routeScan(scanId: string, remoteOn?: boolean): Promise<"queued" | "pending_local" | "no_station"> {
  const on = remoteOn ?? (await getGlobalScanSettings()).remoteScanEnabled;
  if (on) return "queued";
  if (!(await hasActiveScannerKey())) {
    // Customer-facing text names no lane; the admin log says what is missing.
    const t = await now();
    const scan = await db.competitorScan.update({ where: { id: scanId }, data: { status: "failed", finishedAt: t, errorKind: "other", error: "missing scanner configuration", log: [{ at: t.toISOString(), level: "error", msg: "No local station key is enrolled (Administration → Competitors → Local stations); the scan could not be parked in the local lane." }] }, select: { sourceId: true } });
    // Counts as the source's last scan: otherwise every hourly tick would create another failed scan (Tomer's review).
    await db.competitorSource.update({ where: { id: scan.sourceId }, data: { lastStatus: "failed", lastError: "missing scanner configuration", lastScanAt: t } });
    return "no_station";
  }
  await createLocalRequest(scanId);
  return "pending_local";
}

/**
 * A scan queued behind a running one of the same site gets its turn: routed to
 * the lane that is on right now (remote stays "queued" for startQueuedScans,
 * remote OFF parks it in the local lane). `sourceId` null = every source
 * without an active scan (the tick's safety net).
 */
export async function promoteQueued(sourceId: string | null, remoteOn?: boolean): Promise<number> {
  const on = remoteOn ?? (await getGlobalScanSettings()).remoteScanEnabled;
  const queued = await db.competitorScan.findMany({
    where: { status: "queued", lane: "remote", ...(sourceId ? { sourceId } : {}) },
    orderBy: { startedAt: "asc" },
    select: { id: true, sourceId: true },
  });
  const seen = new Set<string>();
  let promoted = 0;
  for (const q of queued) {
    if (seen.has(q.sourceId)) continue;
    seen.add(q.sourceId);
    const busy = await db.competitorScan.findFirst({ where: { sourceId: q.sourceId, status: { in: ["running", "pending_local"] } }, select: { id: true } });
    if (busy) continue;
    if (on) continue; // stays queued; startQueuedScans launches it
    await routeScan(q.id, false);
    promoted++;
  }
  return promoted;
}

/**
 * Start queued remote scans while fewer than MAX_PARALLEL_REMOTE run, oldest
 * first, never two on one site. Called by the tick and by every scan that
 * finishes.
 */
export async function startQueuedScans(launch: Launcher, log: (msg: string) => void = () => undefined): Promise<number> {
  const running = await db.competitorScan.count({ where: { status: "running", lane: "remote" } });
  let slots = MAX_PARALLEL_REMOTE - running;
  if (slots <= 0) return 0;
  // Scans of a Scan run are driven by executeRun, one after another: not ours to start.
  const queued = await db.competitorScan.findMany({ where: { status: "queued", lane: "remote", runId: null }, orderBy: { startedAt: "asc" }, select: { id: true, sourceId: true } });
  const busySources = new Set((await db.competitorScan.findMany({ where: { status: "running" }, select: { sourceId: true } })).map((s) => s.sourceId));
  let started = 0;
  for (const q of queued) {
    if (slots <= 0) break;
    if (busySources.has(q.sourceId)) continue;
    busySources.add(q.sourceId);
    slots--;
    started++;
    log(`start ${q.id}`);
    await launch(q.id);
  }
  return started;
}
