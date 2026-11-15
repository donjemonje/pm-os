import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../db";
import { recordCompetitorEvent } from "../analytics";
import { ownSourceOf } from "../own-site";
import { testAiAnswers } from "../settings";
import { DOMAINS_MAX_ROWS, DOMAINS_MAX_TOKENS, DOMAINS_SYSTEM_PROMPT, domainsTool, knownDomains, parseDomains, planCatalog, renderDomains, type DomainDraft } from "./domains";
import { AnalysisError, kickAnalyses, type RunContext, type SetupEnv } from "./engine";
import { factsStep } from "./facts";
import { EXCLUDED } from "./match";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { mapStep } from "./plan";
import { companiesInSetup, setupRefusal, setupStateOf, type SetupCompany, type SetupRefusal, type SetupState } from "./setup-rules";
import { applyCells, applyRows, matchStep, mergeStep, planResearch, researchStep, secondLookStep } from "./steps";
import {
  nextUnifyBatch,
  orderUnifyItems,
  parseUnify,
  parseUnifyReview,
  planUnifyReview,
  renderUnify,
  renderUnifyReview,
  rowsOf,
  UNIFY_MAX_TOKENS,
  UNIFY_REVIEW_MAX_ROWS,
  UNIFY_REVIEW_MAX_TOKENS,
  UNIFY_REVIEW_SYSTEM_PROMPT,
  UNIFY_SYSTEM_PROMPT,
  unifyEntries,
  unifyReviewTool,
  unifyTool,
  type UnifyItem,
  type UnifyRow,
} from "./unify";

/**
 * THE SETUP RUN — the first run of an organization (Capability Analysis, "The setup run"). The database side; the
 * rules are setup-rules.ts, unify.ts, domains.ts and own.ts.
 *
 * It runs for a workspace that has no domain and no capability, and it produces both — from the organization's own
 * site and its competitors' sites together. Started by hand (the scanner CLI `--setup <workspaceId>`), never by
 * itself. It is ONE row of CompetitorAnalysis (kind "setup", attached to the own source), so it takes its turn in
 * the analysis queue — one run at a time in the installation — and the engine's claim, heartbeat, waiting, stale
 * sweep and close are its own (analysis/engine.ts runAnalysis).
 *
 * The steps:
 *   1. map        — the own source and every competitor (analysis/plan.ts)
 *   2. research   — the broad read of each (steps.ts), under the token budget per company
 *   3. merge      — the clean list per company (steps.ts)
 *   4. unify      — all companies' capability items → rows (unify.ts): batches, then one review of all rows
 *   5. domains    — one step over all rows + the client's language → the domains and each row's domain (domains.ts);
 *                   the catalog is created here, in ONE transaction: domains, rows, each item's row
 *   6. match      — per company, the existing match → rows path: the features get their rows
 *   7. apply      — the own source fills OUR column; then per competitor: a second look for OUR capabilities that
 *                   have no evidence there (the parity question), the cells, and
 *   8. facts      — the profile facts (never for the own source)
 * No going back for gaps in a setup run.
 *
 * Resumable like an analysis run: every start walks the steps from the first and each computes its to-do from the
 * tables. The catalog exists or it does not (step 5 is one transaction): while it does not, steps 4–5 have work;
 * once it does, they are skipped. A company whose part is finished carries a record (a "done" CompetitorAnalysis
 * with parentId = the setup run) and is skipped. A setup run that failed is continued by the same command: the same
 * row goes back to the queue, with its counters — the token budget per company counts over the whole setup run.
 */

// ————— State and queue —————

export async function workspaceSetupState(workspaceId: string): Promise<SetupState> {
  const [domains, capabilities, last] = await Promise.all([
    db.competitorDomain.count({ where: { workspaceId } }),
    db.capability.count({ where: { workspaceId } }),
    db.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true } }),
  ]);
  return setupStateOf({ domains, capabilities, lastSetupStatus: last?.status ?? null });
}

/** The own source and every competitor of the workspace that was not removed, with their stored pages. */
async function loadCompanies(workspaceId: string): Promise<SetupCompany[]> {
  const rows = await db.competitor.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, name: true, host: true, websiteUrl: true, isOwn: true, position: true } });
  const out: SetupCompany[] = [];
  // Pages a scan stored — never the site's llms.txt, which the address search stores for the map step and nothing reads as a page.
  for (const c of rows) out.push({ ...c, pages: await db.sourcePage.count({ where: { source: { competitorId: c.id }, state: { not: "removed" }, text: { not: null }, discoveredVia: { not: "discovery" } } }) });
  return out;
}

export type QueueSetupResult =
  | { id: string; created: boolean; continued: boolean; companies: SetupCompany[]; skipped: SetupCompany[] }
  | { refused: SetupRefusal; message: string };

/**
 * Queue the setup run of a workspace — or continue the one that failed or was cancelled (the same row goes back to
 * the queue; nothing it wrote is redone). Refused, with a clear message and nothing written, when: a setup run of
 * the workspace is queued or in progress; the workspace is already set up; there is no own source; a scan of the
 * own source or of any competitor is still queued, running or pending; no competitor has stored pages
 * (setup-rules.ts setupRefusal).
 */
export async function queueSetup(workspaceId: string, opts: { startedById?: string | null } = {}): Promise<QueueSetupResult> {
  const [domains, capabilities, last, own, scans, all] = await Promise.all([
    db.competitorDomain.count({ where: { workspaceId } }),
    db.capability.count({ where: { workspaceId } }),
    db.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } }),
    ownSourceOf(workspaceId),
    db.competitorScan.findMany({
      where: { workspaceId, status: { in: ["queued", "pending_local", "running"] }, source: { competitor: { deletedAt: null } } },
      orderBy: { startedAt: "asc" },
      select: { status: true, source: { select: { competitor: { select: { name: true } } } } },
    }),
    loadCompanies(workspaceId),
  ]);
  const { work, skipped } = companiesInSetup(all);
  const refusal = setupRefusal({
    domains, capabilities, lastSetupStatus: last?.status ?? null, hasOwnSource: Boolean(own),
    activeScans: scans.map((s) => ({ company: s.source.competitor.name, status: s.status })),
    competitorsWithPages: work.filter((c) => !c.isOwn).length,
  });
  if (refusal) return { refused: refusal.reason, message: refusal.message };
  // TEST KNOB: a setup run whose own source has injected answers never calls a model (every company must have answers).
  const injected = Boolean(await testAiAnswers(own!.id));
  const result = await db.$transaction(async (tx) => {
    // Look-then-write under a lock per workspace: two requests in the same instant make one setup run.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-setup:${workspaceId}`}))`;
    const latest = await tx.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (latest && ["queued", "running", "waiting"].includes(latest.status)) return { id: latest.id, created: false, continued: false };
    if (latest && latest.status !== "done") {
      // Continue: the same run, from the tables. Its counters stay — the token budget per company counts over the whole run.
      const t = new Date();
      await tx.competitorAnalysis.update({
        where: { id: latest.id },
        data: { status: "queued", competitorId: own!.id, injected, errorKind: null, error: null, finishedAt: null, resumeAt: null, staleCount: 0, ownerToken: null, launchedAt: null, heartbeatAt: t },
      });
      return { id: latest.id, created: false, continued: true };
    }
    const run = await tx.competitorAnalysis.create({
      data: { workspaceId, competitorId: own!.id, kind: "setup", trigger: "setup", step: "map", startedById: opts.startedById ?? null, injected },
      select: { id: true },
    });
    return { id: run.id, created: true, continued: false };
  });
  if (result.created || result.continued) {
    await recordCompetitorEvent(workspaceId, opts.startedById ?? null, "cmp_setup_queued", { analysisId: result.id, continued: result.continued, companies: work.length, skipped: skipped.length, injected });
  }
  await kickAnalyses();
  return { ...result, companies: work, skipped };
}

// ————— The walk —————

/** What a capability item carries while it waits for the catalog: its row, identified by the row's name. */
function setupPlacement(row: { name: string; description: string }): Prisma.InputJsonValue {
  return { setupRow: true, marketName: row.name, description: row.description, domainId: null, newDomainName: "", newDomainDefinition: "", closestDomainId: null };
}

function readSetupPlacement(raw: unknown): { name: string; description: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.setupRow !== true || typeof r.marketName !== "string" || !r.marketName.trim()) return null;
  return { name: r.marketName, description: typeof r.description === "string" ? r.description : "" };
}

const CHUNK = 1000;
/** Tokens of instructions and schema a unify or a domains call carries besides its list. */
const SETUP_CALL_OVERHEAD_TOKENS = 1_200;

interface LoadedItem extends UnifyItem {
  /** It has a saved answer: a row, or the decision that it is no capability. */
  placed: boolean;
}

/** Every capability item of the companies, in the fixed order, with what it does (the description of its first page by address that gives one). */
async function loadUnifyItems(companies: SetupCompany[]): Promise<LoadedItem[]> {
  const ids = companies.map((c) => c.id);
  const companyOf = new Map(companies.map((c) => [c.id, c]));
  const [items, findings] = await Promise.all([
    db.competitorItem.findMany({ where: { competitorId: { in: ids }, kind: "capability" }, select: { id: true, competitorId: true, name: true, placement: true, matchedBy: true, matchedAt: true } }),
    db.pageFinding.findMany({ where: { competitorId: { in: ids }, origin: "research", kind: "capability", itemId: { not: null }, description: { not: null } }, select: { itemId: true, description: true, page: { select: { url: true } } } }),
  ]);
  findings.sort((a, b) => (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : 0));
  const descriptionOf = new Map<string, string>();
  for (const f of findings) if (f.description?.trim() && !descriptionOf.has(f.itemId!)) descriptionOf.set(f.itemId!, f.description.trim());
  const loaded: LoadedItem[] = items.map((i) => ({
    id: i.id, competitorId: i.competitorId, company: companyOf.get(i.competitorId)?.name ?? "", isOwn: companyOf.get(i.competitorId)?.isOwn ?? false,
    name: i.name, description: descriptionOf.get(i.id) ?? null, row: readSetupPlacement(i.placement), placed: i.matchedAt != null,
  }));
  return orderUnifyItems(loaded, ids);
}

async function orgNameOf(workspaceId: string): Promise<string> {
  return (await db.workspace.findUnique({ where: { id: workspaceId }, select: { organization: { select: { name: true } } } }))?.organization.name ?? "";
}

/** Save what a call decided for a list of items, grouped by row: one write per row. */
async function saveRows(tx: Prisma.TransactionClient, runId: string, at: Date, byRow: Map<string, { row: { name: string; description: string } | null; itemIds: string[] }>): Promise<void> {
  for (const { row, itemIds } of byRow.values()) {
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      await tx.competitorItem.updateMany({
        where: { id: { in: itemIds.slice(i, i + CHUNK) } },
        data: row
          ? { capabilityId: null, featureId: null, placement: setupPlacement(row), matchedBy: "ai", matchedAt: at, matchAnalysisId: runId }
          : { capabilityId: null, featureId: null, placement: Prisma.DbNull, matchedBy: EXCLUDED, matchedAt: at, matchAnalysisId: runId },
      });
    }
  }
}

/**
 * 4. Unify. Before the first call: matches saved by runs from before the setup (a match call's placement of an item
 * in a catalog that never existed) are forgotten, so every capability item goes through the unify step and every
 * feature through the setup's match. Then the batches, in the fixed order, each against the rows made so far; then
 * ONE review of all rows (merge / drop / rename), remembered in the run's cursor so a run that continues does not
 * review twice.
 */
async function unifyStep(env: SetupEnv, companies: SetupCompany[]): Promise<void> {
  const ctx = env.shared;
  const { workspaceId, id: runId } = env.run;
  const ids = companies.map((c) => c.id);
  const orgName = await orgNameOf(workspaceId);

  const stale = await db.competitorItem.findMany({ where: { competitorId: { in: ids }, matchedAt: { not: null }, matchedBy: { not: EXCLUDED } }, select: { id: true, kind: true, placement: true } });
  const forget = stale.filter((i) => i.kind === "feature" || !readSetupPlacement(i.placement)).map((i) => i.id);
  for (let i = 0; i < forget.length; i += CHUNK) {
    await db.competitorItem.updateMany({ where: { id: { in: forget.slice(i, i + CHUNK) } }, data: { capabilityId: null, featureId: null, placement: Prisma.DbNull, matchedBy: null, matchedAt: null, matchAnalysisId: null } });
  }
  if (forget.length) env.log("info", `Unify: ${forget.length} match${forget.length === 1 ? "" : "es"} saved by runs from before the setup forgotten — every item is placed by the setup run`);

  let first = true;
  for (;;) {
    const items = await loadUnifyItems(companies);
    const rows = rowsOf(items);
    const todo = items.filter((i) => !i.placed);
    if (first) {
      env.log("info", todo.length ? `Unify: ${items.length} capabilit${items.length === 1 ? "y" : "ies"} of ${companies.length} compan${companies.length === 1 ? "y" : "ies"} — ${todo.length} to place${rows.length ? `, ${rows.length} row${rows.length === 1 ? "" : "s"} made so far` : ""}` : `Unify: every capability has its row (${rows.length} row${rows.length === 1 ? "" : "s"}) — PMOS AI not called`);
      first = false;
    }
    if (!todo.length) break;
    const batch = nextUnifyBatch(todo);
    const entries = unifyEntries(batch);
    let settled = 0;
    await ctx.paced({
      items: [renderUnify(orgName, rows, entries)],
      concurrency: 1,
      estimate: (t) => estimateTokens(t.length) + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
      work: async (t) => {
        // TEST KNOB: the answer of the n-th unify call of the run. None given while items need a row → the run fails: a test states what it expects.
        let injected: string | undefined;
        if (ctx.answers) {
          injected = ctx.answers.unify?.[ctx.counters.unifyCalls];
          if (injected === undefined) throw new AnalysisError("other", `no injected unify answer for unify call ${ctx.counters.unifyCalls + 1} (test knob)`);
        }
        const r = await ctx.call<Record<string, unknown>>(UNIFY_SYSTEM_PROMPT, "", t, unifyTool(entries.map((e) => e.code), rows.map((x) => x.code)), { role: "match", maxTokens: UNIFY_MAX_TOKENS, thinking: "medium", injected });
        ctx.counters.unifyCalls++;
        const parsed = parseUnify(r.value, entries, rows);
        // Closed sets: a code outside them makes the answer unusable — nothing of it is saved.
        if (parsed.problems.length) throw new AnalysisError("answer", `PMOS AI's unify answer is unusable: ${parsed.problems.slice(0, 3).join("; ")}${parsed.problems.length > 3 ? ` (+${parsed.problems.length - 3} more)` : ""}`);
        const byRow = new Map<string, { row: { name: string; description: string } | null; itemIds: string[] }>();
        for (const a of parsed.assignments) {
          const key = a.row ? `row:${a.row.name}` : "none";
          const group = byRow.get(key) ?? { row: a.row, itemIds: [] };
          group.itemIds.push(a.itemId);
          byRow.set(key, group);
        }
        const at = new Date();
        await db.$transaction((tx) => saveRows(tx, runId, at, byRow), { timeout: 120_000, maxWait: 30_000 });
        const excluded = byRow.get("none")?.itemIds.length ?? 0;
        ctx.counters.itemsExcluded += excluded;
        for (const a of parsed.assignments) if (!a.row) ctx.log("info", `Unify: "${batch.find((b) => b.id === a.itemId)?.name ?? ""}" (${batch.find((b) => b.id === a.itemId)?.company ?? ""}) is not a capability — no row`);
        settled = parsed.assignments.length;
        return r.tokens;
      },
    });
    // No loop that could spin: a call that places nothing fails the run. Entries the answer left out go into the next call.
    if (settled === 0) throw new AnalysisError("answer", `PMOS AI placed none of the ${batch.length} entries of a unify call`);
    await ctx.flush();
  }

  // The review: all rows together, once.
  const cursor = ctx.run.cursor.unify && typeof ctx.run.cursor.unify === "object" ? (ctx.run.cursor.unify as Record<string, unknown>) : {};
  if (cursor.reviewed !== true) {
    const rows = rowsOf(await loadUnifyItems(companies));
    if (rows.length >= 2) {
      const parts = Math.ceil(rows.length / UNIFY_REVIEW_MAX_ROWS);
      if (parts > 1) {
        env.log("warn", `Unify review split in ${parts} calls (${rows.length} rows): the same capability in two calls can stay two rows`);
        ctx.cap("unify_review_split", { limit: UNIFY_REVIEW_MAX_ROWS, undone: parts });
      }
      let merged = 0;
      let dropped = 0;
      let renamed = 0;
      for (let p = 0; p < parts; p++) {
        // The rows are read again for every call: the call before may have merged or renamed some.
        const now = p === 0 ? rows : rowsOf(await loadUnifyItems(companies));
        const chunk = now.slice(p * UNIFY_REVIEW_MAX_ROWS, (p + 1) * UNIFY_REVIEW_MAX_ROWS);
        if (chunk.length < 2) continue;
        await ctx.paced({
          items: [renderUnifyReview(orgName, chunk)],
          concurrency: 1,
          estimate: (t) => estimateTokens(t.length) + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
          work: async (t) => {
            // TEST KNOB: every review call gets this answer; none given = nothing to merge, drop or rename.
            const injected = ctx.answers ? ctx.answers.unifyReview ?? '{"merge": [], "drop": [], "rename": []}' : undefined;
            const r = await ctx.call<Record<string, unknown>>(UNIFY_REVIEW_SYSTEM_PROMPT, "", t, unifyReviewTool(chunk.map((x) => x.code)), { role: "judge", maxTokens: UNIFY_REVIEW_MAX_TOKENS, thinking: "high", injected });
            ctx.counters.unifyCalls++;
            const parsed = parseUnifyReview(r.value, chunk);
            if (parsed.problems.length) throw new AnalysisError("answer", `PMOS AI's unify review is unusable: ${parsed.problems.slice(0, 3).join("; ")}${parsed.problems.length > 3 ? ` (+${parsed.problems.length - 3} more)` : ""}`);
            const plan = planUnifyReview(parsed, chunk);
            const byKey = new Map(chunk.map((x) => [x.key, x]));
            const byRow = new Map<string, { row: { name: string; description: string } | null; itemIds: string[] }>();
            for (const [key, after] of plan) {
              const before = byKey.get(key)!;
              byRow.set(key, { row: after, itemIds: before.members.map((m) => m.id) });
              if (!after) {
                dropped++;
                ctx.counters.itemsExcluded += before.members.length;
                ctx.log("info", `Unify review: "${before.name}" is not a capability — the row is dropped`);
              } else if (after.description !== before.description || chunk.some((x) => x.key !== key && x.name === after.name)) {
                merged++;
                ctx.log("info", `Unify review: "${before.name}" is the same capability as "${after.name}" — one row`);
              } else {
                renamed++;
                ctx.log("info", `Unify review: "${before.name}" is called "${after.name}"`);
              }
            }
            const at = new Date();
            await db.$transaction((tx) => saveRows(tx, runId, at, byRow), { timeout: 300_000, maxWait: 30_000 });
            return r.tokens;
          },
        });
      }
      env.log("info", `Unify review: ${merged} row${merged === 1 ? "" : "s"} merged into another, ${dropped} dropped, ${renamed} renamed`);
    }
    await ctx.saveCursor({ unify: { reviewed: true } });
  }
  const rows = rowsOf(await loadUnifyItems(companies));
  env.progress.rows = rows.length;
  env.log("info", `Unify: ${rows.length} row${rows.length === 1 ? "" : "s"} — ${rows.filter((r) => r.members.some((m) => m.isOwn)).length} the organization has, ${rows.filter((r) => new Set(r.members.map((m) => m.competitorId)).size > 1).length} at more than one company`);
  await ctx.flush();
}

/**
 * 5. Build the domains: one call over all rows (consecutive calls only above DOMAINS_MAX_ROWS rows, or for rows an
 * answer left out — each given the domains made so far), then the catalog in ONE transaction: the domains and the
 * rows as ordinary active catalog rows (origin "ai"), in their stable order, and every item's row as its saved
 * match (matchedBy "ai"). Nothing is a suggestion; nothing waits for approval.
 */
async function domainsStep(env: SetupEnv, companies: SetupCompany[]): Promise<void> {
  const ctx = env.shared;
  const { workspaceId, id: runId } = env.run;
  const rows = rowsOf(await loadUnifyItems(companies));
  if (!rows.length) throw new AnalysisError("other", "no capability was found on any site — there is nothing to build a table from");
  const [orgName, productLines] = await Promise.all([
    orgNameOf(workspaceId),
    db.productLine.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true, description: true } }),
  ]);
  const drafts: DomainDraft[] = [];
  const assigned = new Map<string, string>();
  let left: UnifyRow[] = rows;
  env.log("info", `Domains: ${rows.length} row${rows.length === 1 ? "" : "s"}, ${productLines.length} product line${productLines.length === 1 ? "" : "s"} of the organization`);
  // More rows than one call takes: the step is no longer ONE step over all rows — a cap, recorded like any other.
  if (rows.length > DOMAINS_MAX_ROWS) ctx.cap("domains_split", { limit: DOMAINS_MAX_ROWS, undone: Math.ceil(rows.length / DOMAINS_MAX_ROWS) });
  while (left.length) {
    const batch = left.slice(0, DOMAINS_MAX_ROWS);
    const known = knownDomains(drafts);
    let settled = 0;
    await ctx.paced({
      items: [renderDomains(orgName, productLines, known, batch)],
      concurrency: 1,
      estimate: (t) => estimateTokens(t.length) + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
      work: async (t) => {
        // TEST KNOB: the answer of the n-th domains call of the run. None given while rows need a domain → the run fails.
        let injected: string | undefined;
        if (ctx.answers) {
          injected = ctx.answers.domains?.[ctx.counters.domainsCalls];
          if (injected === undefined) throw new AnalysisError("other", `no injected domains answer for domains call ${ctx.counters.domainsCalls + 1} (test knob)`);
        }
        const r = await ctx.call<Record<string, unknown>>(DOMAINS_SYSTEM_PROMPT, "", t, domainsTool(batch.map((x) => x.code)), { role: "judge", maxTokens: DOMAINS_MAX_TOKENS, thinking: "high", injected });
        ctx.counters.domainsCalls++;
        const parsed = parseDomains(r.value, batch, known);
        if (parsed.problems.length) throw new AnalysisError("answer", `PMOS AI's domains answer is unusable: ${parsed.problems.slice(0, 3).join("; ")}${parsed.problems.length > 3 ? ` (+${parsed.problems.length - 3} more)` : ""}`);
        drafts.push(...parsed.created);
        for (const [rowKey, domainKey] of parsed.assigned) assigned.set(rowKey, domainKey);
        settled = parsed.assigned.size;
        if (parsed.missing.length) ctx.log("warn", `Domains: the answer left ${parsed.missing.length} row${parsed.missing.length === 1 ? "" : "s"} without a domain — asked again`);
        return r.tokens;
      },
    });
    // No loop that could spin: a call that places nothing fails the run.
    if (settled === 0) throw new AnalysisError("answer", `PMOS AI gave none of the ${batch.length} rows of a domains call a domain`);
    left = rows.filter((r) => !assigned.has(r.key));
  }

  const catalog = planCatalog(rows, assigned, drafts);
  const at = new Date();
  const created = catalog.map((d) => ({ ...d, id: randomUUID(), rows: d.rows.map((r) => ({ ...r, id: randomUUID() })) }));
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-setup:${workspaceId}`}))`;
      // The setup run builds the FIRST catalog: were a domain or a capability added by hand meanwhile, nothing is created.
      const [domains, capabilities] = await Promise.all([tx.competitorDomain.count({ where: { workspaceId } }), tx.capability.count({ where: { workspaceId } })]);
      if (domains + capabilities > 0) throw new AnalysisError("other", "a domain or a capability was added to this organization while the setup run was working — the setup run builds the first catalog only, and created nothing");
      await tx.competitorDomain.createMany({ data: created.map((d) => ({ id: d.id, workspaceId, name: d.name, description: d.definition, position: d.position, origin: "ai", state: "active" })) });
      await tx.capability.createMany({
        data: created.flatMap((d) => d.rows.map((r) => ({ id: r.id, workspaceId, domainId: d.id, name: r.row.name, description: r.row.description, ourStatus: r.ours ? "found" : "not_found", origin: "ai", state: "active", position: r.position }))),
      });
      for (const d of created) {
        for (const r of d.rows) {
          const itemIds = r.row.members.map((m) => m.id);
          for (let i = 0; i < itemIds.length; i += CHUNK) {
            await tx.competitorItem.updateMany({ where: { id: { in: itemIds.slice(i, i + CHUNK) } }, data: { capabilityId: r.id, featureId: null, placement: Prisma.DbNull, matchedBy: "ai", matchedAt: at, matchAnalysisId: runId } });
          }
        }
      }
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
  env.progress.rows = rows.length;
  env.progress.domains = created.length;
  for (const d of created) env.log("info", `Domain: ${d.name} — ${d.rows.length} row${d.rows.length === 1 ? "" : "s"}${d.definition ? ` · ${d.definition}` : ""}`);
  env.log("info", `Catalog created: ${created.length} domain${created.length === 1 ? "" : "s"}, ${rows.length} row${rows.length === 1 ? "" : "s"} — ordinary active rows; the team edits them with the usual controls`);
  await recordCompetitorEvent(workspaceId, env.run.startedById, "cmp_setup_catalog_created", { analysisId: runId, rows: rows.length, domains: created.length, ours: rows.filter((r) => r.members.some((m) => m.isOwn)).length, excluded: ctx.counters.itemsExcluded });
  await ctx.flush();
}

export async function setupWalk(env: SetupEnv): Promise<void> {
  const { workspaceId, id: runId } = env.run;
  const { work, skipped } = companiesInSetup(await loadCompanies(workspaceId));
  const own = work.find((c) => c.isOwn);
  if (!own || own.id !== env.run.ownCompetitorId) throw new AnalysisError("other", "the organization's own site is gone — the setup run needs it");
  const competitors = work.filter((c) => !c.isOwn);
  if (!competitors.length) throw new AnalysisError("other", "no competitor of this organization has stored pages — the setup run needs at least one");
  // A company whose part is finished carries a record of this run: it is not worked on again — and it gets no
  // context: a context starts a company's walk, which forgets what was true at the end of its last one (its caps).
  const finished = new Set((await db.competitorAnalysis.findMany({ where: { parentId: runId }, select: { competitorId: true } })).map((r) => r.competitorId));
  const contexts = new Map<string, RunContext>();
  for (const c of work) if (!finished.has(c.id)) contexts.set(c.id, await env.company(c));
  const ctxOf = (c: SetupCompany) => contexts.get(c.id)!;
  for (const c of work) env.setStage(c.id, finished.has(c.id) ? "done" : "waiting");

  env.log("info", `Setup run ${env.run.resumed ? "continued" : "started"} — ${own.name}'s own site (${own.pages} page${own.pages === 1 ? "" : "s"}) and ${competitors.length} competitor${competitors.length === 1 ? "" : "s"}: ${competitors.map((c) => `${c.name} (${c.pages})`).join(", ")}${env.run.injected ? " — PMOS AI answers injected (test knob), no model is called" : ` — ${env.model}`}`);
  if (skipped.length) env.log("warn", `Not part of this setup run — no stored page yet: ${skipped.map((c) => c.name).join(", ")}. Their first scan queues an ordinary analysis`);
  await recordCompetitorEvent(workspaceId, env.run.startedById, "cmp_setup_started", { analysisId: runId, companies: work.length, competitors: competitors.length, skipped: skipped.length, pages: work.reduce((n, c) => n + c.pages, 0), resumed: env.run.resumed, model: env.model, injected: env.run.injected });
  await env.flush();

  const todo = work.filter((c) => !finished.has(c.id));
  // 1–3. Per company, exactly as in an analysis run: the reading plan, the broad read, the clean list.
  await env.inStep("map", async () => {
    for (const c of todo) {
      env.setStage(c.id, "map");
      await mapStep(ctxOf(c));
    }
  });
  await env.inStep("research", async () => {
    for (const c of todo) {
      env.setStage(c.id, "research");
      const ctx = ctxOf(c);
      await researchStep(ctx, await planResearch(ctx));
      if (ctx.reading.reached) ctx.log("warn", `The token budget per company was reached (${ctx.reading.limit.toLocaleString("en-US")}): ${ctx.counters.pagesUnread} page${ctx.counters.pagesUnread === 1 ? "" : "s"} left unread. The table is built from what was read`);
    }
  });
  await env.inStep("merge", async () => {
    for (const c of todo) {
      env.setStage(c.id, "merge");
      await mergeStep(ctxOf(c));
    }
  });

  // 4–5. Only while the catalog does not exist: the domains step creates it in one transaction.
  const [domains, capabilities] = await Promise.all([db.competitorDomain.count({ where: { workspaceId } }), db.capability.count({ where: { workspaceId } })]);
  if (domains + capabilities === 0) {
    for (const c of todo) env.setStage(c.id, "unify");
    await env.inStep("unify", () => unifyStep(env, work));
    await env.inStep("domains", () => domainsStep(env, work));
  } else {
    env.log("info", `The catalog exists (${domains} domain${domains === 1 ? "" : "s"}, ${capabilities} capabilit${capabilities === 1 ? "y" : "ies"}): unify and domains are not repeated — the run continues with filling the table`);
  }

  // 6. Rows for what is left of every company's list — its features — through the existing match → rows path, one
  // company after another in the fixed order, so each sees the feature rows the companies before it made.
  await env.inStep("match", async () => {
    for (const c of todo) {
      env.setStage(c.id, "match");
      const ctx = ctxOf(c);
      await matchStep(ctx);
      await applyRows(ctx);
    }
  });

  // 7. OUR column first (the own source): it decides which rows are ours.
  if (!finished.has(own.id)) {
    env.setStage(own.id, "apply");
    await env.inStep("apply", () => applyCells(ctxOf(own)));
    await recordCompany(env, own, ctxOf(own));
  }
  // The parity question: a second look only for OUR capabilities that have no evidence at a competitor. A row only
  // competitors have is not double-checked at the other competitors in a setup run.
  const ours = new Set((await db.capability.findMany({ where: { workspaceId, state: "active", ourStatus: "found" }, select: { id: true } })).map((k) => k.id));
  for (const c of competitors) {
    if (finished.has(c.id)) continue;
    const ctx = ctxOf(c);
    env.setStage(c.id, "second_look");
    const waiting = await env.inStep("second_look", () => secondLookStep(ctx, { only: ours }));
    env.setStage(c.id, "apply");
    await env.inStep("apply", () => applyCells(ctx, waiting));
    // 8. The profile facts — never for the own source.
    env.setStage(c.id, "facts");
    await env.inStep("facts", () => factsStep(ctx));
    await recordCompany(env, c, ctx);
  }

  const [rowCount, domainCount, featureCount] = await Promise.all([
    db.capability.count({ where: { workspaceId, state: "active" } }),
    db.competitorDomain.count({ where: { workspaceId, state: "active" } }),
    db.feature.count({ where: { workspaceId, state: "active" } }),
  ]);
  env.progress.rows = rowCount;
  env.progress.domains = domainCount;
  env.progress.features = featureCount;
  env.log("info", `The organization is set up: ${domainCount} domain${domainCount === 1 ? "" : "s"}, ${rowCount} capabilit${rowCount === 1 ? "y" : "ies"}, ${featureCount} feature${featureCount === 1 ? "" : "s"}, ${work.length} compan${work.length === 1 ? "y" : "ies"}. From now on a scan of a competitor or of the own site queues an ordinary analysis`);
  await env.flush();
}

/**
 * A company's part of the setup run is finished: it gets a record — a "done" analysis run of its own (trigger
 * "setup", parentId = the setup run) with its counters and the moment its cells were filled. From then on the
 * company is like one that was analysed before: its next run is an ordinary one (changes are news, not a first
 * picture), and it is skipped when this setup run continues. Made once per company.
 */
async function recordCompany(env: SetupEnv, c: SetupCompany, ctx: RunContext): Promise<void> {
  const entry = env.progress.companies.find((x) => x.competitorId === c.id);
  const at = new Date();
  const exists = await db.competitorAnalysis.findFirst({ where: { parentId: env.run.id, competitorId: c.id }, select: { id: true } });
  if (!exists) {
    await db.competitorAnalysis.create({
      data: {
        workspaceId: env.run.workspaceId, competitorId: c.id, kind: "analysis", trigger: "setup", parentId: env.run.id, startedById: env.run.startedById,
        status: "done", step: "done", model: env.model, startedAt: env.run.startedAt, appliedAt: entry?.appliedAt ? new Date(entry.appliedAt) : at, finishedAt: at, heartbeatAt: at,
        pagesTotal: entry?.pagesTotal ?? 0, pagesDone: entry?.pagesDone ?? 0, counters: ctx.counters as unknown as Prisma.InputJsonValue, usage: (entry?.usage ?? []) as unknown as Prisma.InputJsonValue, caps: env.capsOf(c.id) as unknown as Prisma.InputJsonValue, errorKind: "none",
        log: [{ at: at.toISOString(), level: "info", msg: `Filled by the setup run ${env.run.id} — its log holds this company's lines` }] as unknown as Prisma.InputJsonValue,
      },
    });
  }
  env.setStage(c.id, "done");
  await env.flush();
}
