/**
 * Competitors — rename the stored cell values (Capability Analysis, "How the analysis runs", 2026-11-11).
 *
 *   has / partial / missing / unknown   →   found / low / not_found
 *
 * Run it once per dev database that holds Competitors data, when that database's code has the change
 * (Competitors was never deployed to prod, so prod needs no data step):
 *
 *   node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- node --no-warnings --import ./scripts/ts-resolve-hooks.mjs scripts/competitors-migrate-values.mts            (dry run: prints what it would change)
 *   node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- node --no-warnings --import ./scripts/ts-resolve-hooks.mjs scripts/competitors-migrate-values.mts --apply    (writes)
 *
 * Idempotent: a second run finds nothing to change.
 *
 *   Capability.ourStatus            has → found, partial → found, missing → not_found
 *   CapabilityStatus.value          has → found, partial → low, missing → not_found, unknown → not_found
 *   StatusHistory.value             the same
 *   CapabilityStatus.overrideValue  has → found, partial → found, missing → not_found;
 *                                   unknown → the correction is cleared (a PM corrects to found or not found only)
 */
import { db } from "../src/lib/db";

const OWN: Record<string, string> = { has: "found", partial: "found", missing: "not_found" };
const CELL: Record<string, string> = { has: "found", partial: "low", missing: "not_found", unknown: "not_found" };
const OVERRIDE: Record<string, string> = { has: "found", partial: "found", missing: "not_found" };

function databaseName(): string {
  const url = process.env.DATABASE_URL ?? "";
  try {
    return new URL(url).pathname.replace(/^\//, "") || "(unknown)";
  } catch {
    return process.env.DB_NAME ?? "(unknown)";
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[migrate-values] database: ${databaseName()} — ${apply ? "APPLY" : "dry run (add --apply to write)"}`);

  const [own, cells, history, overrides] = await Promise.all([
    db.capability.groupBy({ by: ["ourStatus"], _count: true, where: { ourStatus: { in: Object.keys(OWN) } } }),
    db.capabilityStatus.groupBy({ by: ["value"], _count: true, where: { value: { in: Object.keys(CELL) } } }),
    db.statusHistory.groupBy({ by: ["value"], _count: true, where: { value: { in: Object.keys(CELL) } } }),
    db.capabilityStatus.groupBy({ by: ["overrideValue"], _count: true, where: { overrideValue: { in: [...Object.keys(OVERRIDE), "unknown"] } } }),
  ]);
  const line = (table: string, from: string | null, to: string, n: number) => console.log(`[migrate-values] ${table}: ${from} → ${to} · ${n} row${n === 1 ? "" : "s"}`);
  for (const r of own) line("Capability.ourStatus", r.ourStatus, OWN[r.ourStatus], r._count);
  for (const r of cells) line("CapabilityStatus.value", r.value, CELL[r.value], r._count);
  for (const r of history) line("StatusHistory.value", r.value, CELL[r.value], r._count);
  for (const r of overrides) line("CapabilityStatus.overrideValue", r.overrideValue, r.overrideValue === "unknown" ? "(correction cleared)" : OVERRIDE[r.overrideValue ?? ""], r._count);
  const total = [...own, ...cells, ...history, ...overrides].reduce((n, r) => n + r._count, 0);
  if (total === 0) {
    console.log("[migrate-values] nothing to change");
    return;
  }
  if (!apply) {
    console.log(`[migrate-values] ${total} row${total === 1 ? "" : "s"} would change`);
    return;
  }
  await db.$transaction(async (tx) => {
    for (const [from, to] of Object.entries(OWN)) await tx.capability.updateMany({ where: { ourStatus: from }, data: { ourStatus: to } });
    for (const [from, to] of Object.entries(CELL)) {
      await tx.capabilityStatus.updateMany({ where: { value: from }, data: { value: to } });
      await tx.statusHistory.updateMany({ where: { value: from }, data: { value: to } });
    }
    for (const [from, to] of Object.entries(OVERRIDE)) await tx.capabilityStatus.updateMany({ where: { overrideValue: from }, data: { overrideValue: to } });
    await tx.capabilityStatus.updateMany({ where: { overrideValue: "unknown" }, data: { overrideValue: null, overrideNote: null, overrideUserId: null, overrideAt: null } });
  }, { timeout: 120_000 });
  console.log(`[migrate-values] done — ${total} row${total === 1 ? "" : "s"} changed`);
}

main()
  .catch((e) => {
    console.error("[migrate-values] failed", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
