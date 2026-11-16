import { Prisma } from "@prisma/client";
import { db } from "../../db";
import { AnswerError } from "../ai";
import { recordCompetitorEvent } from "../analytics";
import { COMPETITORS_COPY as C } from "../copy";
import { aliasList, judgeNewRow, NameIndex, type Resolved } from "../decisions";
import { ownEvidenceOf, ownStatusAfterRun, readOwnEvidence } from "../own";
import { cellFromEvidence, evidenceByRow, type CellFromEvidence, type Evidence, type EvidenceMaps, type RowFinding } from "./cells";
import { chunkKey, chunkTokens, renderChunk } from "./chunks";
import { AnalysisError, queueCatalogAnalyses, type RunContext } from "./engine";
import { batchItems, buildCatalog, type Catalog } from "./match";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { planOf } from "./plan";
import { LOOK_MAX_TOKENS, LOOK_SYSTEM_PROMPT, lookTool, MATCH_MAX_TOKENS, MATCH_SYSTEM_PROMPT, matchTool, parseLook, parseMatch, renderLook, renderMatchTail, type LookRow, type MatchTheirEntry, type Placement } from "./prompts";
import { budgetCap, loadChunkPages, planChunks, readablePages } from "./read-step";
import { chunksLeft, lookFingerprint, lookKey, readLookProgress } from "./secondlook";
import type { ReadingPlan } from "./sections";
import { rowsSince } from "./todo";

/**
 * The database side of the steps of an analysis run after the reading (Capability Analysis, "How the analysis runs";
 * the map step is analysis/plan.ts, the reading analysis/read-step.ts): match, second look, apply. Every step
 * computes its to-do from the tables and saves each unit of work in one transaction, so a run that stopped
 * continues with exactly what is left. The rules themselves are the pure modules next to this file.
 */

const CHUNK = 1000;

// ————— The company's list, as the match and the cells see it —————

interface DbItem {
  id: string;
  kind: "capability" | "feature";
  key: string;
  name: string;
  /** What it does, in the company's own words; "" when its list does not say. */
  description: string;
  position: number;
  parentItemId: string | null;
  capabilityId: string | null;
  featureId: string | null;
  placement: Placement | null;
  matchedBy: string | null;
  matchedAt: Date | null;
  matchAnalysisId: string | null;
}

interface ItemProof {
  /** The quote that proves the item. */
  quote: string;
  /** Its page is a strong one (the reading plan, sections.ts) — what the cell rules call found. */
  strong: boolean;
}

/** A placement as the match call saves it; anything else in the column (a setup run's own marks) is not one. */
function readPlacement(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.setupRow === true || r.setupFeature === true || r.setupMove === true) return null;
  if (typeof r.marketName !== "string" && typeof r.description !== "string") return null;
  return { domainId: typeof r.domainId === "string" ? r.domainId : null, marketName: typeof r.marketName === "string" ? r.marketName : "", description: typeof r.description === "string" ? r.description : "" };
}

async function loadItems(competitorId: string): Promise<DbItem[]> {
  const rows = await db.competitorItem.findMany({ where: { competitorId }, orderBy: [{ position: "asc" }, { key: "asc" }] });
  return rows.map((r) => ({
    id: r.id, kind: r.kind === "feature" ? "feature" : "capability", key: r.key, name: r.name, description: r.description ?? "", position: r.position, parentItemId: r.parentItemId,
    capabilityId: r.capabilityId, featureId: r.featureId, placement: readPlacement(r.placement), matchedBy: r.matchedBy, matchedAt: r.matchedAt, matchAnalysisId: r.matchAnalysisId,
  }));
}

async function loadItemProofs(ctx: RunContext): Promise<Map<string, ItemProof>> {
  const plan = await planOf(ctx);
  const findings = await db.pageFinding.findMany({ where: { competitorId: ctx.competitor.id, itemId: { not: null } }, select: { itemId: true, quote: true, page: { select: { url: true, kind: true, sourceId: true, readAs: true, source: { select: { type: true } } } } } });
  findings.sort((a, b) => (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0));
  const out = new Map<string, ItemProof>();
  for (const f of findings) {
    const strong = plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind, readAs: f.page.readAs }).tier === "strong";
    const p = out.get(f.itemId!);
    if (!p) out.set(f.itemId!, { quote: f.quote, strong });
    else if (strong) p.strong = true;
  }
  return out;
}

// ————— Match: the company's new items against the rows that exist —————

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

/**
 * After setup: every item of the company's list that has no saved match — the ones the reading just added — is
 * matched to the rows that exist. First in code (a name the catalog knows, today's or one a PM replaced), then by
 * PMOS AI with our rows as a closed set of codes. What matches nothing gets a market name, a description and, for a
 * capability, an EXISTING domain: the apply step makes it a new row there.
 */
export async function matchStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  // 1. Repair: a saved match whose row of ours was hard-deleted is no match any more.
  await db.competitorItem.updateMany({ where: { competitorId, matchedAt: { not: null }, capabilityId: null, featureId: null, placement: { equals: Prisma.DbNull } }, data: { matchedAt: null, matchedBy: null, matchAnalysisId: null } });

  const [items, proofs, ours] = await Promise.all([loadItems(competitorId), loadItemProofs(ctx), loadCatalog(workspaceId)]);
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
  const now = new Date();
  for (const item of [...todo.filter((i) => i.kind === "capability"), ...todo.filter((i) => i.kind === "feature")]) {
    const parentCapabilityId = item.kind === "feature" && item.parentItemId ? byId.get(item.parentItemId)?.capabilityId ?? null : null;
    const feature = parentCapabilityId ? featureIndex.get(parentCapabilityId)?.resolve(item.name) ?? null : null;
    const capability = feature ? null : capabilityIndex.resolve(item.name);
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
        code: codeOfItem.get(i.id)!, kind: i.kind, name: i.name, description: i.description, quote: proofs.get(i.id)?.quote ?? "",
        parent: i.kind === "feature" && parent ? (codeOfItem.has(parent.id) ? { code: codeOfItem.get(parent.id)! } : { name: parent.name }) : null,
      };
    });
    const tail = renderMatchTail(ctx.competitor.name, entries);
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
        const r = await ctx.call<Record<string, unknown>>(MATCH_SYSTEM_PROMPT, ours.catalog.shared, t, matchTool(entries.map((e) => e.code), ours.catalog), { role: "match", maxTokens: MATCH_MAX_TOKENS, injected });
        ctx.counters.matchCalls++;
        const parsed = parseMatch(r.value, entries, ours.catalog);
        if (parsed.unknownOurs.length) ctx.log("warn", `Match: ${parsed.unknownOurs.length} answer${parsed.unknownOurs.length === 1 ? "" : "s"} named a code that is not ours (${parsed.unknownOurs.slice(0, 3).join(", ")}) — counted as none of ours`);
        if (parsed.noDomain.length) ctx.log("warn", `Match: ${parsed.noDomain.length} new capabilit${parsed.noDomain.length === 1 ? "y was" : "ies were"} given no domain of ours — asked again`);
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

/**
 * No table of its own: the company's findings, each with its page's place in the reading plan (its tier and kind,
 * sections.ts), put on the rows by the cell rule (cells.ts evidenceByRow): a company has a row when it has its own
 * capability on it OR any feature under it; a second look's finding answers its row.
 */
async function loadEvidence(workspaceId: string, competitorId: string, plan: ReadingPlan): Promise<EvidenceMaps> {
  const [findings, features] = await Promise.all([
    db.pageFinding.findMany({
      where: { competitorId, OR: [{ itemId: { not: null } }, { capabilityId: { not: null } }] },
      select: { id: true, origin: true, quote: true, reasoning: true, description: true, wording: true, capabilityId: true, item: { select: { capabilityId: true, featureId: true, name: true, description: true } }, page: { select: { url: true, kind: true, sourceId: true, readAs: true, source: { select: { type: true } } } } },
    }),
    db.feature.findMany({ where: { workspaceId, state: "active" }, select: { id: true, capabilityId: true } }),
  ]);
  const rows: RowFinding[] = [];
  for (const f of findings) {
    const t = plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind, readAs: f.page.readAs });
    if (t.tier === "skip") continue;
    const look = f.origin === "second_look";
    const evidence: Evidence = { findingId: f.id, pageUrl: f.page.url, tier: t.tier, pageKind: t.kind, origin: look ? "second_look" : "reading", quote: f.quote, reasoning: f.reasoning, wording: f.item?.name ?? f.wording, description: f.item?.description ?? f.description };
    rows.push({ evidence, item: look ? null : f.item, lookCapabilityId: look ? f.capabilityId : null });
  }
  return evidenceByRow(rows, new Map(features.map((f) => [f.id, f.capabilityId])));
}

/** The rows of ours that have a cell: active capabilities in a domain that is in the table (or suggested), and their active features. */
export async function tableRows(workspaceId: string) {
  const capabilities = await db.capability.findMany({
    where: { workspaceId, state: "active", domain: { state: { in: ["active", "suggested"] } } },
    select: { id: true, name: true, description: true, aliases: true, ourStatus: true, domain: { select: { name: true, description: true } } },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
  const features = await db.feature.findMany({ where: { workspaceId, state: "active", capabilityId: { in: capabilities.map((k) => k.id) } }, select: { id: true, capabilityId: true, name: true } });
  return { capabilities, features };
}

// ————— Second look, in bulk: OUR rows the company has no item for, asked once per chunk of its pages —————

const NOTHING_FOUND_ANSWER = '{"found": []}';
/** Tokens of instructions and schema a second-look request carries besides the rows and the pages. */
const LOOK_OVERHEAD_TOKENS = 3_000;

/**
 * The parity question (secondlook.ts): for the rows the organization itself has and this company has no evidence
 * for, each chunk of the company's pages is asked once which of them it shows. A row a chunk shows gets a finding
 * and is not asked about in the chunks after it; a row no chunk shows keeps the key it was asked with, so the same
 * question is not asked again. Rows that are not ours are not looked for.
 *
 * Returns the rows whose look is due but was not finished in this run (the token budget): the apply step writes no
 * cell for them — a cell says not found only after a look found nothing.
 */
export async function secondLookStep(ctx: RunContext): Promise<Set<string>> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const waiting = new Set<string>();
  ctx.counters.secondLooksWaiting = 0;
  const [{ capabilities }, evidence] = await Promise.all([tableRows(workspaceId), loadEvidence(workspaceId, competitorId, await planOf(ctx))]);
  const candidates = capabilities.filter((k) => k.ourStatus === "found" && !evidence.byCapability.get(k.id)?.length);
  if (!candidates.length) return waiting;
  const asked = new Map((await db.capabilityStatus.findMany({ where: { competitorId, capabilityId: { in: candidates.map((k) => k.id) } }, select: { capabilityId: true, lookKey: true } })).map((c) => [c.capabilityId, c.lookKey]));
  const keyOf = new Map(candidates.map((k) => [k.id, lookKey({ name: k.name, description: k.description, aliases: aliasList(k.aliases) }, k.domain, ctx.model)]));
  const due = candidates.filter((k) => asked.get(k.id) !== keyOf.get(k.id));
  if (!due.length) return waiting;
  // The only write to a cell outside the apply step, and it writes no value on an existing cell: what the row was looked for with.
  const saveKeys = async (rows: typeof due) => {
    for (const k of rows) {
      await db.capabilityStatus.upsert({
        where: { competitorId_capabilityId: { competitorId, capabilityId: k.id } },
        create: { workspaceId, competitorId, capabilityId: k.id, value: "not_found", lookKey: keyOf.get(k.id)!, changedAt: null },
        update: { lookKey: keyOf.get(k.id)! },
      });
    }
  };
  const readable = await readablePages(ctx);
  if (!readable.length) {
    // No page of the company is read: there is nothing to ask. Remembered, so the rows are looked for again only when they change.
    await saveKeys(due);
    return waiting;
  }
  // The whole company again, in the reading's own chunks (the same order, the same boundaries).
  const planned = await planChunks(ctx, readable, { all: true });
  const chunks = planned.chunks;
  const fingerprint = lookFingerprint([ctx.model], chunks.map((c) => chunkKey(c)));
  // A look that stopped half-way continues after the chunks it asked — when it is the same look: the same chunks, and no row that was not part of it.
  const cursor = ctx.run.cursor.look && typeof ctx.run.cursor.look === "object" ? (ctx.run.cursor.look as Record<string, unknown>) : null;
  const savedRows = new Set(Array.isArray(cursor?.rows) ? (cursor.rows as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const same = due.every((k) => savedRows.has(k.id));
  const { from } = chunksLeft(chunks.length, same ? readLookProgress(cursor) : null, fingerprint);
  const rows: LookRow[] = due.map((k, n) => ({ code: `R${n + 1}`, capabilityId: k.id, name: k.name, description: k.description, aliases: aliasList(k.aliases), domain: k.domain.name }));
  const rowIds = from > 0 ? [...savedRows] : due.map((k) => k.id);
  const found = new Set<string>();
  ctx.log("info", `Second look: ${due.length} of your capabilities have no evidence at ${ctx.competitor.name} — asking once per chunk of its pages: ${chunks.length - from} request${chunks.length - from === 1 ? "" : "s"}${from ? ` (${from} were made before the run stopped)` : ""}`);
  const result = await ctx.paced({
    items: chunks.slice(from).map((chunk, i) => ({ chunk, n: from + i + 1 })),
    reading: true,
    // One after the other: a row a chunk shows is not asked about in the next.
    concurrency: 1,
    estimate: ({ chunk }) => chunkTokens(chunk, planned.frameTokens) + LOOK_OVERHEAD_TOKENS + OUTPUT_RESERVE,
    work: async ({ chunk, n }) => {
      const open = rows.filter((r) => !found.has(r.capabilityId));
      let tokens = 0;
      if (open.length) {
        const loaded = await loadChunkPages(chunk, planned.frames);
        // TEST KNOB: the answer of the n-th second-look request of this company in the run; none given = nothing found.
        const injected = ctx.answers ? ctx.answers.secondLook?.[ctx.counters.lookRequests] ?? NOTHING_FOUND_ANSWER : undefined;
        const r = await ctx.call<Record<string, unknown>>(LOOK_SYSTEM_PROMPT, "", renderLook(ctx.competitor.name, open, renderChunk(loaded.frames, loaded.render)), lookTool(open.map((x) => x.code)), { role: "read", maxTokens: LOOK_MAX_TOKENS, injected }).catch((e: unknown) => {
          if (e instanceof AnswerError) throw new AnalysisError("answer", `Second-look request ${n} of ${chunks.length} for ${ctx.competitor.name} got an unusable answer — ${e.message}`);
          throw e;
        });
        ctx.counters.lookRequests++;
        ctx.counters.secondLooks += open.length;
        tokens = r.tokens;
        const parsed = parseLook(r.value, open, loaded.request);
        for (const i of parsed.incidents) ctx.incident({ ...i, request: n });
        ctx.counters.quotesDropped += parsed.incidents.filter((i) => i.kind !== "unknown_item").length;
        if (parsed.found.length) {
          await db.pageFinding.createMany({
            data: parsed.found.map((f) => ({ workspaceId, competitorId, pageId: f.pageId, pageHash: f.pageHash, analysisId: ctx.run.id, origin: "second_look", kind: "capability", wording: f.wording || rows.find((x) => x.capabilityId === f.capabilityId)!.name, quote: f.quote, reasoning: "", capabilityId: f.capabilityId })),
          });
          for (const f of parsed.found) {
            found.add(f.capabilityId);
            ctx.counters.secondLookFound++;
            ctx.log("info", `Second look: found "${rows.find((x) => x.capabilityId === f.capabilityId)!.name}"`, loaded.request.find((p) => p.id === f.pageId)?.url);
          }
        }
        ctx.log("info", `Second look, request ${n} of ${chunks.length}: ${loaded.request.length} page${loaded.request.length === 1 ? "" : "s"}, ${open.length} row${open.length === 1 ? "" : "s"} asked · ${Math.round(r.ms / 1000)} s · ${parsed.found.length} found${parsed.incidents.length ? ` · ${parsed.incidents.length} INCIDENT${parsed.incidents.length === 1 ? "" : "S"}` : ""}`);
      }
      // How far the look got: a run that stops here continues with the next chunk.
      await ctx.saveCursor({ look: { fingerprint, rows: rowIds, done: n } });
      return tokens;
    },
  });
  const notFound = due.filter((k) => !found.has(k.id));
  if (result.left) {
    // The token budget was reached: the rows that were not found so far were not looked for on every chunk — no cell is written for them.
    for (const k of notFound) waiting.add(k.id);
    ctx.counters.secondLooksWaiting = waiting.size;
    budgetCap(ctx, waiting.size);
  } else {
    await saveKeys(notFound);
    await ctx.saveCursor({ look: null });
  }
  ctx.log(result.left ? "warn" : "info", `Second look: ${found.size} found, ${result.left ? `${waiting.size} not looked for on every chunk — the run's token budget (${ctx.reading.limit.toLocaleString("en-US")}) was reached` : `${notFound.length} not found`}`);
  await ctx.flush();
  return waiting;
}

// ————— Apply: rows, then cells — no AI —————

/** The apply step of an analysis run: the rows, then the cells. A setup run fills the cells only (its rows are made by unify and domains, analysis/setup.ts). */
export async function applyStep(ctx: RunContext, lookWaiting: ReadonlySet<string> = new Set()): Promise<void> {
  await applyRows(ctx);
  await applyCells(ctx, lookWaiting);
}

/**
 * A. Rows: the company's items that are none of ours become capabilities and features — through decisions.ts, so a
 * PM's decision is never reopened. A new capability goes into the EXISTING domain the match named. A row made from
 * an item of the organization's OWN source is ours: its own cell starts as found (own.ts); a row made from a
 * competitor's item starts as not found for us.
 */
export async function applyRows(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const ourStatus = ctx.competitor.isOwn ? "found" : "not_found";
  const respected = (entity: "capability" | "feature", row: Resolved, found: string) =>
    recordCompetitorEvent(workspaceId, null, "cmp_decision_respected", { entity, entityId: row.id, name: row.name, found, reason: row.state, competitorId, analysisId: ctx.run.id });

  const [items, proofs] = await Promise.all([loadItems(competitorId), loadItemProofs(ctx)]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const byName = (a: DbItem, b: DbItem) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const todo = items.filter((i) => i.placement && !i.capabilityId && !i.featureId);
  if (todo.length) {
    const [domainRows, capabilityRows, featureRows] = await Promise.all([
      db.competitorDomain.findMany({ where: { workspaceId }, select: { id: true, name: true, state: true, position: true } }),
      db.capability.findMany({ where: { workspaceId }, select: { id: true, name: true, aliases: true, state: true, position: true } }),
      db.feature.findMany({ where: { workspaceId }, select: { id: true, capabilityId: true, name: true, aliases: true, state: true, position: true } }),
    ]);
    const capabilityIndex = new NameIndex(capabilityRows);
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
    const capabilityState = new Map(capabilityRows.map((k) => [k.id, k.state]));
    // A domain the match named may have left the table since (a PM removed it): then the row goes to the first domain of the table.
    const first = domainRows.filter((d) => d.state === "active").sort((a, b) => a.position - b.position || (a.name < b.name ? -1 : 1))[0]?.id ?? null;
    let position = capabilityRows.filter((k) => k.state === "active").reduce((n, k) => Math.max(n, k.position), -1);
    let noDomain = 0;

    for (const item of [...todo.filter((i) => i.kind === "capability").sort(byName), ...todo.filter((i) => i.kind === "feature").sort(byName)]) {
      const placement = item.placement!;
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
        const domainId = placement.domainId && ["active", "suggested"].includes(domainState.get(placement.domainId) ?? "") ? placement.domainId : first;
        if (!domainId) {
          noDomain++;
          continue;
        }
        position++;
        const capabilityId = await db.$transaction(async (tx) => {
          const capability = await tx.capability.create({ data: { workspaceId, domainId, name: verdict.name, description: placement.description || item.description, ourStatus, origin: "ai", state: "active", position }, select: { id: true } });
          await tx.competitorItem.update({ where: { id: item.id }, data: { capabilityId: capability.id, matchedBy: "created" } });
          return capability.id;
        });
        item.capabilityId = capabilityId;
        item.matchedBy = "created";
        capabilityIndex.add({ id: capabilityId, name: verdict.name, aliases: [], state: "active" });
        capabilityState.set(capabilityId, "active");
        ctx.counters.newCapabilities++;
        // Recorded when the row is made, not at the end of the step: a run that stops in between loses nothing.
        await recordCompetitorEvent(workspaceId, null, "cmp_capability_added", { capabilityId, name: verdict.name, domainId, competitorId, analysisId: ctx.run.id, value: proofs.get(item.id)?.strong ? "found" : "low" });
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
        const feature = await tx.feature.create({ data: { workspaceId, capabilityId: home, name: verdict.name, description: placement.description || item.description, ourStatus, origin: "ai", state: "active", position: next }, select: { id: true } });
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
    if (noDomain) ctx.log("warn", `${noDomain} new capabilit${noDomain === 1 ? "y was" : "ies were"} not added: your catalog has no domain — add one in Settings → Competitors`);
  }
  await ctx.flush();
}

/**
 * B. Cells: by fixed rules from the evidence (cells.ts): a company has a row when it has its own capability on it or
 * any feature under it; a feature row gets a mark per company. A PM's correction is never read or written here.
 * The organization's own source fills OUR column instead (applyOwnCells): it never has a competitor's cell.
 */
export async function applyCells(ctx: RunContext, lookWaiting: ReadonlySet<string> = new Set()): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  if (ctx.competitor.isOwn) {
    await applyOwnCells(ctx);
    return;
  }
  // The first analysis of a competitor sets the starting picture: values are replaced (POC cells included), nothing is "news".
  const baseline = (await db.competitorAnalysis.count({ where: { competitorId, appliedAt: { not: null } } })) === 0;
  const [{ capabilities, features }, evidence, storedCells, storedFeatureCells] = await Promise.all([
    tableRows(workspaceId),
    loadEvidence(workspaceId, competitorId, await planOf(ctx)),
    db.capabilityStatus.findMany({ where: { competitorId }, select: { id: true, capabilityId: true, value: true, quote: true, sourceUrl: true, reasoning: true, wording: true, description: true, evidenceCount: true, scanId: true } }),
    db.featureStatus.findMany({ where: { competitorId }, select: { id: true, featureId: true, value: true, quote: true, sourceUrl: true, reasoning: true, wording: true, description: true, evidenceCount: true } }),
  ]);
  const now = new Date();
  const shown = (cell: CellFromEvidence) => ({ quote: cell.best?.quote ?? null, sourceUrl: cell.best?.pageUrl ?? null, reasoning: cell.best?.reasoning || null, wording: cell.best?.wording ?? null, description: cell.description, evidenceCount: cell.count });
  const sameEvidence = (a: { quote: string | null; sourceUrl: string | null; reasoning: string | null; wording: string | null; description: string | null; evidenceCount: number }, b: ReturnType<typeof shown>) =>
    a.quote === b.quote && a.sourceUrl === b.sourceUrl && (a.reasoning || null) === b.reasoning && a.wording === b.wording && a.description === b.description && a.evidenceCount === b.evidenceCount;
  const count = (value: string) => {
    if (value === "found") ctx.counters.cellsFound++;
    else if (value === "low") ctx.counters.cellsLow++;
    else ctx.counters.cellsNotFound++;
  };
  const cellOf = new Map(storedCells.map((c) => [c.capabilityId, c]));
  for (const k of capabilities) {
    // Its second look was not finished (the token budget): nothing is known yet, so nothing is written — a new row
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
        // The one-sentence digest of the change: what they now offer, in the words of the item that proves it.
        db.capabilityStatus.update({ where: { id: stored.id }, data: { value: cell.value, ...data, analysisId: ctx.run.id, changedAt: now, summary: cell.description, imageUrl: null, scanId: ctx.run.scanId } }),
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

  // ——— C. A row made from this competitor's items gets its cell at the other competitors: a follow-up run each (no page is read again) ———
  // Which rows: read from the tables, not remembered — the rows made from this competitor's items since its last
  // finished run. So a run that crashed or failed after making a row (in this step, or later) still gets its
  // follow-up runs: from this run when it continues, or from the competitor's next run. Before the cells are marked
  // current, for the same reason.
  // Not in a setup run: it fills every company itself.
  if (!ctx.setup) await queueFollowUps(ctx);

  // ——— D. The cells are current as of now ———
  await ctx.markApplied(now);
  ctx.log("info", `Table filled${baseline ? " (first analysis of this competitor: the starting picture, nothing counts as a change)" : ""}: ${ctx.counters.cellsFound} found, ${ctx.counters.cellsLow} low confidence, ${ctx.counters.cellsNotFound} not found${ctx.counters.cellsChanged ? ` · ${ctx.counters.cellsChanged} changed` : ""}${ctx.counters.newCapabilities ? ` · ${ctx.counters.newCapabilities} new capabilit${ctx.counters.newCapabilities === 1 ? "y" : "ies"}` : ""}${ctx.counters.newFeatures ? ` · ${ctx.counters.newFeatures} new feature${ctx.counters.newFeatures === 1 ? "" : "s"}` : ""}${ctx.counters.secondLooksWaiting ? ` · ${ctx.counters.secondLooksWaiting} row${ctx.counters.secondLooksWaiting === 1 ? " waits" : "s wait"} for a second look (next run)` : ""}`);
  await ctx.flush();
}

/** C of the apply step — see the comment where it is called: the rows made from this company's items since its last finished run are looked for at the competitors. */
async function queueFollowUps(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const [lastDone, made] = await Promise.all([
    db.competitorAnalysis.findFirst({ where: { competitorId, status: "done", appliedAt: { not: null } }, orderBy: { appliedAt: "desc" }, select: { appliedAt: true } }),
    db.competitorItem.findMany({ where: { competitorId, kind: "capability", matchedBy: "created", capability: { is: { state: "active" } } }, select: { capability: { select: { id: true, createdAt: true } } } }),
  ]);
  const fresh = rowsSince(made.flatMap((m) => (m.capability ? [m.capability] : [])), lastDone?.appliedAt ?? null);
  if (!fresh.length) return;
  const others = await queueCatalogAnalyses(ctx.run.workspaceId, { exceptCompetitorId: competitorId });
  if (others) ctx.log("info", `${others} ${ctx.competitor.isOwn ? "" : "other "}competitor${others === 1 ? "" : "s"} queued: the new rows are looked for there too`);
}

// ————— The organization's own source: OUR column —————

/**
 * The cells step of the own source (own.ts). For every row of the table: what the own source's items say — evidence
 * of ours on a page that is read → found, none → not found, no confidence — is written to the row's own cell
 * (ourStatus) ONLY where no PM set it by hand; a PM's value is the truth and survives every run. The top evidence
 * is kept on the row (ourEvidence) either way: it is what the hover shows, and it never decides the value.
 * No competitor cell is ever written for the own source, and it gets no second look.
 */
async function applyOwnCells(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const [{ capabilities, features }, evidence] = await Promise.all([tableRows(workspaceId), loadEvidence(workspaceId, competitorId, await planOf(ctx))]);
  const [storedCapabilities, storedFeatures] = await Promise.all([
    db.capability.findMany({ where: { id: { in: capabilities.map((k) => k.id) } }, select: { id: true, ourStatus: true, ourStatusSetAt: true, ourEvidence: true } }),
    db.feature.findMany({ where: { id: { in: features.map((f) => f.id) } }, select: { id: true, ourStatus: true, ourStatusSetAt: true, ourEvidence: true } }),
  ]);
  let changed = 0;
  let kept = 0;
  const one = async (entity: "capability" | "feature", row: { id: string; name: string }, stored: { ourStatus: string; ourStatusSetAt: Date | null; ourEvidence: unknown } | undefined, list: Evidence[]) => {
    if (!stored) return;
    const cell = cellFromEvidence(list);
    const found = { best: cell.best ? { quote: cell.best.quote, pageUrl: cell.best.pageUrl, reasoning: cell.best.reasoning, wording: cell.best.wording } : null, count: cell.count, description: cell.description };
    const next = ownStatusAfterRun({ ourStatus: stored.ourStatus, setByPm: stored.ourStatusSetAt != null }, found);
    const ours = ownEvidenceOf(found);
    if (next.ourStatus === "found") ctx.counters.cellsFound++;
    else ctx.counters.cellsNotFound++;
    // A PM's value that differs from what the site says: kept, and counted so the log says so.
    if (stored.ourStatusSetAt != null && (cell.count > 0 ? "found" : "not_found") !== next.ourStatus) kept++;
    const sameEvidence = JSON.stringify(readOwnEvidence(stored.ourEvidence)) === JSON.stringify(ours);
    if (!next.changed && sameEvidence) return;
    const data = { ...(next.changed ? { ourStatus: next.ourStatus } : {}), ourEvidence: ours === null ? Prisma.DbNull : (ours as unknown as Prisma.InputJsonValue) };
    if (entity === "capability") await db.capability.update({ where: { id: row.id }, data });
    else await db.feature.update({ where: { id: row.id }, data });
    if (next.changed) {
      changed++;
      ctx.counters.cellsChanged++;
      await recordCompetitorEvent(workspaceId, null, "cmp_own_status_set", { entity, entityId: row.id, name: row.name, from: stored.ourStatus, to: next.ourStatus, analysisId: ctx.run.id, pages: cell.count });
    }
  };
  const capabilityOf = new Map(storedCapabilities.map((k) => [k.id, k]));
  for (const k of capabilities) await one("capability", k, capabilityOf.get(k.id), evidence.byCapability.get(k.id) ?? []);
  const featureOf = new Map(storedFeatures.map((f) => [f.id, f]));
  for (const f of features) await one("feature", f, featureOf.get(f.id), evidence.byFeature.get(f.id) ?? []);
  if (!ctx.setup) await queueFollowUps(ctx);
  await ctx.markApplied(new Date());
  ctx.log("info", `Our own column filled from ${ctx.competitor.name}'s own site: ${ctx.counters.cellsFound} found, ${ctx.counters.cellsNotFound} not found${changed ? ` · ${changed} changed` : ""}${kept ? ` · ${kept} set by a PM differ from the site and were kept` : ""}`);
  await ctx.flush();
}
