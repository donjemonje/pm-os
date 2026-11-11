/**
 * The competitors scanner — the Cloud Run job's entry point, also runnable
 * locally against the dev database:
 *
 *   npm run competitors:scan -- --scan <scanId>        one queued scan
 *   npm run competitors:scan -- --run <runId>        one Scan run (every competitor, then the notification)
 *   npm run competitors:scan -- --tick                 the hourly tick: stale sweep, due sources, queued starts,
 *                                                      24-hour alerts, retention (Cloud Scheduler runs this; --due is an alias)
 *   npm run competitors:scan -- --import <manifest>    hand a collector's pages to the pipeline
 *   npm run competitors:scan -- --analysis <id>        one queued analysis run (what the app asks the job for)
 *   npm run competitors:scan -- --analyze <competitorId>   queue an analysis of a competitor's stored pages now and run it
 *
 * --import reads a manifest and runs one scan per source, in order:
 *   {
 *     "competitor": "recordedfuture.com",          // the competitor's host (as added in Settings)
 *     "workspace": "<workspaceId>",                 // optional; required when the host is in several workspaces
 *     "sources": [{
 *       "type": "documents",                        // one of SOURCE_TYPES
 *       "url": "https://assets.example.com",        // optional: the source's own address
 *       "pages": [{ "url": "https://…/x.pdf", "title": "…", "file": "texts/x.txt" | "text": "…",
 *                   "kind": "document", "observedAt": "2026-03-10" }]
 *     }]
 *   }
 * `file` paths are relative to the manifest. The app never sees the manifest:
 * it stores pages and runs the same pipeline as a website scan.
 *
 * Env: DATABASE_URL (or the Cloud SQL connector vars), the Vertex settings,
 * COMPETITORS_BROWSER=on when Chromium is installed (the job image).
 */
import { db } from "../src/lib/db";
import { readBundleManifest } from "../src/lib/competitors/bundle";
import { importPages } from "../src/lib/competitors/import";
import { queueAnalysis, runAnalysis } from "../src/lib/competitors/analysis/engine";
import { recordCompetitorEvent } from "../src/lib/competitors/analytics";
import { failStaleScans, settleInline, tick } from "../src/lib/competitors/run";
import { executeRun } from "../src/lib/competitors/runs";
import { runScan } from "../src/lib/competitors/scan";

async function runImport(manifestPath: string): Promise<void> {
  const bundle = readBundleManifest(manifestPath);
  const { host } = bundle;
  for (const type of bundle.skipped) console.error(`[scanner] skipped source "${type}": not a source type`);
  const competitors = await db.competitor.findMany({ where: { host, ...(bundle.workspace ? { workspaceId: bundle.workspace } : {}) }, select: { id: true, name: true, workspaceId: true } });
  if (competitors.length !== 1) {
    throw new Error(competitors.length ? `${competitors.length} competitors have the host ${host} — set "workspace" in the manifest` : `no competitor with the host ${host} — add it in Settings → Competitors first`);
  }
  const competitor = competitors[0];
  console.log(`[scanner] import for ${competitor.name} (${host}) — ${bundle.sources.length} source${bundle.sources.length === 1 ? "" : "s"}`);
  for (const src of bundle.sources) {
    const t0 = Date.now();
    const imported = await importPages({ workspaceId: competitor.workspaceId, competitorId: competitor.id, sourceType: src.type, sourceUrl: src.url, pages: src.pages, startedById: null });
    if ("error" in imported) {
      console.error(`[scanner] ${src.type}: import refused (${imported.error})`);
      if (imported.error === "running") break;
      continue;
    }
    console.log(`[scanner] ${src.type}: ${imported.pages} pages stored${imported.dropped ? `, ${imported.dropped} dropped` : ""} — scan ${imported.scanId}`);
    await runScan(imported.scanId);
    const scan = await db.competitorScan.findUnique({ where: { id: imported.scanId }, select: { status: true, badge: true, pagesChanged: true, error: true } });
    console.log(`[scanner] ${src.type}: ${scan?.status} (${scan?.badge}) in ${Math.round((Date.now() - t0) / 1000)} s · ${scan?.pagesChanged} pages new/changed${scan?.error ? ` · ${scan.error}` : ""}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const scanIdx = args.indexOf("--scan");
  const importIdx = args.indexOf("--import");
  const runIdx = args.indexOf("--run");
  const analysisIdx = args.indexOf("--analysis");
  const analyzeIdx = args.indexOf("--analyze");
  // The sweep belongs to the tick and the runs. A job started for one scan does not sweep: were it to start late, it would
  // mark the very scan it came to process as stale and relaunch it (Tomer's review 2026-11-10).
  if (scanIdx < 0 && analysisIdx < 0) {
    const stale = await failStaleScans();
    if (stale) console.log(`[scanner] ${stale} stale scan${stale === 1 ? "" : "s"} swept`);
  }
  if (scanIdx >= 0 && args[scanIdx + 1]) {
    const id = args[scanIdx + 1];
    console.log(`[scanner] running scan ${id}`);
    await runScan(id);
  } else if (runIdx >= 0 && args[runIdx + 1]) {
    const id = args[runIdx + 1];
    console.log(`[scanner] running scan run ${id}`);
    await executeRun(id);
  } else if (importIdx >= 0 && args[importIdx + 1]) {
    await runImport(args[importIdx + 1]);
  } else if (analysisIdx >= 0 && args[analysisIdx + 1]) {
    const id = args[analysisIdx + 1];
    console.log(`[scanner] running analysis ${id}`);
    await runAnalysis(id);
  } else if (analyzeIdx >= 0 && args[analyzeIdx + 1]) {
    const competitor = await db.competitor.findUnique({ where: { id: args[analyzeIdx + 1] }, select: { id: true, name: true, workspaceId: true, deletedAt: true } });
    if (!competitor || competitor.deletedAt) throw new Error(`no competitor with the id ${args[analyzeIdx + 1]}`);
    await recordCompetitorEvent(competitor.workspaceId, null, "cmp_analysis_requested", { competitorId: competitor.id, via: "cli" });
    const q = await queueAnalysis(competitor.workspaceId, competitor.id, "manual");
    console.log("skipped" in q ? "[scanner] analysis not queued: COMPETITORS_AI=off (test knob) and no injected answers" : `[scanner] analysis ${q.id} ${q.created ? "queued" : "was already queued"} for ${competitor.name}`);
  } else if (args.includes("--tick") || args.includes("--due")) {
    await tick((m) => console.log(`[scanner] ${m}`));
  } else {
    console.error("usage: competitors-scanner --scan <id> | --run <runId> | --tick | --import <manifest.json> | --analysis <id> | --analyze <competitorId>");
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error("[scanner] failed", e);
    process.exitCode = 1;
  })
  // A finishing scan may have started the next queued one in this process (inline runner): let it end before the job does.
  .then(() => settleInline())
  .finally(() => process.exit());
