/**
 * One-time data fix (Website Scanning, 2026-11-09): collapse SourcePage rows that are the same
 * page under http/https or www/bare variants of the site's own host onto the canonical key
 * (pageKey(url, source.url)). Keeps the row read most recently, deletes the others, and renames
 * a lone variant to its canonical address. Scans before this fix stored the variants separately
 * (Recorded Future: the home page 4 times; Flashpoint: 51 pages twice).
 *
 *   node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- node --no-warnings --import ./scripts/ts-resolve-hooks.mjs scripts/competitors-dedupe-pages.mts [--apply]
 *
 * Without --apply it only reports. Idempotent.
 */
import { db } from "../src/lib/db";
import { pageKey } from "../src/lib/competitors/url";

const apply = process.argv.includes("--apply");

const sources = await db.competitorSource.findMany({ select: { id: true, url: true, competitor: { select: { name: true } } } });
let groups = 0;
let deleted = 0;
let renamed = 0;
for (const s of sources) {
  const rows = await db.sourcePage.findMany({ where: { sourceId: s.id }, select: { id: true, url: true, lastReadAt: true, state: true }, orderBy: { lastReadAt: "desc" } });
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    let key: string;
    try {
      key = pageKey(new URL(r.url), s.url);
    } catch {
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  for (const [key, list] of byKey) {
    const exact = list.find((r) => r.url === key);
    const keep = exact ?? list[0];
    const drop = list.filter((r) => r.id !== keep.id);
    if (!drop.length && keep.url === key) continue;
    groups++;
    console.log(`${s.competitor.name}: ${key} ← keep ${keep.url}${drop.length ? `, drop ${drop.map((d) => d.url).join(", ")}` : ""}`);
    if (!apply) continue;
    if (drop.length) {
      const r = await db.sourcePage.deleteMany({ where: { id: { in: drop.map((d) => d.id) } } });
      deleted += r.count;
    }
    if (keep.url !== key) {
      await db.sourcePage.update({ where: { id: keep.id }, data: { url: key } });
      renamed++;
    }
  }
}
console.log(`${groups} page${groups === 1 ? "" : "s"} with variants${apply ? ` — ${deleted} rows deleted, ${renamed} renamed` : " (dry run; add --apply)"}`);
await db.$disconnect();
