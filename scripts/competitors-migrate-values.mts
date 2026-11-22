/**
 * Competitors — the data step of Capability Analysis, "How the analysis runs" (2026-11-11): rename the stored cell
 * values, and turn the capabilities that waited as suggestions into rows.
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
 *   Capability.state                suggested → active, at the end of the table, when its domain is in the table or
 *                                   itself suggested: a capability an analysis finds is just added now, there is nothing
 *                                   to accept. (A suggested capability whose domain was removed or declined → dismissed.)
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

  const [own, cells, history, overrides, suggested] = await Promise.all([
    db.capability.groupBy({ by: ["ourStatus"], _count: true, where: { ourStatus: { in: Object.keys(OWN) } } }),
    db.capabilityStatus.groupBy({ by: ["value"], _count: true, where: { value: { in: Object.keys(CELL) } } }),
    db.statusHistory.groupBy({ by: ["value"], _count: true, where: { value: { in: Object.keys(CELL) } } }),
    db.capabilityStatus.groupBy({ by: ["overrideValue"], _count: true, where: { overrideValue: { in: [...Object.keys(OVERRIDE), "unknown"] } } }),
    db.capability.findMany({ where: { state: "suggested" }, select: { id: true, workspaceId: true, name: true, domain: { select: { state: true } } }, orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }] }),
  ]);
  const toActive = suggested.filter((k) => k.domain.state === "active" || k.domain.state === "suggested");
  const toDismissed = suggested.filter((k) => !toActive.includes(k));
  const line = (table: string, from: string | null, to: string, n: number) => console.log(`[migrate-values] ${table}: ${from} → ${to} · ${n} row${n === 1 ? "" : "s"}`);
  for (const r of own) line("Capability.ourStatus", r.ourStatus, OWN[r.ourStatus], r._count);
  for (const r of cells) line("CapabilityStatus.value", r.value, CELL[r.value], r._count);
  for (const r of history) line("StatusHistory.value", r.value, CELL[r.value], r._count);
  for (const r of overrides) line("CapabilityStatus.overrideValue", r.overrideValue, r.overrideValue === "unknown" ? "(correction cleared)" : OVERRIDE[r.overrideValue ?? ""], r._count);
  if (toActive.length) line("Capability.state", "suggested", "active (just added)", toActive.length);
  if (toDismissed.length) line("Capability.state", "suggested", "dismissed (its domain is not in the table)", toDismissed.length);
  const total = [...own, ...cells, ...history, ...overrides].reduce((n, r) => n + r._count, 0) + suggested.length;
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
    // A suggestion that becomes a row goes to the end of its workspace's table, in the order it was suggested.
    const next = new Map<string, number>();
    for (const k of toActive) {
      if (!next.has(k.workspaceId)) {
        const agg = await tx.capability.aggregate({ where: { workspaceId: k.workspaceId, state: "active" }, _max: { position: true } });
        next.set(k.workspaceId, (agg._max.position ?? -1) + 1);
      }
      const position = next.get(k.workspaceId)!;
      next.set(k.workspaceId, position + 1);
      await tx.capability.update({ where: { id: k.id }, data: { state: "active", position } });
    }
    if (toDismissed.length) await tx.capability.updateMany({ where: { id: { in: toDismissed.map((k) => k.id) } }, data: { state: "dismissed" } });
  }, { timeout: 120_000 });
  console.log(`[migrate-values] done — ${total} row${total === 1 ? "" : "s"} changed`);
}

main()
  .catch((e) => {
    console.error("[migrate-values] failed", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
