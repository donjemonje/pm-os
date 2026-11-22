/**
 * The news simulation — made-up pages of a company that has a list, sent through the real news intake
 * (src/lib/competitors/news), scored against an answer key:
 *
 *   npm run competitors:news-sim -- <fixture.json> [--email] [--table]
 *
 * The fixture names an organization and one of its competitors, and holds the pages; each page says what is
 * expected of it (new / covered / other, and for a new one its size and place). The run:
 *   1. removes the simulated news of that competitor left by an earlier simulation (real news is never touched);
 *   2. sends every page through the intake — the real prompt, the real model, the real rows (marked simulated);
 *   3. scores each expected piece and prints a line per page, the totals, the tokens and the time;
 *   4. writes the full result next to the fixture (results-<time>.json);
 *   5. --table: asks the table step what it WOULD do with the new abilities — a dry run, nothing is written;
 *   6. --email: sends the batch's one notification (to PM-OS only), with the score under it.
 * The new abilities then show in the news feed of that organization.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "../src/lib/db";
import { intakeBatch, type PageOutcome } from "../src/lib/competitors/news/run";
import { notifyNewsBatch } from "../src/lib/competitors/news/email";
import type { NewsPage, NewsPiece } from "../src/lib/competitors/news/intake";

interface Expected {
  verdict: "new" | "covered" | "other";
  size?: "capability" | "feature";
  /** A new feature: the name of its capability on the list. */
  parent?: string;
  /** Covered: names of the list items that count as the right answer (the item itself, or its capability). */
  coveredBy?: string[];
  otherType?: string;
}
interface FixturePage extends NewsPage { id: string; what_it_tests: string; expected: Expected[] }
interface Fixture { organization: string; competitor: string; pages: FixturePage[] }

const args = process.argv.slice(2);
const fixturePath = args.find((a) => !a.startsWith("--"));
if (!fixturePath) {
  console.error("Usage: npm run competitors:news-sim -- <fixture.json> [--email] [--table]");
  process.exit(2);
}
const sendMail = args.includes("--email");
const tableDryRun = args.includes("--table");

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How well one found piece answers one expected piece: 2 = fully right, 1 = right verdict but wrong place/size/type, 0 = wrong verdict. */
function grade(e: Expected, p: NewsPiece, capabilityOf: (id: string) => string | null): 0 | 1 | 2 {
  if (p.verdict !== e.verdict) return 0;
  if (e.verdict === "new") {
    if (e.size && p.size !== e.size) return 1;
    if (e.parent && !(p.parent && same(p.parent.name, e.parent))) return 1;
    return p.quoteOk ? 2 : 1;
  }
  if (e.verdict === "covered") {
    if (!e.coveredBy?.length || !p.covered) return 2;
    const names = [p.covered.name, capabilityOf(p.covered.id) ?? ""];
    return e.coveredBy.some((n) => names.some((x) => same(x, n))) ? 2 : 1;
  }
  return !e.otherType || p.otherType === e.otherType ? 2 : 1;
}

const describe = (p: NewsPiece) =>
  p.verdict === "new" ? `new ${p.size}${p.parent ? ` under "${p.parent.name}"` : ""}: ${p.name}${p.quoteOk ? "" : " [quote not on page]"}`
  : p.verdict === "covered" ? `covered by "${p.covered?.name}": ${p.name}`
  : `other/${p.otherType}: ${p.name}`;
const describeExpected = (e: Expected) =>
  e.verdict === "new" ? `new ${e.size ?? ""}${e.parent ? ` under "${e.parent}"` : ""}` : e.verdict === "covered" ? `covered by ${(e.coveredBy ?? []).map((n) => `"${n}"`).join(" or ")}` : `other/${e.otherType ?? "any"}`;

async function main() {
  const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Fixture;
  const competitor = await db.competitor.findFirst({
    where: { name: fixture.competitor, workspace: { organization: { name: fixture.organization } } },
    select: { id: true, name: true, workspaceId: true },
  });
  if (!competitor) throw new Error(`No competitor "${fixture.competitor}" in organization "${fixture.organization}" in this database.`);
  const removed = await db.competitorNews.deleteMany({ where: { competitorId: competitor.id, simulated: true } });
  console.log(`[news-sim] ${fixture.competitor} (${fixture.organization}) · ${fixture.pages.length} made-up pages · ${removed.count} earlier simulated rows removed`);

  const items = await db.competitorItem.findMany({ where: { competitorId: competitor.id }, select: { id: true, name: true, parentItemId: true } });
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  const capabilityOf = (id: string) => { const parent = items.find((i) => i.id === id)?.parentItemId; return parent ? nameOf.get(parent) ?? null : null; };

  const started = Date.now();
  const batch = await intakeBatch(competitor, fixture.pages, { simulated: true, atOnce: 4, onPage: (o) => console.log(`[news-sim]   read ${o.page.url.split("/").slice(-2).join("/")} · ${o.error ? `FAILED: ${o.error}` : `${o.pieces.length} piece(s) · ${o.inputTokens}+${o.outputTokens} tokens · ${(o.ms / 1000).toFixed(1)}s`}`) });
  const wall = Date.now() - started;

  // ——— score ———
  let expectedTotal = 0, full = 0, partial = 0, missed = 0, extra = 0, falseNew = 0;
  const lines: string[] = [];
  const pageResults = fixture.pages.map((page, i) => {
    const o: PageOutcome = batch.pages[i];
    const left = [...o.pieces];
    const rows = page.expected.map((e) => {
      expectedTotal++;
      // The best piece still unclaimed answers this expectation.
      let best = -1, bestGrade: 0 | 1 | 2 = 0;
      left.forEach((p, k) => { const g = grade(e, p, capabilityOf); if (g > bestGrade) { best = k; bestGrade = g; } });
      const got = best >= 0 ? left.splice(best, 1)[0] : null;
      if (bestGrade === 2) full++; else if (bestGrade === 1) partial++; else missed++;
      return { expected: describeExpected(e), got: got ? describe(got) : null, grade: bestGrade, reason: got?.reason ?? null };
    });
    extra += left.length;
    falseNew += left.filter((p) => p.verdict === "new").length;
    const mark = o.error ? "ERROR" : rows.every((r) => r.grade === 2) && left.length === 0 ? "PASS " : rows.some((r) => r.grade === 0) || left.some((p) => p.verdict === "new") ? "FAIL " : "PART ";
    lines.push(`${mark} ${page.id}  ${page.title}`);
    for (const r of rows) lines.push(`        expected ${r.expected}\n        got      ${r.got ?? "nothing"}${r.grade === 2 ? "" : r.grade === 1 ? "   ← right verdict, wrong detail" : "   ← WRONG"}`);
    for (const p of left) lines.push(`        extra    ${describe(p)}${p.verdict === "new" ? "   ← FALSE NEW (noise)" : ""}`);
    if (o.error) lines.push(`        ${o.error}`);
    return { id: page.id, title: page.title, tests: page.what_it_tests, mark: mark.trim(), rows, extra: left.map(describe), error: o.error, pageIsAbout: o.pageIsAbout, pieces: o.pieces, tokens: { input: o.inputTokens, output: o.outputTokens }, ms: o.ms };
  });
  const inTok = batch.pages.reduce((s, o) => s + o.inputTokens, 0);
  const outTok = batch.pages.reduce((s, o) => s + o.outputTokens, 0);
  const failedPages = batch.pages.filter((o) => o.error).length;
  const summary = [
    `SIMULATION SCORE: ${full} of ${expectedTotal} expected pieces fully right · ${partial} right verdict, wrong detail · ${missed} wrong or missing`,
    `Noise: ${extra} piece(s) nobody expected, ${falseNew} of them a false "new"`,
    `Cost: ${inTok.toLocaleString("en-US")} input + ${outTok.toLocaleString("en-US")} output tokens for ${fixture.pages.length} pages (${Math.round(inTok / fixture.pages.length).toLocaleString("en-US")} + ${Math.round(outTok / fixture.pages.length).toLocaleString("en-US")} per page) · ${(wall / 1000).toFixed(0)}s in all, ${(batch.pages.reduce((s, o) => s + o.ms, 0) / fixture.pages.length / 1000).toFixed(1)}s per page`,
  ];
  console.log("\n" + lines.join("\n") + "\n\n" + summary.join("\n"));

  // ——— the table step, as a dry run ———
  let tableLines: string[] = [];
  if (tableDryRun) {
    try {
      const { tableDryRunFor } = await import("../src/lib/competitors/news/table-dry-run");
      tableLines = await tableDryRunFor(competitor, batch.batchId);
      console.log("\n" + tableLines.join("\n"));
    } catch (e) {
      tableLines = [`TABLE DRY RUN failed: ${e instanceof Error ? e.message : String(e)}`];
      console.log("\n" + tableLines[0]);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(dirname(fixturePath!), `results-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), batchId: batch.batchId, summary, pages: pageResults, table: tableLines }, null, 2));
  console.log(`\n[news-sim] full result: ${outPath}`);

  if (sendMail) {
    const sent = await notifyNewsBatch(batch.batchId, { pages: fixture.pages.length, failedPages, appendix: [...summary, "", ...lines, ...(tableLines.length ? ["", ...tableLines] : [])] });
    console.log(`[news-sim] email ${sent.sent ? "sent" : "NOT sent (no mail server configured — printed above)"} to ${sent.to}: ${sent.subject}`);
  }
  if (failedPages) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(`[news-sim] ${e instanceof Error ? e.stack ?? e.message : e}`); process.exitCode = 1; })
  .finally(() => db.$disconnect());
