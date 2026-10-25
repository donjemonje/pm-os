/**
 * The competitors scanner — the Cloud Run job's entry point, also runnable
 * locally against the dev database:
 *
 *   npm run competitors:scan -- --scan <scanId>   one queued scan
 *   npm run competitors:scan -- --due             every source whose schedule has come
 *
 * Env: DATABASE_URL (or the Cloud SQL connector vars), the Vertex settings,
 * COMPETITORS_BROWSER=on when Chromium is installed (the job image).
 */
import { failStaleScans, runDueScans } from "../src/lib/competitors/run";
import { runScan } from "../src/lib/competitors/scan";

async function main() {
  const args = process.argv.slice(2);
  const scanIdx = args.indexOf("--scan");
  const stale = await failStaleScans();
  if (stale) console.log(`[scanner] abandoned ${stale} stale scan${stale === 1 ? "" : "s"}`);
  if (scanIdx >= 0 && args[scanIdx + 1]) {
    const id = args[scanIdx + 1];
    console.log(`[scanner] running scan ${id}`);
    await runScan(id);
  } else if (args.includes("--due")) {
    const n = await runDueScans((m) => console.log(`[scanner] ${m}`));
    console.log(`[scanner] ${n} scan${n === 1 ? "" : "s"} run`);
  } else {
    console.error("usage: competitors-scanner --scan <id> | --due");
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error("[scanner] failed", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
