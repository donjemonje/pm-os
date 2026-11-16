import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../db";
import { AnswerError } from "../ai";
import { COMPETITORS_COPY as C } from "../copy";
import { chunkKey, chunkTokens, CHUNK_MAX_TOKENS, FRAME_MIN_PAGES, FRAME_SAMPLE_PAGES, NO_FRAME, packChunks, renderChunk, sampleEvenly, SHOW_SITE_FRAME_ONCE, siteFrame, tokensOf, withoutFrame, type ChunkPage, type RenderPage, type SiteFrame } from "./chunks";
import { AnalysisError, type RunContext } from "./engine";
import { itemKey } from "./items";
import { OUTPUT_RESERVE } from "./pacing";
import { loadPages, planOf, type StoredPage } from "./plan";
import { verifyQuote } from "./quotes";
import {
  applyChanges,
  codeList,
  dropUnproven,
  listFrom,
  listSize,
  parseChanges,
  parseList,
  READ_CHANGES_MAX_TOKENS,
  READ_CHANGES_RULES,
  READ_MAX_TOKENS,
  READ_SYSTEM_PROMPT,
  READ_TOOL,
  READ_VERSION,
  readChangesTool,
  renderListSoFar,
  renderReading,
  type ChangeCounts,
  type IncidentDraft,
  type ListCapability,
  type ListEntry,
  type ReadDropped,
  type RequestPage,
  type Unexplained,
} from "./reading";
import { notReadLine, splitByReads } from "./reads";
import { compareAddress, hostOf, pickReadable, READ_ORDER, sectionKey, sortByWhereAPmLooks, type PageRead } from "./sections";
import { readKey } from "./todo";

/**
 * THE READING STEP — the database side (the rules are analysis/reading.ts and analysis/chunks.ts).
 *
 * Per company, own site included, all its sources (website, help centers, developer docs, release notes):
 *   0. Which pages: the ones whose kind is ON in "What the analysis reads" (reads.ts) — the step asks that setting
 *      and nothing else. What a kind that is OFF leaves out is counted per kind and recorded on the run; it is a
 *      configuration, not a cap. Nothing is deleted for it: a proof on a page whose kind was turned off stays.
 *   1. The proofs the company's list already has are checked again in code: a quote whose page changed must still
 *      be on it; a quote whose page is gone, or is in no section that has a kind any more, is lost.
 *   2. The pages whose current text was not read yet are put in the "where a PM looks" order and packed into
 *      chunks (chunks.ts). No page whose text was read is sent again: after setup, a scan sends only the pages
 *      that are new or changed, with the list so far — "what do these pages change".
 *   3. One request per chunk, one after the other (a later request needs the list the earlier ones made). The
 *      first request of a company returns its list; a later one, what its pages change. Each answer is saved in
 *      ONE transaction — the list, the proofs, the mark on every page of the chunk, the record of the request — so a
 *      run that stopped continues with exactly the chunks that are left; their boundaries are the same.
 *   4. When nothing was left unread: what has no proof leaves the list.
 *
 * Starting over: a company none of whose pages was read by this version of the reading (its first chunked read,
 * or READ_VERSION was bumped) starts from an EMPTY list. What the old per-page reading left — its findings and its
 * merged items — is deleted in the transaction that saves the first answer, not before: a first request that fails
 * leaves everything as it was. The company's new items are matched to the catalog again; rows, aliases, removals
 * and overrides live on the catalog and are not touched.
 *
 * Every request is a READING call: it passes the run's token budget before it starts. Chunks the budget left
 * unread stay due — strongest sources were read first.
 *
 * An unusable answer (cut off, empty, invalid) fails the run: a chunk is not skipped and not asked again by itself.
 */

const CHUNK = 500;
/** Tokens of instructions and schema a reading request carries besides the pages and the list so far. */
const READ_OVERHEAD_TOKENS = 3_000;

type ReadablePage = StoredPage & { read: PageRead };

/** The pages a run reads: every page that has a kind (sections.ts pickReadable) and whose kind is ON in "What the analysis reads" (reads.ts). */
export async function readablePages(ctx: RunContext): Promise<ReadablePage[]> {
  return splitByReads(pickReadable(await loadPages(ctx.competitor.id), await planOf(ctx)), ctx.reads).read;
}

/**
 * The run's token budget stopped the reading (caps.ts "token_budget"): recorded with what it left undone so far —
 * the pages left unread and, once the second look was reached, the rows that were not looked for.
 */
export function budgetCap(ctx: RunContext, looksNotMade = 0): void {
  ctx.cap("token_budget", { limit: ctx.reading.limit, undone: ctx.counters.pagesUnread, also: looksNotMade });
}

/** What the page header calls a page's kind: its section's label; a document that is read for itself — outside every section, or in a section that is otherwise not read — is "document". */
export function pageKindOf(read: Pick<PageRead, "label">, kind: string): string {
  if (kind === "document" && (!read.label || read.label === "noise")) return "document";
  return read.label ?? "product";
}

// ————— The list of a company, as stored —————

/** The company's list from the tables: capabilities in their order, features in theirs, each with its proof (null when it has none). */
export async function loadList(competitorId: string): Promise<ListCapability[]> {
  const [items, findings] = await Promise.all([
    db.competitorItem.findMany({ where: { competitorId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, kind: true, name: true, description: true, parentItemId: true } }),
    db.pageFinding.findMany({ where: { competitorId, origin: "reading", itemId: { not: null } }, select: { itemId: true, pageId: true, pageHash: true, quote: true } }),
  ]);
  const proofOf = new Map(findings.map((f) => [f.itemId!, { pageId: f.pageId, pageHash: f.pageHash, quote: f.quote }]));
  const entry = (i: (typeof items)[number]): ListEntry => ({ id: i.id, name: i.name, description: i.description ?? "", proof: proofOf.get(i.id) ?? null });
  const byId = new Map<string, ListCapability>();
  const list: ListCapability[] = [];
  for (const i of items) {
    if (i.kind !== "capability") continue;
    const k: ListCapability = { ...entry(i), features: [] };
    byId.set(i.id, k);
    list.push(k);
  }
  for (const i of items) if (i.kind === "feature" && i.parentItemId) byId.get(i.parentItemId)?.features.push(entry(i));
  return list;
}

const sameProof = (a: ListEntry["proof"], b: ListEntry["proof"]) => (a === null || b === null ? a === b : a.pageId === b.pageId && a.quote === b.quote && a.pageHash === b.pageHash);

/**
 * Make the stored list equal to `next`: entries with no id are created, entries whose name, description, place or
 * proof changed are updated, stored entries that are not in `next` are deleted (a capability with its features).
 * An item keeps its id — and with it its saved match to the catalog — through a correction.
 */
async function syncList(tx: Prisma.TransactionClient, ctx: RunContext, current: ListCapability[], next: ListCapability[]): Promise<{ created: number; deleted: number }> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const stored = new Map<string, { entry: ListEntry; position: number; parentId: string | null }>();
  current.forEach((k, i) => {
    if (k.id) stored.set(k.id, { entry: k, position: i, parentId: null });
    k.features.forEach((f, j) => f.id && stored.set(f.id, { entry: f, position: j, parentId: k.id }));
  });
  const kept = new Set(next.flatMap((k) => [k.id, ...k.features.map((f) => f.id)]).filter((id): id is string => Boolean(id)));
  const gone = [...stored.keys()].filter((id) => !kept.has(id));
  for (let i = 0; i < gone.length; i += CHUNK) {
    const ids = gone.slice(i, i + CHUNK);
    await tx.pageFinding.deleteMany({ where: { competitorId, origin: "reading", itemId: { in: ids } } });
    // Features first: a capability's delete cascades to them, and they must not be asked for after it.
    await tx.competitorItem.deleteMany({ where: { id: { in: ids }, kind: "feature" } });
    await tx.competitorItem.deleteMany({ where: { id: { in: ids } } });
  }
  const newItems: Prisma.CompetitorItemCreateManyInput[] = [];
  const newFindings: Prisma.PageFindingCreateManyInput[] = [];
  const finding = (itemId: string, kind: "capability" | "feature", e: ListEntry, parentName: string | null): Prisma.PageFindingCreateManyInput => ({
    workspaceId, competitorId, pageId: e.proof!.pageId, pageHash: e.proof!.pageHash, analysisId: ctx.run.id, origin: "reading", kind, wording: e.name, parentWording: parentName, quote: e.proof!.quote, reasoning: "", description: e.description || null, itemId,
  });
  const one = async (kind: "capability" | "feature", e: ListEntry, position: number, parent: { id: string; name: string } | null): Promise<string> => {
    const before = e.id ? stored.get(e.id) : undefined;
    if (!e.id || !before) {
      const id = randomUUID();
      newItems.push({ id, workspaceId, competitorId, kind, key: itemKey(kind, parent?.id ?? null, e.name), name: e.name, description: e.description || null, position, parentItemId: parent?.id ?? null, wordings: [] });
      if (e.proof) newFindings.push(finding(id, kind, e, parent?.name ?? null));
      return id;
    }
    const was = before.entry;
    if (was.name !== e.name || was.description !== e.description || before.position !== position) {
      await tx.competitorItem.update({ where: { id: e.id }, data: { name: e.name, key: itemKey(kind, parent?.id ?? null, e.name), description: e.description || null, position } });
    }
    if (!sameProof(was.proof, e.proof) || (e.proof && (was.name !== e.name || was.description !== e.description))) {
      await tx.pageFinding.deleteMany({ where: { competitorId, origin: "reading", itemId: e.id } });
      if (e.proof) newFindings.push(finding(e.id, kind, e, parent?.name ?? null));
    }
    return e.id;
  };
  // Capabilities, then features: a new feature names its capability's id.
  const capabilityIds: string[] = [];
  for (let i = 0; i < next.length; i++) capabilityIds.push(await one("capability", next[i], i, null));
  for (let i = 0; i < next.length; i++) {
    for (let j = 0; j < next[i].features.length; j++) await one("feature", next[i].features[j], j, { id: capabilityIds[i], name: next[i].name });
  }
  const capabilities = newItems.filter((x) => x.kind === "capability");
  const features = newItems.filter((x) => x.kind === "feature");
  if (capabilities.length) await tx.competitorItem.createMany({ data: capabilities });
  for (let i = 0; i < features.length; i += CHUNK) await tx.competitorItem.createMany({ data: features.slice(i, i + CHUNK) });
  for (let i = 0; i < newFindings.length; i += CHUNK) await tx.pageFinding.createMany({ data: newFindings.slice(i, i + CHUNK) });
  return { created: newItems.length, deleted: gone.length };
}

// ————— Step 1: the proofs the list has —————

/**
 * Code only, every run (also for what a second look found). A proof holds while its quote is on its page and the page is read: a proof whose page was
 * removed, emptied or left the reading plan is deleted; a proof whose page changed is checked against the new text —
 * still there → it stays (with the new text's hash); gone → deleted. Returns how many proofs were lost.
 */
async function checkProofs(ctx: RunContext, readable: Map<string, ReadablePage>): Promise<number> {
  const competitorId = ctx.competitor.id;
  // The proofs of the list, and what a second look found: both hold only while their quote is on their page.
  const findings = await db.pageFinding.findMany({ where: { competitorId, origin: { in: ["reading", "second_look"] } }, select: { id: true, pageId: true, pageHash: true, quote: true } });
  const lost: string[] = [];
  const moved = findings.filter((f) => readable.has(f.pageId) && readable.get(f.pageId)!.hash !== f.pageHash);
  for (const f of findings) if (!readable.has(f.pageId)) lost.push(f.id);
  const pageIds = [...new Set(moved.map((f) => f.pageId))];
  for (let i = 0; i < pageIds.length; i += 100) {
    const rows = await db.sourcePage.findMany({ where: { id: { in: pageIds.slice(i, i + 100) } }, select: { id: true, text: true, hash: true } });
    const rowOf = new Map(rows.map((r) => [r.id, r]));
    for (const f of moved.filter((x) => rowOf.has(x.pageId))) {
      const row = rowOf.get(f.pageId)!;
      const quote = row.text == null ? null : verifyQuote(f.quote, row.text);
      if (quote) await db.pageFinding.update({ where: { id: f.id }, data: { pageHash: row.hash, quote } });
      else lost.push(f.id);
    }
  }
  for (let i = 0; i < lost.length; i += CHUNK) await db.pageFinding.deleteMany({ where: { id: { in: lost.slice(i, i + CHUNK) } } });
  if (lost.length) {
    ctx.counters.findingsRemoved += lost.length;
    ctx.log("info", `${lost.length} proof${lost.length === 1 ? "" : "s"} lost: the page changed and the quote is no longer on it, or the page is gone or no longer read. An item of the list that lost its proof is shown to PMOS AI as PROOF LOST with the pages that are new or changed`);
  }
  return lost.length;
}

// ————— Step 2: the chunks —————

interface TodoPage extends ChunkPage {
  url: string;
  hash: string;
  sourceType: string;
  kind: string;
  read: PageRead;
}

export interface ReadingPlanned {
  /** The chunks still to read, in order. */
  chunks: TodoPage[][];
  /** The frame of each source that has one. */
  frames: Map<string, SiteFrame>;
  frameTokens: Map<string, number>;
  /** Readable pages in all, and the ones whose current text was not read yet. */
  readable: number;
  todo: number;
}

/** The frame of every source that has pages to read: from a sample of ALL its readable pages, so it is the same whatever was read already. */
async function loadFrames(readable: ReadablePage[], todoSources: Set<string>): Promise<Map<string, SiteFrame>> {
  const frames = new Map<string, SiteFrame>();
  if (!SHOW_SITE_FRAME_ONCE) return frames;
  const bySource = new Map<string, ReadablePage[]>();
  for (const p of readable) if (todoSources.has(p.sourceId)) bySource.set(p.sourceId, [...(bySource.get(p.sourceId) ?? []), p]);
  for (const [sourceId, pages] of bySource) {
    if (pages.length < FRAME_MIN_PAGES) continue;
    const sample = sampleEvenly([...pages].sort((a, b) => compareAddress(a.url, b.url)), FRAME_SAMPLE_PAGES);
    const texts: string[] = [];
    for (let i = 0; i < sample.length; i += 50) {
      const rows = await db.sourcePage.findMany({ where: { id: { in: sample.slice(i, i + 50).map((p) => p.id) } }, select: { text: true } });
      for (const r of rows) if (r.text != null) texts.push(r.text);
    }
    const frame = siteFrame(texts);
    if (frame.lines.size) frames.set(sourceId, frame);
  }
  return frames;
}

/**
 * What a company has left to read, as chunks. `all` = every readable page instead of only the ones that are due
 * (the second look reads the whole company again).
 */
export async function planChunks(ctx: RunContext, readable: ReadablePage[], opts: { all?: boolean } = {}): Promise<ReadingPlanned> {
  const plan = await planOf(ctx);
  const due = opts.all ? readable : readable.filter((p) => p.analyzedKey !== readKey(READ_VERSION, p.hash));
  const ordered = sortByWhereAPmLooks(due);
  const frames = await loadFrames(readable, new Set(ordered.map((p) => p.sourceId)));
  // The size of each page as it is sent: its own text, without the frame of its source.
  const tokens = new Map<string, number>();
  for (let i = 0; i < ordered.length; i += 100) {
    const batch = ordered.slice(i, i + 100);
    const framed = batch.filter((p) => frames.has(p.sourceId));
    for (const p of batch) if (!frames.has(p.sourceId)) tokens.set(p.id, tokensOf(p.chars));
    if (!framed.length) continue;
    const rows = await db.sourcePage.findMany({ where: { id: { in: framed.map((p) => p.id) } }, select: { id: true, text: true, sourceId: true } });
    for (const r of rows) tokens.set(r.id, tokensOf(withoutFrame(r.text ?? "", frames.get(r.sourceId) ?? NO_FRAME).length));
  }
  const frameTokens = new Map([...frames.entries()].map(([id, f]) => [id, tokensOf(f.text.length)]));
  const pages: TodoPage[] = ordered.map((p) => {
    const section = plan.sectionOf(p);
    return { id: p.id, url: p.url, hash: p.hash, sourceId: p.sourceId, sourceType: p.sourceType, kind: p.kind, read: p.read, section: section ? sectionKey(p.sourceId, section.prefix) : "", tokens: tokens.get(p.id) ?? tokensOf(p.chars) };
  });
  return { chunks: packChunks(pages, { maxTokens: CHUNK_MAX_TOKENS, frameTokens }), frames, frameTokens, readable: readable.length, todo: due.length };
}

/** "40 release notes, 210 help, 12 pricing" — the pages of a chunk by kind, in reading order. */
function kindsLine(pages: TodoPage[]): string {
  const counts = kindCounts(pages);
  return [...READ_ORDER.map(String), "document"].filter((k) => counts[k]).map((k) => `${counts[k]} ${k.replace("_", " ")}`).join(", ");
}
function kindCounts(pages: TodoPage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pages) {
    const k = pageKindOf(p.read, p.kind);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** The texts of a chunk's pages, read now: the request and the quote check use the same read, and the mark on the page is the hash of that text. */
export async function loadChunkPages(chunk: TodoPage[], frames: Map<string, SiteFrame>): Promise<{ request: RequestPage[]; render: RenderPage[]; frames: Array<{ label: string; text: string }> }> {
  const rowOf = new Map<string, { id: string; url: string; title: string | null; text: string | null; hash: string }>();
  for (let i = 0; i < chunk.length; i += 100) {
    const rows = await db.sourcePage.findMany({ where: { id: { in: chunk.slice(i, i + 100).map((p) => p.id) } }, select: { id: true, url: true, title: true, text: true, hash: true } });
    for (const r of rows) rowOf.set(r.id, r);
  }
  const request: RequestPage[] = [];
  const render: RenderPage[] = [];
  const shown = new Map<string, { label: string; text: string }>();
  for (const p of chunk) {
    const row = rowOf.get(p.id);
    // A page a scan removed or emptied since the plan was made is simply not in the request.
    if (!row || row.text == null) continue;
    const code = `P${request.length + 1}`;
    const frame = frames.get(p.sourceId);
    request.push({ code, id: row.id, url: row.url, hash: row.hash, text: row.text });
    render.push({ code, url: row.url, kind: pageKindOf(p.read, p.kind), title: row.title ?? "", text: frame ? withoutFrame(row.text, frame) : row.text });
    if (frame && !shown.has(p.sourceId)) shown.set(p.sourceId, { label: `${C.profile.sourceTypes[p.sourceType] ?? p.sourceType} ${hostOf(row.url)}`, text: frame.text });
  }
  return { request, render, frames: [...shown.values()] };
}

// ————— Step 3: the requests —————

const EMPTY_LIST_ANSWER = '{"capabilities": [], "unexplained": []}';
const EMPTY_CHANGES_ANSWER = '{"new_capabilities": [], "new_features": [], "corrections": [], "removed": [], "unexplained": []}';

export async function readingStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const pages = await loadPages(competitorId);
  // Every page that has a kind; then the setting: the kinds that are on are read, the others are counted and left out.
  const withKind = pickReadable(pages, await planOf(ctx));
  const { read: readable, notRead } = splitByReads(withKind, ctx.reads);
  ctx.setNotRead(notRead);
  // A company starts over when this version of the reading never made a request for it.
  const fresh = (await db.competitorChunk.count({ where: { competitorId, version: READ_VERSION } })) === 0;
  // A proof holds while its page has a kind — whether that kind is on today or not: a switch never deletes what was read.
  await checkProofs(ctx, new Map(withKind.map((p) => [p.id, p])));

  const planned = await planChunks(ctx, readable);
  const { chunks, frames, frameTokens } = planned;
  if (ctx.progress.pagesTotal === 0) {
    ctx.progress.pagesTotal = planned.todo;
    ctx.progress.pagesDone = 0;
  }
  const framed = [...frameTokens.values()].filter((n) => n > 0).length;
  const left = notReadLine(notRead);
  if (left) ctx.log("info", `Not read — their kind is off in "What the analysis reads" (a setting, not a limit): ${left}. They stay stored and are due the moment the kind is turned on`);
  ctx.log("info", `Reading: ${pages.length} stored page${pages.length === 1 ? "" : "s"}, ${planned.readable} of the kinds that are read, ${planned.todo} new or changed since they were last read${chunks.length ? ` — ${chunks.length} request${chunks.length === 1 ? "" : "s"} of at most ${CHUNK_MAX_TOKENS.toLocaleString("en-US")} tokens, strongest sources first${framed ? ` (${framed} site${framed === 1 ? "" : "s"} repeat${framed === 1 ? "s" : ""} a frame on most pages: it is shown once per request)` : ""}` : " — PMOS AI not asked"}${fresh && chunks.length ? ". First reading of this company by chunks: its list starts empty" : ""}`);
  await ctx.flush();

  let saved = 0;
  let startOver = fresh;
  if (chunks.length) {
    const result = await ctx.paced({
      items: chunks.map((chunk, n) => ({ chunk, n: n + 1 })),
      reading: true,
      // One after the other: a request needs the list the ones before it made.
      concurrency: 1,
      estimate: ({ chunk }) => chunkTokens(chunk, frameTokens) + READ_OVERHEAD_TOKENS + OUTPUT_RESERVE,
      work: async ({ chunk, n }) => {
        const loaded = await loadChunkPages(chunk, frames);
        const current = startOver ? [] : await loadList(competitorId);
        const first = current.length === 0;
        const coded = codeList(current);
        const pagesText = renderChunk(loaded.frames, loaded.render);
        const tail = renderReading(ctx.competitor.name, first ? null : renderListSoFar(coded), pagesText);
        // TEST KNOB: the answer of the n-th reading request of this company in the run; none given = an answer that lists or changes nothing.
        const injected = ctx.answers ? ctx.answers.reading?.[ctx.counters.readRequests] ?? (first ? EMPTY_LIST_ANSWER : EMPTY_CHANGES_ANSWER) : undefined;
        const r = await (first
          ? ctx.call<Record<string, unknown>>(READ_SYSTEM_PROMPT, "", tail, READ_TOOL, { role: "read", maxTokens: READ_MAX_TOKENS, injected })
          : ctx.call<Record<string, unknown>>(`${READ_SYSTEM_PROMPT}\n\n${READ_CHANGES_RULES}`, "", tail, readChangesTool(coded.filter((c) => c.kind === "capability").map((c) => c.code), coded.map((c) => c.code)), { role: "read", maxTokens: READ_CHANGES_MAX_TOKENS, injected })
        ).catch((e: unknown) => {
          // A chunk is not skipped and not asked again by itself: an unusable answer stops the run, with the request named.
          if (e instanceof AnswerError) throw new AnalysisError("answer", `Reading request ${n} of ${chunks.length} for ${ctx.competitor.name} (${loaded.request.length} pages) got an unusable answer — ${e.message}`);
          throw e;
        });
        ctx.counters.readRequests++;

        let next: ListCapability[];
        let counts: ChangeCounts;
        let incidents: IncidentDraft[];
        let dropped: ReadDropped;
        let unexplained: Unexplained[];
        const removed: string[] = [];
        if (first) {
          const parsed = parseList(r.value, loaded.request);
          next = listFrom(parsed.capabilities);
          const size = listSize(next);
          counts = { newCapabilities: size.capabilities, newFeatures: size.features, corrections: 0, removed: 0 };
          ({ incidents, dropped, unexplained } = parsed);
        } else {
          const parsed = parseChanges(r.value, coded, loaded.request);
          ({ list: next, counts } = applyChanges(current, parsed.ops));
          ({ incidents, dropped, unexplained } = parsed);
          for (const op of parsed.ops) if (op.op === "remove") removed.push(`${op.target.name}${op.why ? ` — ${op.why}` : ""}`);
        }
        const size = listSize(next);
        const key = chunkKey(loaded.request);
        const estimated = chunkTokens(chunk, frameTokens);
        let created = 0;
        await db.$transaction(
          async (tx) => {
            if (startOver) {
              // What the old per-page reading left, and a list made by an older version of this one: gone with the first answer of the new reading.
              await tx.pageFinding.deleteMany({ where: { competitorId, origin: { in: ["research", "reading"] } } });
              await tx.competitorItem.deleteMany({ where: { competitorId, kind: "feature" } });
              await tx.competitorItem.deleteMany({ where: { competitorId } });
            }
            created = (await syncList(tx, ctx, current, next)).created;
            // The mark on every page of the chunk: the hash of the text that was read — a page a scan changed meanwhile is simply due again.
            const ids = loaded.request.map((p) => p.id);
            const keys = loaded.request.map((p) => readKey(READ_VERSION, p.hash));
            await tx.$executeRaw`UPDATE "SourcePage" AS p SET "analyzedKey" = v.key, "analyzedAt" = now(), "analysisError" = NULL FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${keys}::text[]) AS key) AS v WHERE p.id = v.id`;
            await tx.competitorChunk.create({
              data: {
                workspaceId, competitorId, analysisId: ctx.run.id, version: READ_VERSION, position: ctx.counters.readRequests, kind: first ? "list" : "changes", key, pages: loaded.request.length, tokens: estimated,
                kinds: kindCounts(chunk) as Prisma.InputJsonValue, firstUrl: loaded.request[0]?.url ?? "", lastUrl: loaded.request[loaded.request.length - 1]?.url ?? "", model: r.model,
                inputTokens: r.usage.input, outputTokens: r.usage.output, thinkingTokens: r.usage.thinking, ms: r.ms,
                result: { capabilities: size.capabilities, features: size.features, ...counts, incidents: incidents.length, ...dropped } as Prisma.InputJsonValue,
                unexplained: unexplained as unknown as Prisma.InputJsonValue,
              },
            });
          },
          { timeout: 300_000, maxWait: 30_000 },
        );
        startOver = false;
        saved++;
        for (const i of incidents) ctx.incident({ ...i, request: n });
        ctx.progress.pagesDone += chunk.length;
        ctx.counters.pagesRead += loaded.request.length;
        ctx.counters.itemsNew += created;
        ctx.counters.findings += created;
        ctx.counters.quotesDropped += incidents.filter((i) => i.kind !== "unknown_item").length;
        ctx.counters.piiHits += dropped.pii;
        const did = first
          ? `the list: ${size.capabilities} capabilit${size.capabilities === 1 ? "y" : "ies"}, ${size.features} feature${size.features === 1 ? "" : "s"}`
          : `changes: +${counts.newCapabilities} capabilit${counts.newCapabilities === 1 ? "y" : "ies"}, +${counts.newFeatures} feature${counts.newFeatures === 1 ? "" : "s"}, ${counts.corrections} correction${counts.corrections === 1 ? "" : "s"}, ${counts.removed} removed → ${size.capabilities} capabilit${size.capabilities === 1 ? "y" : "ies"}, ${size.features} feature${size.features === 1 ? "" : "s"}`;
        const left = [dropped.repeated ? `${dropped.repeated} listed twice` : "", dropped.unnamed ? `${dropped.unnamed} with no name` : "", dropped.pii ? `${dropped.pii} naming a person` : "", dropped.renameRefused ? `${dropped.renameRefused} rename${dropped.renameRefused === 1 ? "" : "s"} refused (the name is taken)` : ""].filter(Boolean).join(", ");
        ctx.log(incidents.length ? "warn" : "info", `Request ${n} of ${chunks.length}: ${loaded.request.length} page${loaded.request.length === 1 ? "" : "s"} (${kindsLine(chunk)}), ~${Math.round(estimated / 1000)}k tokens · ${Math.round(r.ms / 1000)} s · ${did}${unexplained.length ? ` · ${unexplained.length} label${unexplained.length === 1 ? "" : "s"} seen but not explained` : ""}${left ? ` · left out: ${left}` : ""}${incidents.length ? ` · ${incidents.length} INCIDENT${incidents.length === 1 ? "" : "S"} (kept on the run; nothing of them is in the list)` : ""}`);
        for (const line of removed) ctx.log("info", `Removed from the list: ${line}`);
        return r.tokens;
      },
    });
    if (result.left) {
      const unread = chunks.slice(chunks.length - result.left).reduce((n, c) => n + c.length, 0);
      ctx.counters.pagesUnread += unread;
      ctx.progress.pagesTotal = Math.max(ctx.progress.pagesDone, ctx.progress.pagesTotal - unread);
      budgetCap(ctx);
      ctx.log("warn", `Reading: the token budget per company (${ctx.reading.limit.toLocaleString("en-US")}) was reached — ${result.left} request${result.left === 1 ? "" : "s"} (${unread} page${unread === 1 ? "" : "s"}) not made. The strongest sources were read first; what is left stays due for the next run`);
    }
  }

  // Step 4. Nothing was left unread: what has no proof leaves the list. (A company that still has only the old per-page list is not touched.)
  const hasList = !fresh || saved > 0;
  if (hasList && ctx.counters.pagesUnread === 0) {
    const current = await loadList(competitorId);
    const { list: next, dropped } = dropUnproven(current);
    if (dropped) {
      await db.$transaction((tx) => syncList(tx, ctx, current, next), { timeout: 120_000, maxWait: 30_000 });
      ctx.log("info", `${dropped} item${dropped === 1 ? "" : "s"} left the list: no page that is read shows ${dropped === 1 ? "it" : "them"} any more`);
    }
  }
  // The change has been read: the texts before it are dropped (no retention).
  const released = await db.sourcePage.updateMany({ where: { source: { competitorId }, previousText: { not: null } }, data: { previousText: null, previousHash: null } });
  if (released.count) ctx.log("info", `${released.count} previous page text${released.count === 1 ? "" : "s"} dropped (the change was read)`);
  if (hasList) {
    const size = listSize(await loadList(competitorId));
    ctx.log("info", `${ctx.competitor.name}'s list: ${size.capabilities} capabilit${size.capabilities === 1 ? "y" : "ies"}, ${size.features} feature${size.features === 1 ? "" : "s"}${saved ? ` — ${saved} request${saved === 1 ? "" : "s"} in this run` : ""}`);
  }
  await ctx.flush();
}
