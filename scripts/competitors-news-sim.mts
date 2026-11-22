/**
 * The news simulation — made-up pages of a company that has a list, sent through the real news intake
 * (src/lib/competitors/news), scored against an answer key:
 *
 *   npm run competitors:news-sim -- <fixture.json> [--list=<items.json>] [--check] [--email] [--table]
 *
 * The fixture names an organization and one of its competitors, and holds the pages; each page says what is
 * expected of it (new / covered / other). A page that carries `previousText` is a CHANGED page: only its changed
 * text is sent. The run:
 *   1. removes the simulated news of that competitor left by an earlier simulation (real news is never touched);
 *   2. sends the pages through the intake, several per request — the real prompt, the real model, the real rows
 *      (marked simulated);
 *   3. scores each expected piece and prints a line per page, the totals, the tokens and the time;
 *   4. writes the full result next to the fixture (results-<time>.json);
 *   5. --table: asks the table step what it WOULD do with the new abilities — a dry run, nothing is written;
 *   6. --email: sends the batch's one notification (to PM-OS only): the new abilities and nothing else.
 * --list: the company's list comes from a knowledge-base file (the "items" of a read, features-v3) instead of the database.
 * --check: prints what would be sent (the list size, the requests, the changed text of changed pages) and asks nothing.
 * The new abilities then show in the news feed of that organization.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "../src/lib/db";
import { GEMINI_TEMPERATURE } from "../src/lib/competitors/ai";
import { intakeBatch, loadNewsList } from "../src/lib/competitors/news/run";
import { notifyNewsBatch } from "../src/lib/competitors/news/email";
import { newsModel, NEWS_THINKING } from "../src/lib/competitors/news/model";
import { codeList, NEWS_VERSION, planRequests, renderList, type NewsList, type NewsPage, type NewsPiece } from "../src/lib/competitors/news/intake";

interface Expected {
  verdict: "new" | "covered" | "other";
  /** Covered: names of the list items that count as the right answer (the item itself, or the capability it sits under in the database). */
  coveredBy?: string[];
  otherType?: string;
}
interface FixturePage extends NewsPage { id: string; what_it_tests: string; expected: Expected[] }
interface Fixture { organization: string; competitor: string; pages: FixturePage[] }

const args = process.argv.slice(2);
const fixturePath = args.find((a) => !a.startsWith("--"));
if (!fixturePath) {
  console.error("Usage: npm run competitors:news-sim -- <fixture.json> [--list=<items.json>] [--check] [--email] [--table]");
  process.exit(2);
}
const sendMail = args.includes("--email");
const tableDryRun = args.includes("--table");
const checkOnly = args.includes("--check");
const listFile = args.find((a) => a.startsWith("--list="))?.slice(7);

/** The list from a knowledge-base file: the features of a read, each with how it works, and the tools it connects to. */
function listFromFile(path: string): NewsList {
  const kb = JSON.parse(readFileSync(path, "utf8")) as { items: Array<{ name: string; company_name?: string; how_it_works?: string }>; integrations?: Array<{ tool: string }> };
  return codeList(kb.items.map((i) => ({ id: null, name: i.name, companyName: i.company_name ?? "", description: i.how_it_works ?? "" })), [...new Set((kb.integrations ?? []).map((t) => t.tool))]);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How well one found piece answers one expected piece: 2 = fully right, 1 = right verdict but wrong item or type, 0 = wrong verdict. */
function grade(e: Expected, p: NewsPiece, capabilityOf: (id: string | null) => string | null, listHas: (name: string) => boolean): 0 | 1 | 2 {
  if (p.verdict !== e.verdict) return 0;
  if (e.verdict === "new") return p.quoteOk ? 2 : 1;
  if (e.verdict === "covered") {
    // The answer key names items of the database list; with another list (a file) only the verdict can be scored.
    const key = (e.coveredBy ?? []).filter(listHas);
    if (!key.length || !p.covered) return 2;
    const names = [p.covered.name, capabilityOf(p.covered.id) ?? ""];
    return key.some((n) => names.some((x) => same(x, n))) ? 2 : 1;
  }
  return !e.otherType || p.otherType === e.otherType ? 2 : 1;
}

const describe = (p: NewsPiece) =>
  p.verdict === "new" ? `new: ${p.name}${p.companyName ? ` (${p.companyName})` : ""}${p.quoteOk ? "" : " [quote not on page]"}`
  : p.verdict === "covered" ? `covered by "${p.covered?.name}": ${p.name}`
  : `other/${p.otherType}: ${p.name}`;
const describeExpected = (e: Expected) =>
  e.verdict === "new" ? "new" : e.verdict === "covered" ? `covered by ${(e.coveredBy ?? []).map((n) => `"${n}"`).join(" or ")}` : `other/${e.otherType ?? "any"}`;

async function main() {
  const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Fixture;
  const competitor = await db.competitor.findFirst({
    where: { name: fixture.competitor, workspace: { organization: { name: fixture.organization } } },
    select: { id: true, name: true, workspaceId: true },
  });
  if (!competitor) throw new Error(`No competitor "${fixture.competitor}" in organization "${fixture.organization}" in this database.`);
  const list = listFile ? listFromFile(listFile) : await loadNewsList(competitor.id);
  const plan = planRequests(fixture.pages);
  const settings = `prompt ${NEWS_VERSION} · model ${newsModel()}, thinking ${NEWS_THINKING}, temperature ${GEMINI_TEMPERATURE}`;
  console.log(`[news-sim] ${fixture.competitor} (${fixture.organization}) · ${settings}`);
  console.log(`[news-sim] list: ${list.features.length} features${listFile ? ` from ${listFile}` : " from the database"}, ${list.integrations.length} known integrations · ~${Math.round(renderList(competitor.name, list).length / 4000)}K tokens`);
  console.log(`[news-sim] ${fixture.pages.length} made-up pages → ${plan.requests.length} request(s): ${plan.requests.map((r) => `${r.length} pages, ~${Math.round(r.reduce((n, p) => n + p.sent.length, 0) / 4000)}K tokens`).join(" | ")}${plan.nothingNew.length ? ` · ${plan.nothingNew.length} changed page(s) with nothing new, not sent` : ""}`);
  if (checkOnly) {
    for (const p of plan.requests.flat().filter((p) => p.status === "changed")) console.log(`\n--- ${p.code} (changed) ${p.page.url}: what is sent\n${p.sent}`);
    console.log("\n[news-sim] check only: nothing sent.");
    return;
  }
  const removed = await db.competitorNews.deleteMany({ where: { competitorId: competitor.id, simulated: true } });
  console.log(`[news-sim] ${removed.count} earlier simulated rows removed`);

  const items = await db.competitorItem.findMany({ where: { competitorId: competitor.id }, select: { id: true, name: true, parentItemId: true } });
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  const capabilityOf = (id: string | null) => { const parent = items.find((i) => i.id === id)?.parentItemId; return parent ? nameOf.get(parent) ?? null : null; };
  const listHas = (name: string) => list.features.some((f) => same(f.name, name));

  const started = Date.now();
  const batch = await intakeBatch(competitor, fixture.pages, { simulated: true, list, onRequest: (o, i, of) => console.log(`[news-sim]   request ${i + 1} of ${of} · ${o.pages.length} pages · ${o.error ? `FAILED: ${o.error}` : `${o.pieces.length} piece(s) · asked ${o.asks}× · ${o.inputTokens}+${o.outputTokens} tokens · ${(o.ms / 1000).toFixed(1)}s${o.unanswered.length ? ` · NOT ANSWERED: ${o.unanswered.map((p) => p.code).join(", ")}` : ""}`}`) });
  const wall = Date.now() - started;
  const pieces = batch.requests.flatMap((o) => o.pieces);
  const errorOf = (url: string) => { const o = batch.requests.find((r) => r.pages.some((p) => p.page.url === url)); return !o ? null : o.error ?? (o.unanswered.some((p) => p.page.url === url) ? "the answer left this page out" : null); };

  // ——— score ———
  let expectedTotal = 0, full = 0, partial = 0, missed = 0, extra = 0, falseNew = 0;
  const lines: string[] = [];
  const pageResults = fixture.pages.map((page) => {
    const error = errorOf(page.url);
    const left = pieces.filter((p) => p.page.page.url === page.url);
    const found = [...left];
    const rows = page.expected.map((e) => {
      expectedTotal++;
      // The best piece still unclaimed answers this expectation.
      let best = -1, bestGrade: 0 | 1 | 2 = 0;
      left.forEach((p, k) => { const g = grade(e, p, capabilityOf, listHas); if (g > bestGrade) { best = k; bestGrade = g; } });
      const got = best >= 0 ? left.splice(best, 1)[0] : null;
      if (bestGrade === 2) full++; else if (bestGrade === 1) partial++; else missed++;
      return { expected: describeExpected(e), got: got ? describe(got) : null, grade: bestGrade, reason: got?.reason ?? null };
    });
    extra += left.length;
    falseNew += left.filter((p) => p.verdict === "new").length;
    const mark = error ? "ERROR" : rows.every((r) => r.grade === 2) && !left.some((p) => p.verdict === "new") ? "PASS " : rows.some((r) => r.grade === 0) || left.some((p) => p.verdict === "new") ? "FAIL " : "PART ";
    lines.push(`${mark} ${page.id}  ${page.previousText != null ? "[changed page] " : ""}${page.title}`);
    for (const r of rows) lines.push(`        expected ${r.expected}\n        got      ${r.got ?? "nothing"}${r.grade === 2 ? "" : r.grade === 1 ? "   ← right verdict, wrong detail" : "   ← WRONG"}`);
    for (const p of left) lines.push(`        extra    ${describe(p)}${p.verdict === "new" ? "   ← FALSE NEW (noise)" : ""}`);
    if (error) lines.push(`        ${error}`);
    return { id: page.id, title: page.title, tests: page.what_it_tests, mark: mark.trim(), rows, extra: left.map(describe), error, pieces: found.map((p) => ({ ...p, page: p.page.code })) };
  });
  const inTok = batch.requests.reduce((s, o) => s + o.inputTokens, 0);
  const outTok = batch.requests.reduce((s, o) => s + o.outputTokens, 0);
  const failedPages = batch.failedPages;
  const summary = [
    `SIMULATION SCORE: ${full} of ${expectedTotal} expected pieces fully right · ${partial} right verdict, wrong detail · ${missed} wrong or missing`,
    `Noise: ${extra} piece(s) nobody expected, ${falseNew} of them a false "new"`,
    `Settings: ${settings}`,
    `Cost: ${inTok.toLocaleString("en-US")} input + ${outTok.toLocaleString("en-US")} output tokens for ${fixture.pages.length} pages in ${batch.requests.length} request(s) (${Math.round(inTok / fixture.pages.length).toLocaleString("en-US")} + ${Math.round(outTok / fixture.pages.length).toLocaleString("en-US")} per page) · ${(wall / 1000).toFixed(0)}s in all`,
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
  writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), batchId: batch.batchId, settings, summary, pages: pageResults, table: tableLines }, null, 2));
  console.log(`\n[news-sim] full result: ${outPath}`);

  if (sendMail) {
    const sent = await notifyNewsBatch(batch.batchId);
    console.log(sent.abilities === 0 ? "[news-sim] no new ability: no email" : `[news-sim] email ${sent.sent ? "sent" : "NOT sent (no mail server configured)"} to ${sent.to}: ${sent.subject} (${sent.abilities} abilities)`);
  }
  if (failedPages) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(`[news-sim] ${e instanceof Error ? e.stack ?? e.message : e}`); process.exitCode = 1; })
  .finally(() => db.$disconnect());
