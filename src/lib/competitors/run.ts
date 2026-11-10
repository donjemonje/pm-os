import { db } from "../db";
import { runScan } from "./scan";
import { runTick, sweepStale } from "./tick";
import { now } from "./settings";

/**
 * Where scans execute (Website Scanning PRD 2026-11-04).
 *
 * - COMPETITORS_RUNNER=inline (local dev default): runScan runs in this Node
 *   process, fire-and-forget; the page polls the Scan row.
 * - COMPETITORS_RUNNER=cloudrun (prod): the app asks the Cloud Run job
 *   COMPETITORS_JOB (projects/P/locations/L/jobs/J) to run with `--scan <id>`;
 *   the job container has Chromium. Cloud Scheduler runs the same job with
 *   `--tick` once an hour: the job (same code, same database) decides what is
 *   due, sweeps stale scans and sends the 24-hour alerts — no HTTP route, no
 *   new auth surface.
 */

/** Inline launches in flight — the scanner job awaits them before it exits (settleInline), so a scan a finishing scan started is never killed with the process. */
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}
export async function settleInline(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

export function runnerMode(): "inline" | "cloudrun" {
  return process.env.COMPETITORS_RUNNER?.trim().toLowerCase() === "cloudrun" ? "cloudrun" : "inline";
}

export async function launchScan(scanId: string): Promise<void> {
  if (runnerMode() === "cloudrun") {
    await triggerCloudRunJob(["--scan", scanId]);
    return;
  }
  track(runScan(scanId).catch((e) => {
    console.error("[competitors] scan failed", scanId, e);
  }));
}

/** Same runner choice for a Scan run (lib/competitors/runs.ts): the job gets `--run <id>`, local dev runs it in-process. */
export async function launchRun(runId: string): Promise<void> {
  if (runnerMode() === "cloudrun") {
    await triggerCloudRunJob(["--run", runId]);
    return;
  }
  const { executeRun } = await import("./runs");
  track(executeRun(runId).catch((e) => {
    console.error("[competitors] run failed", runId, e);
  }));
}

async function triggerCloudRunJob(args: string[]): Promise<void> {
  const job = process.env.COMPETITORS_JOB?.trim();
  if (!job) throw new Error("COMPETITORS_JOB is not set");
  // google-auth-library ships with the Vertex SDK; ADC = the App Hosting service account.
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const url = `https://run.googleapis.com/v2/${job}:run`;
  const res = await client.request({
    url,
    method: "POST",
    data: { overrides: { containerOverrides: [{ args }] } },
  });
  if (res.status >= 300) throw new Error(`Cloud Run job trigger answered ${res.status}`);
}

/**
 * The hourly tick, run by the scanner job (`--tick`) and by the tests
 * ("scheduler tick" knob). Inline mode runs the scans it starts in-process.
 */
export async function tick(log: (msg: string) => void = console.log): Promise<void> {
  const r = await runTick(launchScan, log);
  log(`tick: ${r.stale} stale, ${r.due} due, ${r.started} started, ${r.alerts} alerts`);
}

/** Legacy name kept for the Scan-run code: scans that lost their runner are swept with the PRD rule (10 min without a heartbeat). */
export async function failStaleScans(): Promise<number> {
  return sweepStale(await now());
}

/** Scans of a workspace that are alive right now (any lane). */
export async function activeScans(workspaceId: string): Promise<{ id: string; sourceId: string; status: string }[]> {
  return db.competitorScan.findMany({ where: { workspaceId, status: { in: ["queued", "pending_local", "running"] } }, select: { id: true, sourceId: true, status: true } });
}
