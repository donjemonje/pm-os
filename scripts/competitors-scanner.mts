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
 *   npm run competitors:scan -- --rematch <competitorId>   forget the matches PMOS AI made for this competitor's items (after a match
 *                                                      prompt change, on purpose); the next analysis matches them again. Matches
 *                                                      by name, rows created from an item and PM decisions are not touched.
 *   npm run competitors:scan -- --own-site <workspaceId> <url>   add the organization's OWN website (one per organization): stored and
 *                                                      scanned like a competitor's site, never shown as one; its first scan is queued
 *                                                      exactly as adding a competitor does. Refused when the organization has one, or
 *                                                      when the site is one of its competitors.
 *   npm run competitors:scan -- --setup <workspaceId>  queue THE SETUP RUN of an organization that has no domain and no capability
 *                                                      and run it here: map, research and merge for the own site and every competitor,
 *                                                      unify into rows, build the domains, fill the table. Refused (nothing written)
 *                                                      when the organization is set up, has no own site, a scan is still queued /
 *                                                      running / pending, or no competitor has stored pages. A setup run that failed
 *                                                      is continued by the same command.
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
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { readBundleManifest } from "../src/lib/competitors/bundle";
import { MANUAL_IMPORT_ENABLED, MANUAL_IMPORT_OFF_NOTE } from "../src/lib/competitors/config";
import { importPages } from "../src/lib/competitors/import";
import { echoRunLog, queueAnalysis, readCounters, runAnalysis } from "../src/lib/competitors/analysis/engine";
import { queueSetup } from "../src/lib/competitors/analysis/setup";
import { readSetupProgress } from "../src/lib/competitors/analysis/setup-rules";
import { addOwnSite } from "../src/lib/competitors/own-site";
import { recordCompetitorEvent } from "../src/lib/competitors/analytics";
import { failStaleScans, settleInline, tick } from "../src/lib/competitors/run";
import { executeRun } from "../src/lib/competitors/runs";
import { runScan } from "../src/lib/competitors/scan";

async function runImport(manifestPath: string): Promise<void> {
  if (!MANUAL_IMPORT_ENABLED) {
    console.error(`[scanner] ${MANUAL_IMPORT_OFF_NOTE}`);
    process.exitCode = 1;
    return;
  }
  const bundle = readBundleManifest(manifestPath);
  const { host } = bundle;
  for (const type of bundle.skipped) console.error(`[scanner] skipped source "${type}": not a source type`);
  const competitors = await db.competitor.findMany({ where: { host, isOwn: false, ...(bundle.workspace ? { workspaceId: bundle.workspace } : {}) }, select: { id: true, name: true, workspaceId: true } });
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

/** `--own-site <workspaceId> <url>`: the organization's own website, added like a competitor and never shown as one (lib/competitors/own.ts). */
async function runOwnSite(workspaceId: string, url: string): Promise<void> {
  const r = await addOwnSite(workspaceId, url);
  if ("error" in r) {
    console.error(`[scanner] own site not added: ${r.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[scanner] own site added: ${r.name} — ${r.websiteUrl} (host ${r.host}), id ${r.competitorId}`);
  if (r.frozenCapabilities || r.frozenFeatures) {
    console.log(`[scanner] the own status of the ${r.frozenCapabilities} capabilit${r.frozenCapabilities === 1 ? "y" : "ies"} and ${r.frozenFeatures} feature${r.frozenFeatures === 1 ? "" : "s"} the catalog already has is kept as the team's value: no run changes it`);
  }
  if ("error" in r.scan) {
    console.error(`[scanner] its first scan could not be queued (${r.scan.error})`);
    process.exitCode = 1;
    return;
  }
  const where = { started: "started in the remote lane", queued: "queued for the remote lane", pending_local: "waiting for the local station", no_station: "FAILED: no local station key is enrolled (Administration → Competitors → Local stations)" }[r.scan.state];
  console.log(`[scanner] first scan ${r.scan.scanId}: ${where}`);
  if (r.scan.state === "no_station") process.exitCode = 1;
  else console.log(`[scanner] when the scan has ended, run the setup: --setup ${workspaceId}`);
}

/** `--setup <workspaceId>`: queue the setup run (or continue the one that failed) and run it in this process (analysis/setup.ts). */
async function runSetup(workspaceId: string): Promise<void> {
  // The run's log on the console as it is written (it is also on the run row, for Administration → Competitors). Set
  // before the run is queued: queueing starts it in this process when nothing else is running.
  echoRunLog((l) => console.log(`[setup ${l.at.slice(11, 19)}] ${l.level === "info" ? "" : `${l.level.toUpperCase()} `}${l.msg}${l.url ? ` — ${l.url}` : ""}`));
  const q = await queueSetup(workspaceId);
  if ("refused" in q) {
    console.error(`[scanner] setup run refused: ${q.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[scanner] setup run ${q.id} ${q.created ? "queued" : q.continued ? "continued (it had stopped; it goes on from the tables)" : "was already queued or in progress"} — ${q.companies.map((c) => `${c.name}${c.isOwn ? " (own site)" : ""}: ${c.pages} page${c.pages === 1 ? "" : "s"}`).join(", ")}`);
  if (q.skipped.length) console.log(`[scanner] not part of it (no stored page): ${q.skipped.map((c) => c.name).join(", ")}`);
  // Queueing started it here when nothing else was running. Claim it here too: when a kick of another process marked
  // it first and never ran it, this still does; when it is running already (here or elsewhere), this returns at once.
  await runAnalysis(q.id);
  await settleInline();
  const run = await db.competitorAnalysis.findUnique({ where: { id: q.id }, select: { status: true, step: true, error: true, counters: true, setup: true, startedAt: true, finishedAt: true } });
  if (!run) return;
  const counters = readCounters(run.counters);
  const progress = readSetupProgress(run.setup);
  for (const c of progress.companies) {
    console.log(`[scanner]   ${c.name}${c.own ? " (own site)" : ""}: ${c.stage} · ${c.counters.pagesRead} page${c.counters.pagesRead === 1 ? "" : "s"} read${c.counters.pagesUnread ? `, ${c.counters.pagesUnread} left unread` : ""} · ${(c.counters.inputTokens + c.counters.outputTokens).toLocaleString("en-US")} tokens${c.counters.budgetReached ? " (budget reached)" : ""}`);
  }
  const took = run.startedAt && run.finishedAt ? ` in ${Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 60_000)} min` : "";
  if (run.status === "done") {
    console.log(`[scanner] setup run done${took}: ${progress.domains} domain${progress.domains === 1 ? "" : "s"}, ${progress.rows} capabilit${progress.rows === 1 ? "y" : "ies"}, ${progress.features} feature${progress.features === 1 ? "" : "s"} · ${counters.calls} PMOS AI calls · ${(counters.inputTokens + counters.outputTokens).toLocaleString("en-US")} tokens`);
  } else if (run.status === "failed" || run.status === "cancelled") {
    console.error(`[scanner] setup run ${run.status} in the ${run.step.replace("_", " ")} step: ${run.error ?? "no reason recorded"} — run --setup ${workspaceId} again to continue it`);
    process.exitCode = 1;
  } else {
    console.log(`[scanner] setup run ${q.id} is ${run.status} (step ${run.step.replace("_", " ")}) in another process — follow it in Administration → Competitors → Setup runs`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const scanIdx = args.indexOf("--scan");
  const importIdx = args.indexOf("--import");
  const runIdx = args.indexOf("--run");
  const analysisIdx = args.indexOf("--analysis");
  const analyzeIdx = args.indexOf("--analyze");
  const rematchIdx = args.indexOf("--rematch");
  const ownSiteIdx = args.indexOf("--own-site");
  const setupIdx = args.indexOf("--setup");
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
  } else if (rematchIdx >= 0 && args[rematchIdx + 1]) {
    const r = await db.competitorItem.updateMany({
      where: { competitorId: args[rematchIdx + 1], matchedBy: "ai" },
      data: { capabilityId: null, featureId: null, placement: Prisma.DbNull, matchedBy: null, matchedAt: null, matchAnalysisId: null },
    });
    console.log(`[scanner] ${r.count} match${r.count === 1 ? "" : "es"} by PMOS AI forgotten — run --analyze ${args[rematchIdx + 1]} to match them again`);
  } else if (ownSiteIdx >= 0 && args[ownSiteIdx + 1] && args[ownSiteIdx + 2]) {
    await runOwnSite(args[ownSiteIdx + 1], args[ownSiteIdx + 2]);
  } else if (setupIdx >= 0 && args[setupIdx + 1]) {
    await runSetup(args[setupIdx + 1]);
  } else if (args.includes("--tick") || args.includes("--due")) {
    await tick((m) => console.log(`[scanner] ${m}`));
  } else {
    console.error("usage: competitors-scanner --scan <id> | --run <runId> | --tick | --import <manifest.json> | --analysis <id> | --analyze <competitorId> | --rematch <competitorId> | --own-site <workspaceId> <url> | --setup <workspaceId>");
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
