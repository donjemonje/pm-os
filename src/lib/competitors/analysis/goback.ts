import { db } from "../../db";
import type { RunContext } from "./engine";
import { dueForGoBack, GO_BACK_MAX_ROUNDS, GO_BACK_PAGES_PER_ITEM, hasGap, pickForItemCounted, savedGoBackRounds, sortGoBackItems, type GapFinding, type GoBackItem } from "./gaps";
import { planOf } from "./plan";
import { RESEARCH_VERSION } from "./prompts";
import { indexPages, type LookPage } from "./secondlook";
import { budgetCap, matchStep, mergeStep, readablePages, readPages, tableRows } from "./steps";
import { readKey, researchTodo } from "./todo";

/**
 * Going back for the gaps — the database side (Capability Analysis, "Map, read, go back"; the rules are gaps.ts).
 *
 * After the match: every capability item of the competitor that is in the table and has a gap picks the unread deep
 * pages most likely to be about it; they are read with the normal research call, then merged and matched. At most
 * GO_BACK_MAX_ROUNDS rounds per run.
 *
 * Resumable like every step: the pages a round chose are saved in the run's cursor BEFORE they are read, so a run
 * that stopped reads what is left of the same pages (a page already read carries its key and is not read twice),
 * merges and matches what is left, and goes on with the next round. Nothing else is remembered: which items have a
 * gap is computed from the tables every time.
 */

const CHUNK = 1000;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Lets the heartbeat and other requests run between two items of a long scoring loop. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The capability items of the competitor that are in the table, have a gap, and are due (gaps.ts dueForGoBack).
 * "In the table": matched to a row of ours that has cells (an active capability in a domain of the table), or none
 * of ours and carried by enough pages to become a row in the apply step.
 */
async function openItems(ctx: RunContext): Promise<GoBackItem[]> {
  const competitorId = ctx.competitor.id;
  const [items, findings, table, plan] = await Promise.all([
    db.competitorItem.findMany({ where: { competitorId }, select: { id: true, kind: true, key: true, name: true, wordings: true, parentItemId: true, capabilityId: true, featureId: true, placement: true, gapCheckedAt: true } }),
    db.pageFinding.findMany({
      where: { competitorId, origin: "research", itemId: { not: null } },
      select: { itemId: true, pageId: true, wording: true, description: true, createdAt: true, page: { select: { url: true, kind: true, sourceId: true, source: { select: { type: true } } } } },
    }),
    tableRows(ctx.run.workspaceId),
    planOf(ctx),
  ]);
  const inTable = new Set(table.capabilities.map((k) => k.id));
  const byItem = new Map<string, typeof findings>();
  for (const f of findings) byItem.set(f.itemId!, [...(byItem.get(f.itemId!) ?? []), f]);
  const featuresOf = new Map<string, string[]>();
  for (const i of items) if (i.kind === "feature" && i.parentItemId) featuresOf.set(i.parentItemId, [...(featuresOf.get(i.parentItemId) ?? []), i.id]);
  const gapFindings = (itemId: string): GapFinding[] =>
    (byItem.get(itemId) ?? []).map((f) => ({ description: f.description, pageKind: plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind }).kind }));
  const out: GoBackItem[] = [];
  for (const item of items) {
    if (item.kind !== "capability") continue;
    const own = byItem.get(item.id) ?? [];
    const shown = item.capabilityId ? inTable.has(item.capabilityId) : !item.featureId && item.placement != null && new Set(own.map((f) => f.pageId)).size >= ctx.minPagesForNewRow;
    if (!shown) continue;
    const features = featuresOf.get(item.id) ?? [];
    const newest = [item.id, ...features].flatMap((id) => (byItem.get(id) ?? []).map((f) => f.createdAt.getTime())).reduce((a, b) => Math.max(a, b), 0);
    if (!dueForGoBack({ gapCheckedAt: item.gapCheckedAt, newestFindingAt: newest ? new Date(newest) : null })) continue;
    if (!hasGap({ findings: gapFindings(item.id), features: features.map((id) => ({ findings: gapFindings(id) })) })) continue;
    out.push({ id: item.id, key: item.key, terms: [...new Set([item.name, ...own.map((f) => f.wording), ...strings(item.wordings)])] });
  }
  return sortGoBackItems(out);
}

/**
 * The pages one round reads: for each open item its most likely unread deep pages. `taken` = the pages earlier rounds chose.
 * `probe` = only asked what a round beyond the last allowed one WOULD read (the rounds cap, caps.ts): nothing is
 * logged and nothing is recorded; `served` = the items that would get a page.
 */
async function pickRound(ctx: RunContext, round: number, taken: Set<string>, probe = false): Promise<{ pageIds: string[]; served: number }> {
  const none = { pageIds: [], served: 0 };
  const open = await openItems(ctx);
  if (!open.length) {
    if (round === 1 && !probe) ctx.log("info", "Go back: no capability of theirs has a new gap — nothing to read");
    return none;
  }
  const unread = (await readablePages(ctx)).filter((p) => p.read.role === "deep" && p.analyzedKey !== readKey(RESEARCH_VERSION, p.hash) && !taken.has(p.id));
  if (!unread.length) {
    if (!probe) ctx.log("info", `Go back, round ${round}: ${open.length} capabilit${open.length === 1 ? "y of theirs has" : "ies of theirs have"} a gap, and there is no unread deep page to go back to`);
    return none;
  }
  const pool: LookPage[] = [];
  for (let i = 0; i < unread.length; i += CHUNK) {
    const rows = await db.sourcePage.findMany({ where: { id: { in: unread.slice(i, i + CHUNK).map((p) => p.id) } }, select: { id: true, url: true, title: true, text: true, hash: true } });
    for (const r of rows) if (r.text != null) pool.push({ id: r.id, url: r.url, title: r.title ?? "", text: r.text, hash: r.hash });
  }
  const indexed = indexPages(pool);
  const picked = new Set<string>();
  const pageIds: string[] = [];
  let served = 0;
  /** Items that had more likely pages than an item may go back to, and the pages that left unread. */
  let cutItems = 0;
  let cutPages = 0;
  for (const item of open) {
    const { picked: ids, candidates } = pickForItemCounted(item, indexed, picked, GO_BACK_PAGES_PER_ITEM);
    if (ids.length) served++;
    if (candidates > ids.length) {
      cutItems++;
      cutPages += candidates - ids.length;
    }
    pageIds.push(...ids);
    await breathe();
  }
  if (probe) return { pageIds, served };
  if (cutItems) ctx.cap("go_back_pages_per_item", { limit: GO_BACK_PAGES_PER_ITEM, undone: cutPages, times: cutItems });
  ctx.log("info", `Go back, round ${round}: ${open.length} capabilit${open.length === 1 ? "y of theirs has" : "ies of theirs have"} a gap (no description beyond marketing pages, no feature, or a feature with no description) — ${pageIds.length} of ${unread.length} unread deep page${unread.length === 1 ? "" : "s"} picked for ${served} of them`);
  return { pageIds, served };
}

export async function goBackStep(ctx: RunContext): Promise<void> {
  const rounds = savedGoBackRounds(ctx.run.cursor);
  // False once the run's token budget stopped the reading: the items were not gone back for to the end, so they stay due.
  let complete = true;
  /** Every allowed round was made and each read pages: more may have been due than the rounds allow. */
  let exhausted = true;
  for (let round = 1; round <= GO_BACK_MAX_ROUNDS; round++) {
    let pageIds = rounds[round - 1];
    if (!pageIds) {
      if (ctx.reading.reached) {
        ctx.log("warn", `Go back: not started${round > 1 ? ` (round ${round})` : ""} — the run's token budget (${ctx.reading.limit.toLocaleString("en-US")}) was reached. The gaps stay open for the next run`);
        budgetCap(ctx);
        complete = false;
        exhausted = false;
        break;
      }
      pageIds = (await pickRound(ctx, round, new Set(rounds.flat()))).pageIds;
      if (!pageIds.length) {
        exhausted = false;
        break;
      }
      // Saved before a page is read: a run that stops here reads the same pages when it continues.
      rounds.push(pageIds);
      await ctx.saveCursor({ goBack: { rounds } });
      ctx.counters.goBackRounds = rounds.length;
      ctx.counters.goBackPages += pageIds.length;
      ctx.progress.pagesTotal += pageIds.length;
    }
    const ids = new Set(pageIds);
    const todo = researchTodo((await readablePages(ctx)).filter((p) => ids.has(p.id)), RESEARCH_VERSION);
    const r = await readPages(ctx, todo);
    ctx.log(r.left ? "warn" : "info", `Go back, round ${round}: ${r.read} page${r.read === 1 ? "" : "s"} read${r.failed ? `, ${r.failed} skipped (unusable answer)` : ""}${todo.length < pageIds.length ? ` (${pageIds.length - todo.length} of the round's pages were read before the run stopped, or are gone)` : ""}${r.left ? ` — the run's token budget (${ctx.reading.limit.toLocaleString("en-US")}) was reached: ${r.left} page${r.left === 1 ? "" : "s"} left unread` : ""}`);
    // What was read is merged and matched also when the budget cut the round short: the table is filled from what was read.
    await mergeStep(ctx);
    await matchStep(ctx);
    if (r.left) {
      complete = false;
      exhausted = false;
      break;
    }
  }
  // The rounds cap: after the last allowed round, would one more round still read pages? Then more was due than
  // allowed — asked with the same picking a round uses, before the items are marked as checked.
  if (exhausted) {
    const more = await pickRound(ctx, GO_BACK_MAX_ROUNDS + 1, new Set(rounds.flat()), true);
    if (more.pageIds.length) ctx.cap("go_back_rounds", { limit: GO_BACK_MAX_ROUNDS, undone: more.served, also: more.pageIds.length });
  }
  // The rounds are over: every capability item was checked for gaps as of now. A later run goes back for an item
  // only when it got a finding after this moment (gaps.ts dueForGoBack). Not when the budget cut the reading short.
  if (complete) await db.competitorItem.updateMany({ where: { competitorId: ctx.competitor.id, kind: "capability" }, data: { gapCheckedAt: new Date() } });
  await ctx.flush();
}
