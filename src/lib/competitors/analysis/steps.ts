import { Prisma } from "@prisma/client";
import { db } from "../../db";
import type { AnswerError } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { COMPETITORS_COPY as C } from "../copy";
import { NameIndex, type Resolved } from "../decisions";
import { AnalysisError, type RunContext } from "./engine";
import { canonicalName, findItem, itemKey, ownKey, planChildMerges, planMerges, wordingKey, type ItemLite, type MergePlan } from "./items";
import { pickPages } from "./kinds";
import { batchItems, buildCatalog, type Catalog } from "./match";
import { analysisConcurrency, estimateTokens, OUTPUT_RESERVE } from "./pacing";
import {
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
  renderMatchTail,
  renderMergeCapabilities,
  renderMergeFeatures,
  renderResearch,
  RESEARCH_MAX_TOKENS,
  RESEARCH_SYSTEM_PROMPT,
  RESEARCH_TOOL,
  RESEARCH_VERSION,
  type MatchTheirEntry,
  type MergeEntry,
  type Placement,
} from "./prompts";
import { readKey, researchTodo, tooManyFailed } from "./todo";

/**
 * The database side of the six steps of an analysis run (Capability Analysis, "How the analysis runs").
 * Every step computes its to-do from the tables and saves each unit of work in one transaction, so a run that
 * stopped continues with exactly what is left. The rules themselves are the pure modules next to this file.
 */

/** Tokens of instructions and schema a research call carries besides the page. */
const RESEARCH_OVERHEAD_TOKENS = 450;
const CHUNK = 1000;

export interface StoredPage {
  id: string;
  url: string;
  hash: string;
  chars: number;
  state: string;
  kind: string;
  sourceId: string;
  sourceType: string;
  hasText: boolean;
  analyzedKey: string | null;
  factsKey: string | null;
}

/** Every stored page of the competitor, all its sources, without the text. */
export async function loadPages(competitorId: string): Promise<StoredPage[]> {
  const rows = await db.sourcePage.findMany({
    where: { source: { competitorId } },
    select: { id: true, url: true, hash: true, chars: true, state: true, kind: true, sourceId: true, analyzedKey: true, factsKey: true, source: { select: { type: true } } },
  });
  // "Has text" without loading it: a page that was read has characters; a page whose text was dropped has none.
  const textless = new Set((await db.sourcePage.findMany({ where: { source: { competitorId }, text: null }, select: { id: true } })).map((p) => p.id));
  return rows.map((r) => ({ id: r.id, url: r.url, hash: r.hash, chars: r.chars, state: r.state, kind: r.kind, sourceId: r.sourceId, sourceType: r.source.type, hasText: !textless.has(r.id), analyzedKey: r.analyzedKey, factsKey: r.factsKey }));
}

/** The pages the analysis reads (kinds.ts): strong, plus weak when the workspace reads them. */
export async function pickedPages(ctx: RunContext): Promise<Array<StoredPage & { tier: "strong" | "weak"; pageKind: string }>> {
  return pickPages(await loadPages(ctx.competitor.id), { readWeak: ctx.readWeak });
}

// ————— 1. Research: one call per page —————

export interface ResearchPlan {
  /** Pages the analysis reads at all. */
  picked: number;
  /** Of those, the pages whose current text was not read yet, in address order. */
  todo: Array<StoredPage & { tier: "strong" | "weak"; pageKind: string }>;
}

/**
 * Clean-up (code only, every run) and the to-do. A finding lives only while its page is read and its text is the
 * text it was read from: findings of pages that left the picked set (removed, text gone, kind now skipped, weak
 * pages switched off) are deleted and the page is marked not analyzed.
 */
export async function planResearch(ctx: RunContext): Promise<ResearchPlan> {
  const pages = await loadPages(ctx.competitor.id);
  const picked = pickPages(pages, { readWeak: ctx.readWeak });
  const pickedIds = new Set(picked.map((p) => p.id));
  const dropped = pages.filter((p) => !pickedIds.has(p.id)).map((p) => p.id);
  let removed = 0;
  for (let i = 0; i < dropped.length; i += CHUNK) {
    const ids = dropped.slice(i, i + CHUNK);
    removed += (await db.pageFinding.deleteMany({ where: { competitorId: ctx.competitor.id, pageId: { in: ids } } })).count;
    await db.sourcePage.updateMany({ where: { id: { in: ids }, analyzedKey: { not: null } }, data: { analyzedKey: null, analysisError: null } });
  }
  if (removed) {
    ctx.counters.findingsRemoved += removed;
    ctx.log("info", `${removed} finding${removed === 1 ? "" : "s"} removed: their pages are no longer read (removed, emptied, or of a kind that is skipped)`);
  }
  const todo = researchTodo(picked, RESEARCH_VERSION);
  if (ctx.progress.pagesTotal === 0) {
    ctx.progress.pagesTotal = todo.length;
    ctx.progress.pagesDone = 0;
  }
  ctx.log("info", `${pages.length} stored page${pages.length === 1 ? "" : "s"}: ${picked.length} read by the analysis${ctx.readWeak ? " (blog, news and press included)" : ""}, ${todo.length} new or changed since they were last read`);
  await ctx.flush();
  return { picked: picked.length, todo };
}

function injectedResearch(ctx: RunContext, url: string): string | undefined {
  if (!ctx.answers) return undefined;
  return ctx.answers.research?.[url] ?? ctx.answers.research?.["*"] ?? '{"capabilities": []}';
}

export async function researchStep(ctx: RunContext, plan: ResearchPlan): Promise<void> {
  const competitorId = ctx.competitor.id;
  let failed = 0;
  if (plan.todo.length) {
    await ctx.paced({
      items: plan.todo,
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
          renderResearch({ url: p.url, title: page.title ?? "", text: page.text, kind: page.kind, sourceLabel: C.profile.sourceTypes[p.sourceType] ?? p.sourceType }),
          RESEARCH_TOOL,
          { maxTokens: RESEARCH_MAX_TOKENS, thinking: "low", injected: injectedResearch(ctx, p.url) },
        );
        const parsed = parseResearch(r.value, page.text);
        await db.$transaction([
          db.pageFinding.deleteMany({ where: { pageId: p.id } }),
          db.pageFinding.createMany({
            data: parsed.findings.map((f) => ({
              workspaceId: ctx.run.workspaceId, competitorId, pageId: p.id, pageHash: page.hash, analysisId: ctx.run.id, origin: "research",
              kind: f.kind, wording: f.wording, parentWording: f.parentWording, quote: f.quote, reasoning: f.reasoning,
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
        if (tooManyFailed(failed, plan.todo.length)) throw new AnalysisError("answer", `${failed} of ${plan.todo.length} pages got an unusable answer from PMOS AI — stopping`);
      },
    });
    const read = plan.todo.length - failed;
    ctx.log("info", `Research: ${read} page${read === 1 ? "" : "s"} read${failed ? `, ${failed} skipped (unusable answer)` : ""}`);
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
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function loadItems(competitorId: string): Promise<DbItem[]> {
  const rows = await db.competitorItem.findMany({ where: { competitorId }, orderBy: { key: "asc" } });
  return rows.map((r) => ({
    id: r.id, kind: r.kind === "feature" ? "feature" : "capability", key: r.key, name: r.name, wordings: strings(r.wordings), parentItemId: r.parentItemId, mergeChecked: r.mergeChecked,
    capabilityId: r.capabilityId, featureId: r.featureId, placement: (r.placement as Placement | null) ?? null, matchedBy: r.matchedBy, matchedAt: r.matchedAt, matchAnalysisId: r.matchAnalysisId,
  }));
}

async function loadItemStats(competitorId: string): Promise<Map<string, ItemStats>> {
  const findings = await db.pageFinding.findMany({ where: { competitorId, itemId: { not: null } }, select: { itemId: true, pageId: true, quote: true, wording: true, page: { select: { url: true } } } });
  findings.sort((a, b) => (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0));
  const pages = new Map<string, Set<string>>();
  const out = new Map<string, ItemStats>();
  for (const f of findings) {
    const id = f.itemId!;
    const s = out.get(id) ?? { findings: 0, pages: 0, quote: f.quote, spellings: [] };
    s.findings++;
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
    const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(competitorId)]);
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
    const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(competitorId)]);
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
  const [items, stats] = await Promise.all([loadItems(competitorId), loadItemStats(competitorId)]);
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

  const [items, stats, ours] = await Promise.all([loadItems(competitorId), loadItemStats(competitorId), loadCatalog(workspaceId)]);
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

// ————— 4–6. Built in the next steps of the build —————

export async function secondLookStep(_ctx: RunContext): Promise<void> {}
export async function applyStep(_ctx: RunContext): Promise<void> {}
export async function factsStep(_ctx: RunContext): Promise<void> {}
