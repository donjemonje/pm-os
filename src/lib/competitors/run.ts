import { db } from "../db";
import { envFeatureDefault, resolveFeature } from "../feature-flags";
import { frequencyMs, mergeCompetitorsConfig } from "./config";
import { createScan, runScan } from "./scan";

/**
 * Where scans execute.
 *
 * - COMPETITORS_RUNNER=inline (local dev default): runScan runs in this Node
 *   process, fire-and-forget; the page polls the Scan row.
 * - COMPETITORS_RUNNER=cloudrun (prod): the app asks the Cloud Run job
 *   COMPETITORS_JOB (projects/P/locations/L/jobs/J) to run with `--scan <id>`;
 *   the job container has Chromium. Cloud Scheduler runs the same job with
 *   `--due` on the hour.
 */

export function runnerMode(): "inline" | "cloudrun" {
  return process.env.COMPETITORS_RUNNER?.trim().toLowerCase() === "cloudrun" ? "cloudrun" : "inline";
}

export async function launchScan(scanId: string): Promise<void> {
  if (runnerMode() === "cloudrun") {
    await triggerCloudRunJob(["--scan", scanId]);
    return;
  }
  void runScan(scanId).catch((e) => {
    console.error("[competitors] scan failed", scanId, e);
  });
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

/** Scans whose schedule has come: one per due source, run one after another. */
export async function runDueScans(log: (msg: string) => void = console.log): Promise<number> {
  const workspaces = await db.workspace.findMany({
    select: { id: true, competitorsConfig: true, organization: { select: { features: true } } },
  });
  let started = 0;
  for (const w of workspaces) {
    if (!resolveFeature(w.organization.features, "competitors", envFeatureDefault("competitors"))) continue;
    const config = mergeCompetitorsConfig(w.competitorsConfig);
    const dueBefore = new Date(Date.now() - frequencyMs(config.scanFrequency));
    const sources = await db.competitorSource.findMany({
      where: {
        workspaceId: w.id,
        type: "website",
        OR: [{ lastScanAt: null }, { lastScanAt: { lt: dueBefore } }],
      },
      include: { competitor: { select: { id: true, name: true, isSelf: true } } },
      orderBy: [{ competitor: { isSelf: "desc" } }, { lastScanAt: "asc" }],
    });
    for (const s of sources) {
      const created = await createScan(w.id, s.competitor.id, "scheduled", null);
      if ("error" in created) {
        log(`skip ${s.competitor.name}: ${created.error}`);
        continue;
      }
      log(`scan ${s.competitor.name} (${created.scanId})`);
      await runScan(created.scanId);
      started++;
    }
  }
  return started;
}

/** Scans that lost their runner (process restart): mark them failed so the next one can start. */
export async function failStaleScans(staleMs = 10 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await db.competitorScan.findMany({
    where: { status: { in: ["queued", "running"] }, heartbeatAt: { lt: cutoff } },
    select: { id: true, sourceId: true },
  });
  for (const s of stale) {
    await db.competitorScan.update({
      where: { id: s.id },
      data: { status: "failed", finishedAt: new Date(), errorKind: "other", error: "the scan stopped responding and was abandoned" },
    });
    await db.competitorSource.update({ where: { id: s.sourceId }, data: { lastStatus: "failed", lastError: "the scan stopped responding and was abandoned" } });
  }
  return stale.length;
}
