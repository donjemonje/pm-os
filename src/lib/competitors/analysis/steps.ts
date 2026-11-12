import { Prisma } from "@prisma/client";
import { db } from "../../db";
import type { AnswerError } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { COMPETITORS_COPY as C } from "../copy";
import { aliasList, judgeNewRow, NameIndex, placeInDomain, type Resolved } from "../decisions";
import { cellFromEvidence, type CellFromEvidence, type Evidence } from "./cells";
import { AnalysisError, queueCatalogAnalyses, type RunContext } from "./engine";
import { canonicalName, findItem, itemKey, ownKey, planChildMerges, planMerges, wordingKey, type ItemLite, type MergePlan } from "./items";
import { batchItems, buildCatalog, type Catalog } from "./match";
import { analysisConcurrency, estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { loadPages, planOf, type StoredPage } from "./plan";
import {
  LOOK_MAX_TOKENS,
  LOOK_SYSTEM_PROMPT,
  lookTool,
  MATCH_MAX_TOKENS,
  MATCH_SYSTEM_PROMPT,
  matchTool,
  MERGE_MAX_CAPABILITY_LINES,
  MERGE_MAX_FEATURE_LINES,
  MERGE_MAX_TOKENS,
  MERGE_SYSTEM_PROMPT,
  MERGE_TOOL,
  parseMatch,
  parseMerge,
  parseResearch,
  parseSecondLook,
  renderMatchTail,
  renderMergeCapabilities,
  renderMergeFeatures,
  renderResearch,
  renderSecondLook,
  RESEARCH_MAX_TOKENS,
  RESEARCH_SYSTEM_PROMPT,
  RESEARCH_TOOL,
  RESEARCH_VERSION,
  type MatchTheirEntry,
  type MergeEntry,
  type Placement,
} from "./prompts";
import { capLooks, indexPages, lookKey, pagesFor, type LookPage } from "./secondlook";
import { pickReadable, sortForReading, type PageRead, type ReadingPlan } from "./sections";
import { readKey, researchTodo, rowsSince, tooManyFailed } from "./todo";

/**
 * The database side of the steps of an analysis run after the map (Capability Analysis, "How the analysis runs";
 * the map step is analysis/plan.ts). Every step computes its to-do from the tables and saves each unit of work in
 * one transaction, so a run that stopped continues with exactly what is left. The rules themselves are the pure
 * modules next to this file.
 */

/** Tokens of instructions and schema a research call carries besides the page. */
const RESEARCH_OVERHEAD_TOKENS = 450;
const CHUNK = 1000;

/** A stored page the analysis may read, with how it is read (sections.ts PageRead). */
export type ReadablePage = StoredPage & { read: PageRead };

/** The pages the analysis may read (sections.ts): broad and deep pages, plus weak ones when the workspace reads them. */
export async function readablePages(ctx: RunContext): Promise<ReadablePage[]> {
  return pickReadable(await loadPages(ctx.competitor.id), await planOf(ctx), { readWeak: ctx.readWeak });
}

// ————— 1. Research: one call per page —————

export interface ResearchPlan {
  /** Pages of the broad read. */
  picked: number;
  /** Deep pages: read only when the run goes back for a gap. */
  deep: number;
  /** The pages whose current text was not read yet, in reading order (sections.ts sortForReading). */
  todo: ReadablePage[];
}

/**
 * Clean-up (code only, every run) and the to-do of the broad read. A finding lives only while its page may be read
 * and its text is the text it was read from: findings of pages that left the readable set (removed, text gone, a
 * section that is not read, weak pages switched off) are deleted and the page is marked not analyzed.
 *
 * The to-do: the broad pages whose current text was not read — and the deep pages that WERE read before (a go-back
 * of an earlier run) and changed since, so what is shown from them stays true. A deep page nobody went back for is
 * never on it.
 */
export async function planResearch(ctx: RunContext): Promise<ResearchPlan> {
  const pages = await loadPages(ctx.competitor.id);
  const readable = pickReadable(pages, await planOf(ctx), { readWeak: ctx.readWeak });
  const readableIds = new Set(readable.map((p) => p.id));
  const dropped = pages.filter((p) => !readableIds.has(p.id)).map((p) => p.id);
  let removed = 0;
  for (let i = 0; i < dropped.length; i += CHUNK) {
    const ids = dropped.slice(i, i + CHUNK);
    removed += (await db.pageFinding.deleteMany({ where: { competitorId: ctx.competitor.id, pageId: { in: ids } } })).count;
    await db.sourcePage.updateMany({ where: { id: { in: ids }, analyzedKey: { not: null } }, data: { analyzedKey: null, analysisError: null } });
  }
  if (removed) {
    ctx.counters.findingsRemoved += removed;
    ctx.log("info", `${removed} finding${removed === 1 ? "" : "s"} removed: their pages are no longer read (removed, emptied, or in a section that is not read)`);
  }
  const broad = readable.filter((p) => p.read.role !== "deep");
  const deep = readable.length - broad.length;
  const todo = sortForReading(researchTodo(readable.filter((p) => p.read.role !== "deep" || p.analyzedKey != null), RESEARCH_VERSION));
  if (ctx.progress.pagesTotal === 0) {
    ctx.progress.pagesTotal = todo.length;
    ctx.progress.pagesDone = 0;
  }
  ctx.log("info", `${pages.length} stored page${pages.length === 1 ? "" : "s"}: ${broad.length} in the broad read${ctx.readWeak ? " (news sections included)" : ""}, ${deep} deep page${deep === 1 ? "" : "s"} (read only when the run goes back for a gap), ${todo.length} new or changed since they were last read`);
  await ctx.flush();
  return { picked: broad.length, deep, todo };
}

function injectedResearch(ctx: RunContext, url: string): string | undefined {
  if (!ctx.answers) return undefined;
  return ctx.answers.research?.[url] ?? ctx.answers.research?.["*"] ?? '{"capabilities": []}';
}

/**
 * The research call for each page of a to-do, in its order: the broad read and the pages a go-back round chose
 * read through here. One call per page; the findings and the mark on the page are saved in one transaction.
 */
export async function readPages(ctx: RunContext, todo: ReadablePage[]): Promise<{ read: number; failed: number }> {
  const competitorId = ctx.competitor.id;
  let failed = 0;
  if (!todo.length) return { read: 0, failed };
  await ctx.paced({
    items: todo,
    concurrency: analysisConcurrency(),
    estimate: (p) => estimateTokens(p.chars) + RESEARCH_OVERHEAD_TOKENS + OUTPUT_RESERVE,
    work: async (p) => {
      // The text and its hash in one read: the key written below is the hash of the text that was read, so a page
      // a scan changes meanwhile is simply due again.
      const page = await db.sourcePage.findUnique({ where: { id: p.id }, select: { text: true, hash: true, title: true, kind: true } });
      if (!page || page.text == null) return 0;
      const r = await ctx.call<Record<string, unknown>>(
        RESEARCH_SYSTEM_PROMPT,
        "",
        // A page of a "compare" section: only what it says the competitor itself offers is listed.
        renderResearch({ url: p.url, title: page.title ?? "", text: page.text, kind: page.kind, sourceLabel: C.profile.sourceTypes[p.sourceType] ?? p.sourceType }, { compareCompany: p.read.label === "compare" ? ctx.competitor.name : null }),
        RESEARCH_TOOL,
        { maxTokens: RESEARCH_MAX_TOKENS, thinking: "low", injected: injectedResearch(ctx, p.url) },
      );
      const parsed = parseResearch(r.value, page.text);
      await db.$transaction([
        db.pageFinding.deleteMany({ where: { pageId: p.id } }),
        db.pageFinding.createMany({
          data: parsed.findings.map((f) => ({
            workspaceId: ctx.run.workspaceId, competitorId, pageId: p.id, pageHash: page.hash, analysisId: ctx.run.id, origin: "research",
            kind: f.kind, wording: f.wording, parentWording: f.parentWording, quote: f.quote, reasoning: f.reasoning, description: f.description,
          })),
        }),
        db.sourcePage.update({ where: { id: p.id }, data: { analyzedKey: readKey(RESEARCH_VERSION, page.hash), analyzedAt: new Date(), analysisError: null } }),
      ]);
      ctx.progress.pagesDone++;
      ctx.counters.pagesRead++;
      ctx.counters.findings += parsed.findings.length;
      ctx.counters.quotesDropped += parsed.dropped.noQuote;
      ctx.counters.piiHits += parsed.dropped.pii;
      if (parsed.dropped.over) ctx.log("warn", `${parsed.dropped.over} item${parsed.dropped.over === 1 ? "" : "s"} beyond the per-page limit were left out`, p.url);
      return r.tokens;
    },
    // A page whose answer is unusable is recorded and skipped: it is asked again only when its text or the prompt changes.
    onAnswerError: async (p, e: AnswerError) => {
      await db.$transaction([
        db.pageFinding.deleteMany({ where: { pageId: p.id } }),
        db.sourcePage.update({ where: { id: p.id }, data: { analyzedKey: readKey(RESEARCH_VERSION, p.hash), analyzedAt: new Date(), analysisError: e.message.slice(0, 300) } }),
      ]);
      failed++;
      ctx.progress.pagesDone++;
      ctx.counters.pagesFailed++;
      ctx.log("warn", `Page skipped — PMOS AI's answer was unusable: ${e.message.slice(0, 200)}`, p.url);
      // Many unusable answers are the model's or the prompt's problem, not a page's.
      if (tooManyFailed(failed, todo.length)) throw new AnalysisError("answer", `${failed} of ${todo.length} pages got an unusable answer from PMOS AI — stopping`);
    },
  });
  return { read: todo.length - failed, failed };
}

/** The broad read: every page of the plan's to-do. */
export async function researchStep(ctx: RunContext, plan: ResearchPlan): Promise<void> {
  const competitorId = ctx.competitor.id;
  if (plan.todo.length) {
    const r = await readPages(ctx, plan.todo);
    ctx.log("info", `Research: ${r.read} page${r.read === 1 ? "" : "s"} read${r.failed ? `, ${r.failed} skipped (unusable answer)` : ""}`);
    const total = ctx.counters.findings + ctx.counters.quotesDropped;
    if (total > 0 && ctx.counters.quotesDropped > total / 4) ctx.log("warn", `${ctx.counters.quotesDropped} of ${total} findings were dropped because their quote is not on the page — more than a quarter`);
  }
  // The change has been read: the texts before it are dropped (no retention).
  const released = await db.sourcePage.updateMany({ where: { source: { competitorId }, previousText: { not: null } }, data: { previousText: null, previousHash: null } });
  if (released.count) ctx.log("info", `${released.count} previous page text${released.count === 1 ? "" : "s"} dropped (the change was read)`);
  await ctx.flush();
}

// ————— 2. Merge: the competitor's own list —————

interface DbItem {
  id: string;
  kind: "capability" | "feature";
  key: string;
  name: string;
  wordings: string[];
  parentItemId: string | null;
  mergeChecked: boolean;
  capabilityId: string | null;
  featureId: string | null;
  placement: Placement | null;
  matchedBy: string | null;
  matchedAt: Date | null;
  matchAnalysisId: string | null;
}

interface ItemStats {
  findings: number;
  pages: number;
  /** The quote shown for the item in a prompt: the one from the first page by address. */
  quote: string;
  /** The spellings as the pages have them. */
  spellings: string[];
  /** At least one of its findings is on a strong page (the reading plan, sections.ts) — what the cell rules call found. */
  strong: boolean;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function loadItems(competitorId: string): Promise<DbItem[]> {
  const rows = await db.competitorItem.findMany({ where: { competitorId }, orderBy: { key: "asc" } });
  return rows.map((r) => ({
    id: r.id, kind: r.kind === "feature" ? "feature" : "capability", key: r.key, name: r.name, wordings: strings(r.wordings), parentItemId: r.parentItemId, mergeChecked: r.mergeChecked,
    capabilityId: r.capabilityId, featureId: r.featureId, placement: (r.placement as Placement | null) ?? null, matchedBy: r.matchedBy, matchedAt: r.matchedAt, matchAnalysisId: r.matchAnalysisId,
  }));
}

async function loadItemStats(ctx: RunContext): Promise<Map<string, ItemStats>> {
  const competitorId = ctx.competitor.id;
  const plan = await planOf(ctx);
  const findings = await db.pageFinding.findMany({ where: { competitorId, itemId: { not: null } }, select: { itemId: true, pageId: true, quote: true, wording: true, page: { select: { url: true, kind: true, sourceId: true, source: { select: { type: true } } } } } });
  findings.sort((a, b) => (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0));
  const pages = new Map<string, Set<string>>();
  const out = new Map<string, ItemStats>();
  for (const f of findings) {
    const id = f.itemId!;
    const s = out.get(id) ?? { findings: 0, pages: 0, quote: f.quote, spellings: [], strong: false };
    s.findings++;
    if (!s.strong && plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind }).tier === "strong") s.strong = true;
    if (!s.spellings.includes(f.wording)) s.spellings.push(f.wording);
    const set = pages.get(id) ?? new Set<string>();
    set.add(f.pageId);
    pages.set(id, set);
    s.pages = set.size;
    out.set(id, s);
  }
  return out;
}

const settledItem = (i: Pick<DbItem, "capabilityId" | "featureId" | "placement">) => Boolean(i.capabilityId || i.featureId || i.placement);
const liteOf = (i: DbItem, stats: Map<string, ItemStats>): ItemLite => ({ id: i.id, kind: i.kind, key: i.key, name: i.name, wordings: i.wordings, parentItemId: i.parentItemId, mergeChecked: i.mergeChecked, findings: stats.get(i.id)?.findings ?? 0, settled: settledItem(i) });

/** Findings with no item yet join the item that has their wording, or start a new one. Capabilities first: a feature hangs under the item of its page's capability. */
async function assignFindings(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const unassigned = await db.pageFinding.findMany({
    where: { competitorId, origin: "research", itemId: null },
    select: { id: true, pageId: true, kind: true, wording: true, parentWording: true, page: { select: { url: true } } },
  });
  if (!unassigned.length) return;
  unassigned.sort((a, b) => (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : a.id < b.id ? -1 : 1));
  const stored = await loadItems(competitorId);
  const items: ItemLite[] = stored.map((i) => liteOf(i, new Map()));
  const keyOf = new Map(items.map((i) => [i.id, i.key]));
  const assign = new Map<string, string[]>();
  const put = (itemId: string, findingId: string) => assign.set(itemId, [...(assign.get(itemId) ?? []), findingId]);
  const create = async (kind: "capability" | "feature", parentItemId: string | null, wording: string): Promise<ItemLite> => {
    const key = itemKey(kind, parentItemId ? keyOf.get(parentItemId) ?? "" : null, wording);
    const row = await db.competitorItem.create({
      data: { workspaceId: ctx.run.workspaceId, competitorId, kind, key, name: wording, wordings: [wordingKey(wording)] as unknown as Prisma.InputJsonValue, parentItemId },
      select: { id: true },
    });
    const lite: ItemLite = { id: row.id, kind, key, name: wording, wordings: [wordingKey(wording)], parentItemId, mergeChecked: false, findings: 0, settled: false };
    items.push(lite);
    keyOf.set(row.id, key);
    ctx.counters.itemsNew++;
    return lite;
  };
  // The capability item of each page's capability wordings — from this pass, and from findings assigned by a run that stopped half-way.
  const capabilityOnPage = new Map<string, string>();
  const featurePages = [...new Set(unassigned.filter((f) => f.kind === "feature").map((f) => f.pageId))];
  for (let i = 0; i < featurePages.length; i += CHUNK) {
    const earlier = await db.pageFinding.findMany({ where: { competitorId, origin: "research", kind: "capability", itemId: { not: null }, pageId: { in: featurePages.slice(i, i + CHUNK) } }, select: { pageId: true, wording: true, itemId: true } });
    for (const f of earlier) capabilityOnPage.set(`${f.pageId}|${wordingKey(f.wording)}`, f.itemId!);
  }
  for (const f of unassigned.filter((x) => x.kind === "capability")) {
    const item = findItem(items, "capability", null, f.wording) ?? (await create("capability", null, f.wording));
    put(item.id, f.id);
    capabilityOnPage.set(`${f.pageId}|${wordingKey(f.wording)}`, item.id);
  }
  const orphans: string[] = [];
  for (const f of unassigned.filter((x) => x.kind === "feature")) {
    const parentId = capabilityOnPage.get(`${f.pageId}|${wordingKey(f.parentWording ?? "")}`);
    if (!parentId) {
      // No capability of its page to hang under: no place in the list.
      orphans.push(f.id);
      continue;
    }
    const item = findItem(items, "feature", parentId, f.wording) ?? (await create("feature", parentId, f.wording));
    put(item.id, f.id);
  }
  for (const [itemId, ids] of assign) {
    for (let i = 0; i < ids.length; i += CHUNK) await db.pageFinding.updateMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, data: { itemId } });
  }
  if (orphans.length) {
    await db.pageFinding.deleteMany({ where: { id: { in: orphans } } });
    ctx.log("warn", `${orphans.length} feature finding${orphans.length === 1 ? "" : "s"} dropped: the capability of their page is gone`);
  }
}

/** Apply merge plans in one transaction: findings and features of the absorbed items move to the keeper, which keeps (or takes) the saved match; the absorbed rows go; every item of the call is marked as checked. */
async function applyMerges(competitorId: string, plans: MergePlan[], sent: string[]): Promise<number> {
  let merged = 0;
  await db.$transaction(
    async (tx) => {
      const rows = await tx.competitorItem.findMany({ where: { competitorId } });
      const byId = new Map(rows.map((r) => [r.id, { ...r, wordings: strings(r.wordings) }]));
      const gone = new Set<string>();
      /** Fold `from` into `into`: findings, wordings, and the saved match when `into` has none (or when the plan says so). */
      const absorb = async (intoId: string, fromId: string, takeMatch: boolean) => {
        const into = byId.get(intoId);
        const from = byId.get(fromId);
        if (!into || !from || gone.has(fromId) || intoId === fromId) return;
        await tx.pageFinding.updateMany({ where: { itemId: fromId }, data: { itemId: intoId } });
        into.wordings = [...new Set([...into.wordings, ...from.wordings])];
        if (takeMatch && !settledItem({ capabilityId: into.capabilityId, featureId: into.featureId, placement: into.placement as Placement | null })) {
          into.capabilityId = from.capabilityId;
          into.featureId = from.featureId;
          into.placement = from.placement;
          into.matchedBy = from.matchedBy;
          into.matchedAt = from.matchedAt;
          into.matchAnalysisId = from.matchAnalysisId;
        }
        // The absorbed item's features follow it: each joins the keeper's feature with the same wording, or moves under the keeper.
        if (from.kind === "capability") {
          for (const child of [...byId.values()].filter((c) => c.parentItemId === fromId && !gone.has(c.id))) {
            const twin = [...byId.values()].find((c) => c.parentItemId === intoId && !gone.has(c.id) && c.wordings.some((w) => child.wordings.includes(w)));
            if (twin) {
              await absorb(twin.id, child.id, true);
            } else {
              child.parentItemId = intoId;
              child.key = `f:${into.key}>${ownKey(child)}`;
              await tx.competitorItem.update({ where: { id: child.id }, data: { parentItemId: intoId, key: child.key } });
            }
          }
        }
        await tx.competitorItem.delete({ where: { id: fromId } });
        gone.add(fromId);
        await tx.competitorItem.update({
          where: { id: intoId },
          data: {
            wordings: into.wordings as unknown as Prisma.InputJsonValue, capabilityId: into.capabilityId, featureId: into.featureId,
            placement: into.placement === null ? Prisma.DbNull : (into.placement as Prisma.InputJsonValue), matchedBy: into.matchedBy, matchedAt: into.matchedAt, matchAnalysisId: into.matchAnalysisId,
          },
        });
        merged++;
      };
      for (const plan of plans) {
        // The item whose match the keeper takes goes first, so a later absorbed item cannot hand over another one.
        const order = plan.matchFromId ? [plan.matchFromId, ...plan.absorbIds.filter((id) => id !== plan.matchFromId)] : plan.absorbIds;
        for (const id of order) await absorb(plan.keepId, id, id === plan.matchFromId);
      }
      // Capabilities that were merged may now hold the same feature twice.
      for (const keepId of new Set(plans.map((p) => p.keepId))) {
        if (byId.get(keepId)?.kind !== "capability") continue;
        const children = [...byId.values()].filter((c) => c.parentItemId === keepId && !gone.has(c.id));
        const lites: ItemLite[] = children.map((c) => ({ id: c.id, kind: "feature", key: c.key, name: c.name, wordings: c.wordings, parentItemId: keepId, mergeChecked: c.mergeChecked, findings: 0, settled: settledItem({ capabilityId: c.capabilityId, featureId: c.featureId, placement: c.placement as Placement | null }) }));
        for (const p of planChildMerges(lites)) for (const id of p.absorbIds) await absorb(p.keepId, id, id === p.matchFromId);
      }
      const checked = sent.filter((id) => !gone.has(id));
      for (let i = 0; i < checked.length; i += CHUNK) await tx.competitorItem.updateMany({ where: { id: { in: checked.slice(i, i + CHUNK) } }, data: { mergeChecked: true } });
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  return merged;
}

function mergeEntries(items: DbItem[], stats: Map<string, ItemStats>, from = 1): { entries: MergeEntry[]; byCode: Map<string, ItemLite> } {
  const entries: MergeEntry[] = [];
  const byCode = new Map<string, ItemLite>();
  items.forEach((i, n) => {
    const code = `M${from + n}`;
    const s = stats.get(i.id);
    entries.push({ code, kind: i.kind, parentId: i.parentItemId, name: i.name, pages: s?.pages ?? 0, quote: s?.quote ?? "", known: i.mergeChecked });
    byCode.set(code, liteOf(i, stats));
  });
  return { entries, byCode };
}

async function mergeCall(ctx: RunContext, tail: string, entries: MergeEntry[], byCode: Map<string, ItemLite>, sent: string[]): Promise<void> {
  await ctx.paced({
    items: [tail],
    concurrency: 1,
    estimate: (t) => estimateTokens(t.length) + 300 + OUTPUT_RESERVE,
    work: async (t) => {
      // TEST KNOB: the answer of the n-th merge call of the run; none given = nothing to merge.
      const injected = ctx.answers ? ctx.answers.merge?.[ctx.counters.mergeCalls] ?? '{"groups": []}' : undefined;
      const r = await ctx.call<Record<string, unknown>>(MERGE_SYSTEM_PROMPT, "", t, MERGE_TOOL, { maxTokens: MERGE_MAX_TOKENS, thinking: "medium", injected });
      ctx.counters.mergeCalls++;
      const plans = planMerges(parseMerge(r.value, entries), byCode);
      const merged = await applyMerges(ctx.competitor.id, plans, sent);
      if (merged) ctx.log("info", `Merged ${merged} item${merged === 1 ? "" : "s"} into ${plans.length} that say the same thing`);
      return r.tokens;
    },
  });
}

export async function mergeStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  // 1. In code: the same normalized name (or a wording an earlier merge saved) is the same item.
  await assignFindings(ctx);

  // 2–3. PMOS AI, capabilities: only items it never saw, together with the lists merged by earlier runs (KNOWN).
  let calls = 0;
  for (;;) {
    const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(ctx)]);
    const capabilities = items.filter((i) => i.kind === "capability");
    const todo = capabilities.filter((i) => !i.mergeChecked);
    if (!todo.length) break;
    const chunk = todo.slice(0, MERGE_MAX_CAPABILITY_LINES);
    if (calls === 0 && todo.length > chunk.length) {
      const n = Math.ceil(todo.length / MERGE_MAX_CAPABILITY_LINES);
      ctx.counters.mergeSplits += n - 1;
      ctx.log("warn", `merge list split in ${n} calls (${todo.length} new capability names): merges across the calls can be missed`);
    }
    const { entries, byCode } = mergeEntries([...chunk, ...capabilities.filter((i) => i.mergeChecked)], stats);
    await mergeCall(ctx, renderMergeCapabilities(ctx.competitor.name, entries), entries, byCode, chunk.map((i) => i.id));
    calls++;
  }

  // 4. PMOS AI, features: per capability — features merge only inside one capability, so nothing is lost by packing.
  for (;;) {
    const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(ctx)]);
    const features = items.filter((i) => i.kind === "feature");
    const parents = new Map(items.filter((i) => i.kind === "capability").map((i) => [i.id, i]));
    const byParent = new Map<string, DbItem[]>();
    for (const f of features) if (f.parentItemId) byParent.set(f.parentItemId, [...(byParent.get(f.parentItemId) ?? []), f]);
    // A capability with one feature in all has nothing to merge: checked without a call.
    const alone = [...byParent.values()].filter((list) => list.length === 1 && !list[0].mergeChecked).map((list) => list[0].id);
    for (let i = 0; i < alone.length; i += CHUNK) await db.competitorItem.updateMany({ where: { id: { in: alone.slice(i, i + CHUNK) } }, data: { mergeChecked: true } });
    const due = [...byParent.entries()]
      .filter(([, list]) => list.length > 1 && list.some((f) => !f.mergeChecked))
      .sort((a, b) => ((parents.get(a[0])?.key ?? "") < (parents.get(b[0])?.key ?? "") ? -1 : 1));
    if (!due.length) break;
    const packed: Array<{ name: string; items: DbItem[] }> = [];
    let lines = 0;
    for (const [parentId, list] of due) {
      if (packed.length && lines + list.length > MERGE_MAX_FEATURE_LINES) break;
      packed.push({ name: parents.get(parentId)?.name ?? "", items: [...list.filter((f) => !f.mergeChecked), ...list.filter((f) => f.mergeChecked)] });
      lines += list.length;
    }
    const all: MergeEntry[] = [];
    const codes = new Map<string, ItemLite>();
    const blocks = packed.map((p) => {
      const { entries, byCode } = mergeEntries(p.items, stats, all.length + 1);
      all.push(...entries);
      for (const [c, i] of byCode) codes.set(c, i);
      return { name: p.name, entries };
    });
    await mergeCall(ctx, renderMergeFeatures(ctx.competitor.name, blocks), all, codes, packed.flatMap((p) => p.items.filter((f) => !f.mergeChecked).map((f) => f.id)));
  }

  // 5. An item is called what most of its pages call it.
  const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(ctx)]);
  const spellings = await db.pageFinding.findMany({ where: { competitorId, itemId: { not: null } }, select: { itemId: true, wording: true } });
  const wordingsOf = new Map<string, string[]>();
  for (const f of spellings) wordingsOf.set(f.itemId!, [...(wordingsOf.get(f.itemId!) ?? []), f.wording]);
  for (const i of items) {
    const name = canonicalName(wordingsOf.get(i.id) ?? []);
    if (name && name !== i.name) await db.competitorItem.update({ where: { id: i.id }, data: { name } });
  }
  const capabilities = items.filter((i) => i.kind === "capability").length;
  ctx.log("info", `Their list: ${capabilities} capabilit${capabilities === 1 ? "y" : "ies"} and ${items.length - capabilities} feature${items.length - capabilities === 1 ? "" : "s"}, from ${[...stats.values()].reduce((n, s) => n + s.findings, 0)} findings`);
  await ctx.flush();
}

// ————— 3. Match and place: their list against ours —————

/** Our catalog as the match sees it: every row, any state (a removed row is recognised, never added back). */
export async function loadCatalog(workspaceId: string): Promise<{
  catalog: Catalog;
  domains: Array<{ id: string; name: string; description: string; aliases: unknown; state: string; position: number }>;
  capabilities: Array<{ id: string; domainId: string; name: string; description: string; aliases: unknown; state: string; position: number }>;
  features: Array<{ id: string; capabilityId: string; name: string; description: string; aliases: unknown; state: string; position: number }>;
}> {
  const [domains, capabilities, features] = await Promise.all([
    db.competitorDomain.findMany({ where: { workspaceId }, select: { id: true, name: true, description: true, aliases: true, state: true, position: true } }),
    db.capability.findMany({ where: { workspaceId }, select: { id: true, domainId: true, name: true, description: true, aliases: true, state: true, position: true } }),
    db.feature.findMany({ where: { workspaceId }, select: { id: true, capabilityId: true, name: true, description: true, aliases: true, state: true, position: true } }),
  ]);
  return { catalog: buildCatalog(domains, capabilities, features), domains, capabilities, features };
}

const SILENT_STATES = ["removed", "dismissed"];

export async function matchStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  // 1. Repair: a saved match whose row of ours was hard-deleted is no match any more.
  await db.competitorItem.updateMany({ where: { competitorId, matchedAt: { not: null }, capabilityId: null, featureId: null, placement: { equals: Prisma.DbNull } }, data: { matchedAt: null, matchedBy: null, matchAnalysisId: null } });

  const [items, stats, ours] = await Promise.all([loadItems(competitorId), loadItemStats(ctx), loadCatalog(workspaceId)]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const todo = items.filter((i) => i.matchedAt == null);
  if (!todo.length) {
    ctx.log("info", "Match: every item of their list has a saved match — PMOS AI not called");
    return;
  }

  // 2. In code: a name the catalog knows — today's name or one a PM replaced — is that row. A PM's decision is never reopened.
  const capabilityIndex = new NameIndex(ours.capabilities);
  const featureIndex = new Map<string, NameIndex>();
  for (const f of ours.features) {
    const index = featureIndex.get(f.capabilityId) ?? new NameIndex();
    index.add(f);
    featureIndex.set(f.capabilityId, index);
  }
  const resolveIn = (index: NameIndex | undefined, names: string[]): Resolved | null => {
    if (!index) return null;
    for (const n of names) {
      const hit = index.resolve(n);
      if (hit) return hit;
    }
    return null;
  };
  const now = new Date();
  for (const item of [...todo.filter((i) => i.kind === "capability"), ...todo.filter((i) => i.kind === "feature")]) {
    const names = [item.name, ...(stats.get(item.id)?.spellings ?? [])];
    const parentCapabilityId = item.kind === "feature" && item.parentItemId ? byId.get(item.parentItemId)?.capabilityId ?? null : null;
    const feature = parentCapabilityId ? resolveIn(featureIndex.get(parentCapabilityId), names) : null;
    const capability = feature ? null : resolveIn(capabilityIndex, names);
    const hit = feature ?? capability;
    if (!hit) continue;
    const silent = SILENT_STATES.includes(hit.state);
    item.capabilityId = capability ? hit.id : null;
    item.featureId = feature ? hit.id : null;
    item.matchedBy = silent ? "silent" : hit.via;
    item.matchedAt = now;
    await db.competitorItem.update({ where: { id: item.id }, data: { capabilityId: item.capabilityId, featureId: item.featureId, matchedBy: item.matchedBy, matchedAt: now, matchAnalysisId: ctx.run.id } });
    if (silent) {
      await recordCompetitorEvent(workspaceId, null, "cmp_decision_respected", { entity: feature ? "feature" : "capability", entityId: hit.id, name: hit.name, found: item.name, reason: hit.state, competitorId, analysisId: ctx.run.id });
      ctx.log("info", `${item.name}: your team removed "${hit.name}" — remembered, not shown`);
    } else {
      ctx.counters.matchedByName++;
    }
  }

  // 3. PMOS AI: what is left, 100 entries per call, our rows as codes (a closed set).
  let left = items.filter((i) => i.matchedAt == null);
  while (left.length) {
    const batch = batchItems(left)[0];
    const codeOfItem = new Map(batch.map((i, n) => [i.id, `T${n + 1}`]));
    const itemOfCode = new Map(batch.map((i, n) => [`T${n + 1}`, i]));
    const entries: MatchTheirEntry[] = batch.map((i) => {
      const parent = i.parentItemId ? byId.get(i.parentItemId) : undefined;
      return {
        code: codeOfItem.get(i.id)!, kind: i.kind, name: i.name, quote: stats.get(i.id)?.quote ?? "",
        parent: i.kind === "feature" && parent ? (codeOfItem.has(parent.id) ? { code: codeOfItem.get(parent.id)! } : { name: parent.name }) : null,
      };
    });
    const proposed = [...new Set(items.filter((i) => i.matchAnalysisId === ctx.run.id && i.placement?.newDomainName).map((i) => i.placement!.newDomainName))];
    const tail = renderMatchTail(ctx.competitor.name, proposed, entries);
    let settled = 0;
    await ctx.paced({
      items: [tail],
      concurrency: 1,
      estimate: (t) => estimateTokens(ours.catalog.shared.length + t.length) + 600 + OUTPUT_RESERVE,
      work: async (t) => {
        // TEST KNOB: the answer of the n-th match call of the run. None given while items need a match → the run fails: a test states what it expects.
        let injected: string | undefined;
        if (ctx.answers) {
          injected = ctx.answers.match?.[ctx.counters.matchCalls];
          if (injected === undefined) throw new AnalysisError("other", `no injected match answer for match call ${ctx.counters.matchCalls + 1} (test knob)`);
        }
        const r = await ctx.call<Record<string, unknown>>(MATCH_SYSTEM_PROMPT, ours.catalog.shared, t, matchTool(entries.map((e) => e.code), ours.catalog), { maxTokens: MATCH_MAX_TOKENS, thinking: "high", injected });
        ctx.counters.matchCalls++;
        const parsed = parseMatch(r.value, entries, ours.catalog);
        if (parsed.unknownOurs.length) ctx.log("warn", `Match: ${parsed.unknownOurs.length} answer${parsed.unknownOurs.length === 1 ? "" : "s"} named a code that is not ours (${parsed.unknownOurs.slice(0, 3).join(", ")}) — counted as none of ours`);
        const at = new Date();
        await db.$transaction(
          parsed.answers.map((a) => {
            const item = itemOfCode.get(a.entry)!;
            return db.competitorItem.update({
              where: { id: item.id },
              data: a.ours
                ? { capabilityId: a.ours.kind === "capability" ? a.ours.id : null, featureId: a.ours.kind === "feature" ? a.ours.id : null, placement: Prisma.DbNull, matchedBy: "ai", matchedAt: at, matchAnalysisId: ctx.run.id }
                : { capabilityId: null, featureId: null, placement: a.placement as unknown as Prisma.InputJsonValue, matchedBy: "ai", matchedAt: at, matchAnalysisId: ctx.run.id },
            });
          }),
        );
        for (const a of parsed.answers) {
          const item = itemOfCode.get(a.entry)!;
          item.matchedAt = at;
          item.matchedBy = "ai";
          item.matchAnalysisId = ctx.run.id;
          if (a.ours) {
            item.capabilityId = a.ours.kind === "capability" ? a.ours.id : null;
            item.featureId = a.ours.kind === "feature" ? a.ours.id : null;
            ctx.counters.matchedByAi++;
          } else {
            item.placement = a.placement;
            ctx.counters.placed++;
          }
        }
        settled = parsed.answers.length;
        return r.tokens;
      },
    });
    // No loop that could spin: a call that settles nothing fails the run. Entries the model skipped go into the next batch.
    if (settled === 0) throw new AnalysisError("answer", `PMOS AI answered none of the ${batch.length} entries of a match call`);
    left = items.filter((i) => i.matchedAt == null);
  }
  ctx.log("info", `Match: ${ctx.counters.matchedByName} by name, ${ctx.counters.matchedByAi} matched to your rows by PMOS AI, ${ctx.counters.placed} none of yours`);
  await ctx.flush();
}

// ————— Evidence: the findings behind a cell —————

interface EvidenceMaps {
  byCapability: Map<string, Evidence[]>;
  byFeature: Map<string, Evidence[]>;
}

/**
 * No table of its own. For a competitor and a capability of ours: the findings of their items matched to it, the
 * findings of items matched to one of its active features (a feature of ours found there is evidence for the
 * capability), and second-look findings that answer it. For a feature: the findings of items matched to it.
 * A finding's tier is computed here, from its page's place in the competitor's reading plan (sections.ts).
 */
async function loadEvidence(workspaceId: string, competitorId: string, plan: ReadingPlan): Promise<EvidenceMaps> {
  const [findings, features] = await Promise.all([
    db.pageFinding.findMany({
      where: { competitorId, OR: [{ itemId: { not: null } }, { capabilityId: { not: null } }] },
      select: { id: true, origin: true, quote: true, reasoning: true, description: true, wording: true, capabilityId: true, item: { select: { capabilityId: true, featureId: true, name: true } }, page: { select: { url: true, kind: true, sourceId: true, source: { select: { type: true } } } } },
    }),
    db.feature.findMany({ where: { workspaceId, state: "active" }, select: { id: true, capabilityId: true } }),
  ]);
  const capabilityOfFeature = new Map(features.map((f) => [f.id, f.capabilityId]));
  const out: EvidenceMaps = { byCapability: new Map(), byFeature: new Map() };
  const add = (map: Map<string, Evidence[]>, id: string, e: Evidence) => map.set(id, [...(map.get(id) ?? []), e]);
  for (const f of findings) {
    const t = plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind });
    if (t.tier === "skip") continue;
    const e: Evidence = { findingId: f.id, pageUrl: f.page.url, tier: t.tier, pageKind: t.kind, origin: f.origin === "second_look" ? "second_look" : "research", quote: f.quote, reasoning: f.reasoning, wording: f.item?.name ?? f.wording, description: f.description };
    if (f.origin === "second_look") {
      if (f.capabilityId) add(out.byCapability, f.capabilityId, e);
    } else if (f.item?.capabilityId) {
      add(out.byCapability, f.item.capabilityId, e);
    } else if (f.item?.featureId) {
      add(out.byFeature, f.item.featureId, e);
      const capabilityId = capabilityOfFeature.get(f.item.featureId);
      if (capabilityId) add(out.byCapability, capabilityId, e);
    }
  }
  return out;
}

/** The rows of ours that have a cell: active capabilities in a domain that is in the table (or suggested), and their active features. */
export async function tableRows(workspaceId: string) {
  const capabilities = await db.capability.findMany({
    where: { workspaceId, state: "active", domain: { state: { in: ["active", "suggested"] } } },
    select: { id: true, name: true, description: true, aliases: true, domain: { select: { name: true, description: true } } },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
  const features = await db.feature.findMany({ where: { workspaceId, state: "active", capabilityId: { in: capabilities.map((k) => k.id) } }, select: { id: true, capabilityId: true, name: true } });
  return { capabilities, features };
}

// ————— 4. Second look: one call per capability of ours with no evidence —————

const NOT_FOUND_ANSWER = '{"found": false, "quote": "", "url": "", "theirName": "", "reasoning": ""}';

/**
 * Returns the capabilities whose second look is due but was not made in this run (the per-run limit): the apply
 * step writes no cell for them — a cell says not found only after a look found nothing.
 */
export async function secondLookStep(ctx: RunContext): Promise<Set<string>> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const waiting = new Set<string>();
  ctx.counters.secondLooksWaiting = 0;
  const [{ capabilities }, evidence] = await Promise.all([tableRows(workspaceId), loadEvidence(workspaceId, competitorId, await planOf(ctx))]);
  const candidates = capabilities.filter((k) => !evidence.byCapability.get(k.id)?.length);
  if (!candidates.length) return waiting;

  // The pool: every page the analysis may read, with its text — the deep pages (help articles, release notes, API
  // docs below the index) included: a capability of ours that no read page offers may be told there.
  const picked = await readablePages(ctx);
  const sourceTypeOf = new Map(picked.map((p) => [p.id, p.sourceType]));
  const pool: Array<LookPage & { kind: string }> = [];
  for (let i = 0; i < picked.length; i += CHUNK) {
    const rows = await db.sourcePage.findMany({ where: { id: { in: picked.slice(i, i + CHUNK).map((p) => p.id) } }, select: { id: true, url: true, title: true, text: true, hash: true, kind: true } });
    for (const r of rows) if (r.text != null) pool.push({ id: r.id, url: r.url, title: r.title ?? "", text: r.text, hash: r.hash, kind: r.kind });
  }
  const kindOf = new Map(pool.map((p) => [p.id, p.kind]));
  const indexed = indexPages(pool);
  const asked = new Map((await db.capabilityStatus.findMany({ where: { competitorId, capabilityId: { in: candidates.map((k) => k.id) } }, select: { capabilityId: true, lookKey: true } })).map((c) => [c.capabilityId, c.lookKey]));
  // The only write to a cell outside the apply step, and it writes no value on an existing cell: what the look was asked with.
  const saveKey = (capabilityId: string, key: string) =>
    db.capabilityStatus.upsert({
      where: { competitorId_capabilityId: { competitorId, capabilityId } },
      create: { workspaceId, competitorId, capabilityId, value: "not_found", lookKey: key, changedAt: null },
      update: { lookKey: key },
    });

  const due: Array<{ capability: (typeof candidates)[number]; aliases: string[]; pages: LookPage[]; key: string }> = [];
  for (const k of candidates) {
    const aliases = aliasList(k.aliases);
    const pages = pagesFor({ name: k.name, aliases }, indexed);
    const key = lookKey({ name: k.name, description: k.description, aliases }, k.domain, pages, ctx.model);
    if (asked.get(k.id) === key) continue;
    if (!pages.length) {
      // No page is likely to mention it: nothing to ask. Remembered, so it is looked at again only when something changes.
      await saveKey(k.id, key);
      continue;
    }
    due.push({ capability: k, aliases, pages, key });
  }
  if (!due.length) return waiting;
  // The limit per run, in table order. What is over it waits for the competitor's next run.
  const { now: todo, later } = capLooks(due, ctx.counters.secondLooks, ctx.maxSecondLooks);
  for (const t of later) waiting.add(t.capability.id);
  ctx.counters.secondLooksWaiting = later.length;
  ctx.log("info", `Second look: ${due.length} of your capabilities have no evidence at ${ctx.competitor.name} yet — asking once each, on their most likely pages${later.length ? `; ${todo.length} now (the limit is ${ctx.maxSecondLooks} per run), ${later.length} wait for the next run` : ""}`);
  if (!todo.length) return waiting;
  let found = 0;
  await ctx.paced({
    items: todo,
    concurrency: analysisConcurrency(),
    estimate: (t) => estimateTokens(t.pages.reduce((n, p) => n + p.text.length, 0)) + 500 + OUTPUT_RESERVE,
    work: async (t) => {
      const k = t.capability;
      const injected = ctx.answers ? ctx.answers.secondLook?.[k.name] ?? ctx.answers.secondLook?.["*"] ?? NOT_FOUND_ANSWER : undefined;
      const r = await ctx.call<Record<string, unknown>>(
        LOOK_SYSTEM_PROMPT,
        "",
        renderSecondLook({ name: k.name, description: k.description, aliases: t.aliases }, k.domain, ctx.competitor.name, t.pages.map((p) => ({ url: p.url, title: p.title, text: p.text, kind: kindOf.get(p.id), sourceLabel: C.profile.sourceTypes[sourceTypeOf.get(p.id) ?? ""] }))),
        lookTool(t.pages.map((p) => p.url)),
        { maxTokens: LOOK_MAX_TOKENS, thinking: "low", injected },
      );
      const answer = parseSecondLook(r.value, t.pages);
      ctx.counters.secondLooks++;
      if (answer.found) {
        const page = t.pages.find((p) => p.id === answer.pageId)!;
        await db.pageFinding.create({
          data: { workspaceId, competitorId, pageId: page.id, pageHash: page.hash, analysisId: ctx.run.id, origin: "second_look", kind: "capability", wording: answer.wording || k.name, quote: answer.quote, reasoning: answer.reasoning, capabilityId: k.id },
        });
        found++;
        ctx.counters.secondLookFound++;
        ctx.log("info", `Second look: found "${k.name}"`, page.url);
      } else {
        if (answer.quoteDropped) ctx.counters.quotesDropped++;
        await saveKey(k.id, t.key);
      }
      return r.tokens;
    },
  });
  ctx.log("info", `Second look: ${found} found, ${todo.length - found} not found${later.length ? `, ${later.length} not asked yet` : ""}`);
  await ctx.flush();
  return waiting;
}

// ————— 5. Apply: rows, then cells — no AI —————

export async function applyStep(ctx: RunContext, lookWaiting: ReadonlySet<string> = new Set()): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  // The first analysis of a competitor sets the starting picture: values are replaced (POC cells included), nothing is "news".
  const baseline = (await db.competitorAnalysis.count({ where: { competitorId, appliedAt: { not: null } } })) === 0;
  const respected = (entity: "capability" | "feature" | "domain", row: Resolved, found: string) =>
    recordCompetitorEvent(workspaceId, null, "cmp_decision_respected", { entity, entityId: row.id, name: row.name, found, reason: row.state, competitorId, analysisId: ctx.run.id });

  // ——— A. Rows: their items that are none of ours become capabilities and features — through decisions.ts, so a PM's decision is never reopened ———
  const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(ctx)]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const byName = (a: DbItem, b: DbItem) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const todo = items.filter((i) => i.placement && !i.capabilityId && !i.featureId);
  if (todo.length) {
    const [domainRows, capabilityRows, featureRows] = await Promise.all([
      db.competitorDomain.findMany({ where: { workspaceId }, select: { id: true, name: true, aliases: true, state: true, position: true } }),
      db.capability.findMany({ where: { workspaceId }, select: { id: true, name: true, aliases: true, state: true, position: true } }),
      db.feature.findMany({ where: { workspaceId }, select: { id: true, capabilityId: true, name: true, aliases: true, state: true, position: true } }),
    ]);
    const capabilityIndex = new NameIndex(capabilityRows);
    const domainIndex = new NameIndex(domainRows);
    const featureIndex = new Map<string, NameIndex>();
    const featurePosition = new Map<string, number>();
    const capabilityOfFeature = new Map(featureRows.map((f) => [f.id, f.capabilityId]));
    for (const f of featureRows) {
      const index = featureIndex.get(f.capabilityId) ?? new NameIndex();
      index.add(f);
      featureIndex.set(f.capabilityId, index);
      featurePosition.set(f.capabilityId, Math.max(featurePosition.get(f.capabilityId) ?? -1, f.position));
    }
    const domainState = new Map(domainRows.map((d) => [d.id, d.state]));
    const domainName = new Map(domainRows.map((d) => [d.id, d.name]));
    const capabilityState = new Map(capabilityRows.map((k) => [k.id, k.state]));
    const fallback = domainRows.filter((d) => d.state === "active").sort((a, b) => a.position - b.position || (a.name < b.name ? -1 : 1))[0]?.id ?? null;
    let position = capabilityRows.filter((k) => k.state === "active").reduce((n, k) => Math.max(n, k.position), -1);
    let waiting = 0;
    let noDomain = 0;

    for (const item of [...todo.filter((i) => i.kind === "capability").sort(byName), ...todo.filter((i) => i.kind === "feature").sort(byName)]) {
      const placement = item.placement!;
      const pages = stats.get(item.id)?.pages ?? 0;
      // The brake on table growth: an item becomes a row only when enough pages carry it. It stays on the to-do.
      if (pages < ctx.minPagesForNewRow) {
        waiting++;
        continue;
      }
      const names = [placement.marketName, item.name].filter(Boolean);
      if (item.kind === "capability") {
        const verdict = judgeNewRow(capabilityIndex, names);
        if (verdict.action === "match" || verdict.action === "silent") {
          item.capabilityId = verdict.row.id;
          item.matchedBy = verdict.action === "silent" ? "silent" : verdict.via;
          await db.competitorItem.update({ where: { id: item.id }, data: { capabilityId: verdict.row.id, matchedBy: item.matchedBy } });
          if (verdict.action === "silent") await respected("capability", verdict.row, item.name);
          else ctx.counters.matchedByName++;
          continue;
        }
        if (!verdict.name) continue;
        if (!fallback) {
          noDomain++;
          continue;
        }
        // A domain the match named may have left the table since: then it is a name like any other, and the PM's decision about it stands.
        const wanted = placement.domainId && ["active", "suggested"].includes(domainState.get(placement.domainId) ?? "") ? placement.domainId : null;
        const closest = placement.closestDomainId && domainState.get(placement.closestDomainId) === "active" ? placement.closestDomainId : null;
        const place = placeInDomain(domainIndex, { domainId: wanted, newDomainName: placement.newDomainName || (placement.domainId && !wanted ? domainName.get(placement.domainId) ?? "" : ""), closestDomainId: closest }, fallback);
        position++;
        const row = await db.$transaction(async (tx) => {
          let domainId: string;
          if (place.action === "suggest") {
            const domain = await tx.competitorDomain.create({
              data: { workspaceId, name: place.name, description: placement.newDomainDefinition, position: 9999, origin: "ai", state: "suggested", suggestedById: competitorId },
              select: { id: true },
            });
            domainId = domain.id;
          } else {
            domainId = place.domainId;
          }
          const inSuggestedDomain = place.action === "suggest" || domainState.get(domainId) === "suggested";
          const capability = await tx.capability.create({
            data: {
              workspaceId, domainId, name: verdict.name, description: placement.description, ourStatus: "not_found", origin: "ai", state: "active", position,
              // Kept for a decline of the suggested domain: the row then moves to the closest existing domain.
              closestDomainId: inSuggestedDomain ? (place.action === "suggest" ? place.closestDomainId : closest ?? fallback) : null,
            },
            select: { id: true },
          });
          await tx.competitorItem.update({ where: { id: item.id }, data: { capabilityId: capability.id, matchedBy: "created" } });
          return { capabilityId: capability.id, domainId, inSuggestedDomain };
        });
        item.capabilityId = row.capabilityId;
        item.matchedBy = "created";
        capabilityIndex.add({ id: row.capabilityId, name: verdict.name, aliases: [], state: "active" });
        capabilityState.set(row.capabilityId, "active");
        ctx.counters.newCapabilities++;
        // Recorded when the row is made, not at the end of the step: a run that stops in between loses nothing.
        // The value is the one the cell rules will give it (cells.ts): found on a strong page, low confidence otherwise.
        await recordCompetitorEvent(workspaceId, null, "cmp_capability_added", { capabilityId: row.capabilityId, name: verdict.name, domainId: row.domainId, inSuggestedDomain: row.inSuggestedDomain, competitorId, analysisId: ctx.run.id, pages, value: stats.get(item.id)?.strong ? "found" : "low" });
        if (place.action === "suggest") {
          domainIndex.add({ id: row.domainId, name: place.name, aliases: [], state: "suggested" });
          domainState.set(row.domainId, "suggested");
          domainName.set(row.domainId, place.name);
          ctx.counters.newDomains++;
          await recordCompetitorEvent(workspaceId, null, "cmp_domain_suggested", { domainId: row.domainId, name: place.name, closestDomainId: place.closestDomainId, competitorId, analysisId: ctx.run.id });
          ctx.log("info", `New domain suggested: ${place.name}`);
        } else if (place.action === "closest") {
          await respected("domain", place.respected, placement.newDomainName || place.respected.name);
        }
        ctx.log("info", `New capability: ${verdict.name}${item.name !== verdict.name ? ` (they call it "${item.name}")` : ""}`);
        continue;
      }
      // A feature follows its capability: the row its capability item is matched to, or the capability of the feature that item is matched to.
      const parent = item.parentItemId ? byId.get(item.parentItemId) : undefined;
      const home = parent?.capabilityId ?? (parent?.featureId ? capabilityOfFeature.get(parent.featureId) ?? null : null);
      if (!home || capabilityState.get(home) !== "active") continue;
      const index = featureIndex.get(home) ?? new NameIndex();
      featureIndex.set(home, index);
      const verdict = judgeNewRow(index, names);
      if (verdict.action === "match" || verdict.action === "silent") {
        item.featureId = verdict.row.id;
        item.matchedBy = verdict.action === "silent" ? "silent" : verdict.via;
        await db.competitorItem.update({ where: { id: item.id }, data: { featureId: verdict.row.id, matchedBy: item.matchedBy } });
        if (verdict.action === "silent") await respected("feature", verdict.row, item.name);
        else ctx.counters.matchedByName++;
        continue;
      }
      if (!verdict.name) continue;
      const next = (featurePosition.get(home) ?? -1) + 1;
      featurePosition.set(home, next);
      const featureId = await db.$transaction(async (tx) => {
        const feature = await tx.feature.create({ data: { workspaceId, capabilityId: home, name: verdict.name, description: placement.description, ourStatus: "not_found", origin: "ai", state: "active", position: next }, select: { id: true } });
        await tx.competitorItem.update({ where: { id: item.id }, data: { featureId: feature.id, matchedBy: "created" } });
        return feature.id;
      });
      item.featureId = featureId;
      item.matchedBy = "created";
      index.add({ id: featureId, name: verdict.name, aliases: [], state: "active" });
      capabilityOfFeature.set(featureId, home);
      ctx.counters.newFeatures++;
      await recordCompetitorEvent(workspaceId, null, "cmp_feature_added", { featureId, capabilityId: home, name: verdict.name, competitorId, analysisId: ctx.run.id });
    }
    if (waiting) ctx.log("info", `${waiting} item${waiting === 1 ? "" : "s"} of theirs wait${waiting === 1 ? "s" : ""} for more pages before becoming a row (at least ${ctx.minPagesForNewRow} pages)`);
    if (noDomain) ctx.log("warn", `${noDomain} new capabilit${noDomain === 1 ? "y was" : "ies were"} not added: your catalog has no domain yet — add one in Settings → Competitors`);
  }

  // ——— B. Cells: by fixed rules from the evidence. A PM's correction is never read or written here ———
  const [{ capabilities, features }, evidence, storedCells, storedFeatureCells] = await Promise.all([
    tableRows(workspaceId),
    loadEvidence(workspaceId, competitorId, await planOf(ctx)),
    db.capabilityStatus.findMany({ where: { competitorId }, select: { id: true, capabilityId: true, value: true, quote: true, sourceUrl: true, reasoning: true, wording: true, description: true, evidenceCount: true, scanId: true } }),
    db.featureStatus.findMany({ where: { competitorId }, select: { id: true, featureId: true, value: true, quote: true, sourceUrl: true, reasoning: true, wording: true, description: true, evidenceCount: true } }),
  ]);
  const now = new Date();
  const shown = (cell: CellFromEvidence) => ({ quote: cell.best?.quote ?? null, sourceUrl: cell.best?.pageUrl ?? null, reasoning: cell.best?.reasoning ?? null, wording: cell.best?.wording ?? null, description: cell.description, evidenceCount: cell.count });
  const sameEvidence = (a: { quote: string | null; sourceUrl: string | null; reasoning: string | null; wording: string | null; description: string | null; evidenceCount: number }, b: ReturnType<typeof shown>) =>
    a.quote === b.quote && a.sourceUrl === b.sourceUrl && a.reasoning === b.reasoning && a.wording === b.wording && a.description === b.description && a.evidenceCount === b.evidenceCount;
  const count = (value: string) => {
    if (value === "found") ctx.counters.cellsFound++;
    else if (value === "low") ctx.counters.cellsLow++;
    else ctx.counters.cellsNotFound++;
  };
  const cellOf = new Map(storedCells.map((c) => [c.capabilityId, c]));
  for (const k of capabilities) {
    // Its second look is still to come (the per-run limit): nothing is known yet, so nothing is written — a new row
    // stays without a cell, an existing cell keeps what it says until the look was made.
    if (lookWaiting.has(k.id) && !evidence.byCapability.get(k.id)?.length) continue;
    const cell = cellFromEvidence(evidence.byCapability.get(k.id) ?? []);
    const data = shown(cell);
    const stored = cellOf.get(k.id);
    count(cell.value);
    if (!stored) {
      await db.capabilityStatus.create({ data: { workspaceId, competitorId, capabilityId: k.id, value: cell.value, ...data, analysisId: ctx.run.id, scanId: ctx.run.scanId, changedAt: null } });
    } else if (stored.value === cell.value) {
      if (!sameEvidence(stored, data)) await db.capabilityStatus.update({ where: { id: stored.id }, data: { ...data, analysisId: ctx.run.id } });
    } else if (baseline) {
      await db.capabilityStatus.update({ where: { id: stored.id }, data: { value: cell.value, ...data, analysisId: ctx.run.id } });
    } else {
      await db.$transaction([
        db.statusHistory.create({ data: { statusId: stored.id, value: stored.value, quote: stored.quote, sourceUrl: stored.sourceUrl, scanId: stored.scanId } }),
        db.capabilityStatus.update({ where: { id: stored.id }, data: { value: cell.value, ...data, analysisId: ctx.run.id, changedAt: now, summary: cell.best?.reasoning ?? null, imageUrl: null, scanId: ctx.run.scanId } }),
      ]);
      ctx.counters.cellsChanged++;
      ctx.log("info", `${k.name}: ${C.values[stored.value] ?? stored.value} → ${C.values[cell.value]}`, cell.best?.pageUrl);
    }
  }
  const featureCellOf = new Map(storedFeatureCells.map((c) => [c.featureId, c]));
  for (const f of features) {
    const cell = cellFromEvidence(evidence.byFeature.get(f.id) ?? []);
    const data = shown(cell);
    const stored = featureCellOf.get(f.id);
    count(cell.value);
    if (!stored) {
      await db.featureStatus.create({ data: { workspaceId, competitorId, featureId: f.id, value: cell.value, ...data, analysisId: ctx.run.id, changedAt: null } });
    } else if (stored.value === cell.value) {
      if (!sameEvidence(stored, data)) await db.featureStatus.update({ where: { id: stored.id }, data: { ...data, analysisId: ctx.run.id } });
    } else {
      // Features carry no history (the feed does not report them in this build).
      await db.featureStatus.update({ where: { id: stored.id }, data: { value: cell.value, ...data, analysisId: ctx.run.id, ...(baseline ? {} : { changedAt: now }) } });
      if (!baseline) ctx.counters.cellsChanged++;
    }
  }

  // ——— C. A row made from this competitor's items is looked for at the other competitors: a follow-up run each (no page is read again) ———
  // Which rows: read from the tables, not remembered — the rows made from this competitor's items since its last
  // finished run. So a run that crashed or failed after making a row (in this step, or later) still gets its
  // follow-up runs: from this run when it continues, or from the competitor's next run. Before the cells are marked
  // current, for the same reason.
  const [lastDone, made] = await Promise.all([
    db.competitorAnalysis.findFirst({ where: { competitorId, status: "done", appliedAt: { not: null } }, orderBy: { appliedAt: "desc" }, select: { appliedAt: true } }),
    db.competitorItem.findMany({ where: { competitorId, kind: "capability", matchedBy: "created", capability: { is: { state: "active" } } }, select: { capability: { select: { id: true, createdAt: true } } } }),
  ]);
  const fresh = rowsSince(made.flatMap((m) => (m.capability ? [m.capability] : [])), lastDone?.appliedAt ?? null);
  if (fresh.length) {
    const others = await queueCatalogAnalyses(workspaceId, { exceptCompetitorId: competitorId });
    if (others) ctx.log("info", `${others} other competitor${others === 1 ? "" : "s"} queued: the new rows are looked for there too`);
  }

  // ——— D. The cells are current as of now ———
  await ctx.markApplied(now);
  ctx.log("info", `Table filled${baseline ? " (first analysis of this competitor: the starting picture, nothing counts as a change)" : ""}: ${ctx.counters.cellsFound} found, ${ctx.counters.cellsLow} low confidence, ${ctx.counters.cellsNotFound} not found${ctx.counters.cellsChanged ? ` · ${ctx.counters.cellsChanged} changed` : ""}${ctx.counters.newCapabilities ? ` · ${ctx.counters.newCapabilities} new capabilit${ctx.counters.newCapabilities === 1 ? "y" : "ies"}` : ""}${ctx.counters.newFeatures ? ` · ${ctx.counters.newFeatures} new feature${ctx.counters.newFeatures === 1 ? "" : "s"}` : ""}${ctx.counters.secondLooksWaiting ? ` · ${ctx.counters.secondLooksWaiting} capabilit${ctx.counters.secondLooksWaiting === 1 ? "y waits" : "ies wait"} for a second look (next run)` : ""}`);
  await ctx.flush();
}
