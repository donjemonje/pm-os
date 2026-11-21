import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../db";
import { recordCompetitorEvent } from "../analytics";
import { ownSourceOf } from "../own-site";
import { testAiAnswers } from "../settings";
import { DOMAINS_MAX_ROWS, DOMAINS_MAX_TOKENS, DOMAINS_SYSTEM_PROMPT, domainsTool, knownDomains, parseDomains, planCatalog, renderDomains, rowsWithoutDomain, type DomainDraft, type DomainsRow } from "./domains";
import { AnalysisError, kickAnalyses, type RunContext, type SetupEnv } from "./engine";
import { wordingKey } from "./items";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { mapStep } from "./plan";
import { readingStep } from "./read-step";
import { readsLine } from "./reads";
import { companiesInSetup, isOrgSetupState, nextSetupState, orgSetupState, setupRefusal, type OrgSetupState, type SetupCompany, type SetupEvent, type SetupFacts, type SetupRefusal } from "./setup-rules";
import { applyCells, secondLookStep } from "./steps";
import {
  capabilityBatches,
  capabilityCode,
  checkUnified,
  featureBatches,
  featureCode,
  featureRowsOf,
  parseUnifyCapabilities,
  parseUnifyFeatures,
  parseUnifyReview,
  planUnifyReview,
  renderUnifyCapabilities,
  renderUnifyFeatures,
  renderUnifyReview,
  rowKey,
  rowsOf,
  UNIFY_CAPABILITIES_PROMPT,
  UNIFY_CAPABILITY_BATCH,
  UNIFY_FEATURE_BATCH,
  UNIFY_FEATURES_PROMPT,
  UNIFY_MAX_TOKENS,
  UNIFY_MOVED_FEATURES_PROMPT,
  UNIFY_REVIEW_MAX_TOKENS,
  UNIFY_REVIEW_PROMPT,
  unifyCapabilitiesTool,
  unifyFeaturesTool,
  unifyReviewTool,
  type RowRef,
  type UnifyCapability,
  type UnifyFeature,
  type UnifyFeatureGroup,
  type UnifyRow,
} from "./unify";

/**
 * THE SETUP RUN — the first run of an organization (Capability Analysis, "The setup run"). The database side; the
 * rules are setup-rules.ts, unify.ts, domains.ts and own.ts.
 *
 * It runs for an organization whose setup is not done (setup-rules.ts: required → in setup → done) and produces
 * its domains, capabilities and features — from the organization's own site and its competitors' sites together.
 * Queueing it moves the organization to "in setup"; finishing it, to "done". Started by hand (the scanner CLI
 * `--setup <workspaceId>`), never by itself. It is ONE row of CompetitorAnalysis (kind "setup", attached to the own
 * source), so it takes its turn in the analysis queue — one run at a time in the installation — and the engine's
 * claim, heartbeat, waiting, stale sweep and close are its own (analysis/engine.ts runAnalysis).
 *
 * The steps:
 *   1. map        — the own source and every competitor (analysis/plan.ts)
 *   2. reading    — each company in a few chunks of related pages → its list: capabilities and the features under
 *                   each, each once, with a description, a quote and its page (analysis/read-step.ts)
 *   3. unify      — all companies' lists → the rows of the table and the feature rows under each (unify.ts):
 *                   capabilities in batches against the rows so far, one review when that took more than one call,
 *                   then the features per batch of rows. Every capability and every feature ends on exactly one row.
 *   4. domains    — one step over all rows + the client's language → the domains and each row's domain (domains.ts);
 *                   the catalog is created here, in ONE transaction: domains, rows, feature rows, each item's row
 *   5. fill       — the own source fills OUR column; then per competitor: a second look in bulk for OUR rows it
 *                   has no item for (the parity question), and the cells.
 * (No profile-facts step any more: the run is about the table.)
 *
 * Resumable like an analysis run: every start walks the steps from the first and each computes its to-do from the
 * tables. The catalog exists or it does not (step 4 is one transaction): while it does not, steps 3–4 have work;
 * once it does, they are skipped. A company whose part is finished carries a record (a "done" CompetitorAnalysis
 * with parentId = the setup run) and is skipped. A setup run that failed is continued by the same command: the same
 * row goes back to the queue, with its counters — the token budget per company counts over the whole setup run.
 * `--setup <workspaceId> --fresh` starts over instead: a new run, and what the earlier ones read is forgotten.
 */

// ————— State and queue —————

/** What the state is read from: the organization's stored state and what its data says (setup-rules.ts orgSetupState). */
export interface WorkspaceSetup {
  organizationId: string;
  state: OrgSetupState;
  /** The stored state; null = never set — `state` was read from the data. */
  stored: OrgSetupState | null;
  facts: SetupFacts;
}

export async function workspaceSetup(workspaceId: string): Promise<WorkspaceSetup | null> {
  const [workspace, domains, capabilities, last] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, include: { organization: true } }),
    db.competitorDomain.count({ where: { workspaceId } }),
    db.capability.count({ where: { workspaceId } }),
    db.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true } }),
  ]);
  if (!workspace) return null;
  const facts: SetupFacts = { domains, capabilities, lastSetupStatus: last?.status ?? null };
  const stored = isOrgSetupState(workspace.organization.competitorsSetup) ? workspace.organization.competitorsSetup : null;
  return { organizationId: workspace.organizationId, state: orgSetupState(stored, facts), stored, facts };
}

/** The setup state of a workspace's organization. A workspace that does not exist is not set up. */
export async function workspaceSetupState(workspaceId: string): Promise<OrgSetupState> {
  return (await workspaceSetup(workspaceId))?.state ?? "required";
}

/**
 * Something moved the state (setup-rules.ts nextSetupState): the organization's state is written — explicit from
 * now on, whatever it was read from before. Returns the state after the event.
 */
export async function moveSetupState(workspaceId: string, event: SetupEvent): Promise<OrgSetupState | null> {
  const setup = await workspaceSetup(workspaceId);
  if (!setup) return null;
  const next = nextSetupState(setup.state, event);
  if (setup.stored !== next) await db.organization.update({ where: { id: setup.organizationId }, data: { competitorsSetup: next } });
  return next;
}

/** A PM-OS admin sets the state by hand (Administration → Competitors → Setup runs). Returns the state it had. */
export async function setSetupState(workspaceId: string, state: OrgSetupState): Promise<OrgSetupState | null> {
  const setup = await workspaceSetup(workspaceId);
  if (!setup) return null;
  await db.organization.update({ where: { id: setup.organizationId }, data: { competitorsSetup: state } });
  return setup.state;
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
  | { id: string; created: boolean; continued: boolean; companies: SetupCompany[]; skipped: SetupCompany[]; forgotten?: Forgotten }
  | { refused: SetupRefusal; message: string };

/**
 * Queue the setup run of a workspace — or continue the one that failed or was cancelled (the same row goes back to
 * the queue; nothing it wrote is redone). Refused, with a clear message and nothing written, when: a setup run of
 * the workspace is queued or in progress; the organization's setup is done; there is no own source; a scan of the
 * own source or of any competitor is still queued, running or pending; no competitor has stored pages
 * (setup-rules.ts setupRefusal).
 */
export async function queueSetup(workspaceId: string, opts: { startedById?: string | null; /** Start over: a new run instead of continuing the one that stopped (startFresh). */ fresh?: boolean } = {}): Promise<QueueSetupResult> {
  const [setup, own, scans, all] = await Promise.all([
    workspaceSetup(workspaceId),
    ownSourceOf(workspaceId),
    db.competitorScan.findMany({
      where: { workspaceId, status: { in: ["queued", "pending_local", "running"] }, source: { competitor: { deletedAt: null } } },
      orderBy: { startedAt: "asc" },
      select: { status: true, source: { select: { competitor: { select: { name: true } } } } },
    }),
    loadCompanies(workspaceId),
  ]);
  const { work, skipped } = companiesInSetup(all);
  if (!setup) return { refused: "no_own_source", message: `no workspace with the id ${workspaceId}` };
  const refusal = setupRefusal({
    ...setup.facts, state: setup.state, hasOwnSource: Boolean(own),
    activeScans: scans.map((s) => ({ company: s.source.competitor.name, status: s.status })),
    competitorsWithPages: work.filter((c) => !c.isOwn).length,
  });
  if (refusal) return { refused: refusal.reason, message: refusal.message };
  let forgotten: Forgotten | null = null;
  if (opts.fresh) {
    // Starting over builds the first catalog again from nothing: refused when a catalog exists (a run that got that far is continued, not restarted).
    if (setup.facts.domains + setup.facts.capabilities > 0) return { refused: "set_up", message: `this organization has a catalog already (${setup.facts.domains} domain${setup.facts.domains === 1 ? "" : "s"}, ${setup.facts.capabilities} capabilit${setup.facts.capabilities === 1 ? "y" : "ies"}): --fresh starts the setup over from nothing and is refused — continue the run with --setup ${workspaceId}` };
    forgotten = await forgetReading(all.map((c) => c.id));
  }
  // TEST KNOB: a setup run whose own source has injected answers never calls a model (every company must have answers).
  const injected = Boolean(await testAiAnswers(own!.id));
  const result = await db.$transaction(async (tx) => {
    // Look-then-write under a lock per workspace: two requests in the same instant make one setup run.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-setup:${workspaceId}`}))`;
    const latest = await tx.competitorAnalysis.findFirst({ where: { workspaceId, kind: "setup" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (latest && ["queued", "running", "waiting"].includes(latest.status)) return { id: latest.id, created: false, continued: false };
    if (latest && latest.status !== "done" && !opts.fresh) {
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
    // required → in setup. It stays there until the run has finished, however often it is continued.
    await moveSetupState(workspaceId, "run_queued");
    await recordCompetitorEvent(workspaceId, opts.startedById ?? null, "cmp_setup_queued", { analysisId: result.id, continued: result.continued, companies: work.length, skipped: skipped.length, injected });
  }
  await kickAnalyses();
  return { ...result, companies: work, skipped, ...(forgotten ? { forgotten } : {}) };
}

/** What `--fresh` forgot. */
export interface Forgotten {
  /** Section labels PMOS AI gave (the map asks again), findings, items, records of reading requests, pages whose "read" mark was cleared. */
  labels: number;
  findings: number;
  items: number;
  chunks: number;
  pages: number;
}

/**
 * Starting a setup over: everything earlier runs READ of these companies is forgotten, so the new run maps and reads
 * them from nothing with the models and prompts of today — the section labels PMOS AI gave (labels set in code
 * stay) and its word on which pages are release notes, every finding, every item, the records of the reading
 * requests, and the "read" mark on every page. Stored
 * pages, scans, sources and profile facts are not touched. Only ever called for an organization that has no catalog.
 */
async function forgetReading(competitorIds: string[]): Promise<Forgotten> {
  const where = { competitorId: { in: competitorIds } };
  const [findings, features, capabilities, chunks, labels, pages] = await db.$transaction([
    db.pageFinding.deleteMany({ where }),
    db.competitorItem.deleteMany({ where: { ...where, kind: "feature" } }),
    db.competitorItem.deleteMany({ where }),
    db.competitorChunk.deleteMany({ where }),
    db.competitorSection.deleteMany({ where: { ...where, labeledBy: "ai" } }),
    db.sourcePage.updateMany({ where: { source: where, OR: [{ analyzedKey: { not: null } }, { readAs: { not: null } }] }, data: { analyzedKey: null, analyzedAt: null, analysisError: null, readAs: null } }),
  ]);
  return { labels: labels.count, findings: findings.count, items: features.count + capabilities.count, chunks: chunks.count, pages: pages.count };
}

// ————— The walk —————

const CHUNK = 1000;
/** Tokens of instructions and schema a unify or a domains call carries besides its list. */
const SETUP_CALL_OVERHEAD_TOKENS = 1_500;

/** What an item carries while it waits for the catalog (CompetitorItem.placement): a capability's row, a feature's feature row, or the row a feature was moved to. */
const rowPlacement = (row: RowRef): Prisma.InputJsonValue => ({ setupRow: true, marketName: row.name, description: row.description });
const featurePlacement = (row: RowRef, feature: RowRef): Prisma.InputJsonValue => ({ setupFeature: true, row: row.name, marketName: feature.name, description: feature.description });
const movePlacement = (row: RowRef): Prisma.InputJsonValue => ({ setupMove: true, row: row.name });

function readPlacement(raw: unknown): { kind: "row" | "feature" | "move"; row: string; name: string; description: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (r.setupRow === true && text(r.marketName).trim()) return { kind: "row", row: text(r.marketName), name: text(r.marketName), description: text(r.description) };
  if (r.setupFeature === true && text(r.row).trim() && text(r.marketName).trim()) return { kind: "feature", row: text(r.row), name: text(r.marketName), description: text(r.description) };
  if (r.setupMove === true && text(r.row).trim()) return { kind: "move", row: text(r.row), name: "", description: "" };
  return null;
}

interface Unified {
  capabilities: UnifyCapability[];
  features: UnifyFeature[];
}

/**
 * Every company's list as the unify step sees it, in the fixed order: the companies in theirs (the organization
 * first), a company's capabilities in its list's order, the features under each in theirs — each with its code
 * ("A3", "A3.2") and the place it was given so far.
 */
async function loadUnified(companies: SetupCompany[]): Promise<Unified> {
  const ids = companies.map((c) => c.id);
  const items = await db.competitorItem.findMany({
    where: { competitorId: { in: ids } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, competitorId: true, kind: true, name: true, description: true, parentItemId: true, placement: true },
  });
  const capabilities: UnifyCapability[] = [];
  const features: UnifyFeature[] = [];
  companies.forEach((company, n) => {
    const own = items.filter((i) => i.competitorId === company.id);
    own.filter((i) => i.kind === "capability").forEach((k, i) => {
      const code = capabilityCode(n, i);
      const children = own.filter((f) => f.kind === "feature" && f.parentItemId === k.id);
      const placed = readPlacement(k.placement);
      capabilities.push({ id: k.id, competitorId: company.id, company: company.name, isOwn: company.isOwn, code, name: k.name, description: k.description ?? "", features: children.map((f) => f.name), row: placed?.kind === "row" ? { name: placed.name, description: placed.description } : null });
      children.forEach((f, j) => {
        const at = readPlacement(f.placement);
        features.push({
          id: f.id, competitorId: company.id, company: company.name, isOwn: company.isOwn, code: featureCode(code, j), name: f.name, description: f.description ?? "", capabilityItemId: k.id,
          placed: at?.kind === "feature" ? { row: at.row, name: at.name, description: at.description } : null,
          movedTo: at?.kind === "move" ? at.row : null,
        });
      });
    });
  });
  return { capabilities, features };
}

async function orgNameOf(workspaceId: string): Promise<string> {
  return (await db.workspace.findUnique({ where: { id: workspaceId }, select: { organization: { select: { name: true } } } }))?.organization.name ?? "";
}

/** Save one place for a list of items: one write per place. `placed` = it is the item's final place (a row, a feature row); a move is not. */
async function savePlaces(tx: Prisma.TransactionClient, runId: string, at: Date, places: Array<{ itemIds: string[]; placement: Prisma.InputJsonValue; placed: boolean }>): Promise<void> {
  for (const p of places) {
    for (let i = 0; i < p.itemIds.length; i += CHUNK) {
      await tx.competitorItem.updateMany({
        where: { id: { in: p.itemIds.slice(i, i + CHUNK) } },
        data: { capabilityId: null, featureId: null, placement: p.placement, matchedBy: p.placed ? "ai" : null, matchedAt: p.placed ? at : null, matchAnalysisId: runId },
      });
    }
  }
}

const unusable = (what: string, problems: string[]) => new AnalysisError("answer", `PMOS AI's ${what} answer is unusable: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);

/**
 * 3. Unify (unify.ts): A — the capabilities in batches against the rows so far; B — one review of all rows when A
 * took more than one call; C — the features per batch of rows, then the features a call moved to another row.
 * Every answer is saved in one transaction on the items it placed, so a run that stopped continues with the calls
 * that are left — the same calls: the batches are cut over all items, placed or not.
 */
async function unifyStep(env: SetupEnv, companies: SetupCompany[]): Promise<void> {
  const ctx = env.shared;
  const { workspaceId, id: runId } = env.run;
  const ids = companies.map((c) => c.id);
  const orgName = await orgNameOf(workspaceId);

  // Places saved by anything but this setup (a match of a run from before it) are forgotten: every item is placed here.
  const stale = await db.competitorItem.findMany({ where: { competitorId: { in: ids }, OR: [{ matchedAt: { not: null } }, { placement: { not: Prisma.DbNull } }, { capabilityId: { not: null } }, { featureId: { not: null } }] }, select: { id: true, placement: true } });
  const forget = stale.filter((i) => !readPlacement(i.placement)).map((i) => i.id);
  for (let i = 0; i < forget.length; i += CHUNK) {
    await db.competitorItem.updateMany({ where: { id: { in: forget.slice(i, i + CHUNK) } }, data: { capabilityId: null, featureId: null, placement: Prisma.DbNull, matchedBy: null, matchedAt: null, matchAnalysisId: null } });
  }
  if (forget.length) env.log("info", `Unify: ${forget.length} place${forget.length === 1 ? "" : "s"} saved by runs from before the setup forgotten — every item is placed by the setup run`);

  // ——— A. Capabilities → rows ———
  let unified = await loadUnified(companies);
  const batches = capabilityBatches(unified.capabilities);
  env.log("info", `Unify: ${unified.capabilities.length} capabilit${unified.capabilities.length === 1 ? "y" : "ies"} and ${unified.features.length} feature${unified.features.length === 1 ? "" : "s"} of ${companies.length} compan${companies.length === 1 ? "y" : "ies"} — capabilities in ${batches.length} call${batches.length === 1 ? "" : "s"}${unified.capabilities.every((c) => c.row) ? " (every capability has its row already)" : ""}`);
  // More capabilities than one call takes: the same capability in two calls can become two rows — a cap, recorded; the review below is the guard.
  if (batches.length > 1) ctx.cap("unify_split", { limit: UNIFY_CAPABILITY_BATCH, undone: batches.length });
  for (const batch of batches) {
    const batchIds = new Set(batch.map((c) => c.id));
    for (;;) {
      const todo = unified.capabilities.filter((c) => batchIds.has(c.id) && !c.row);
      if (!todo.length) break;
      const rows = rowsOf(unified.capabilities);
      let settled = 0;
      await ctx.paced({
        items: [renderUnifyCapabilities(orgName, rows, todo)],
        concurrency: 1,
        estimate: (t) => estimateTokens(t.length) + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
        work: async (t) => {
          // TEST KNOB: the answer of the n-th unify call about capabilities. None given while one needs a row → the run fails: a test states what it expects.
          let injected: string | undefined;
          if (ctx.answers) {
            injected = ctx.answers.unify?.[ctx.counters.unifyCalls];
            if (injected === undefined) throw new AnalysisError("other", `no injected unify answer for unify call ${ctx.counters.unifyCalls + 1} (test knob)`);
          }
          const r = await ctx.call<Record<string, unknown>>(UNIFY_CAPABILITIES_PROMPT, "", t, unifyCapabilitiesTool(todo.map((c) => c.code), rows.map((x) => x.code)), { role: "judge", maxTokens: UNIFY_MAX_TOKENS, injected });
          ctx.counters.unifyCalls++;
          const parsed = parseUnifyCapabilities(r.value, todo, rows);
          // Closed sets: a code outside them makes the answer unusable — nothing of it is saved.
          if (parsed.problems.length) throw unusable("unify", parsed.problems);
          if (parsed.twice.length) ctx.log("warn", `Unify: ${parsed.twice.length} capabilit${parsed.twice.length === 1 ? "y was" : "ies were"} put on two rows (${parsed.twice.slice(0, 5).join(", ")}) — the first row stays`);
          if (parsed.missing.length) ctx.log("warn", `Unify: the answer left out ${parsed.missing.length} capabilit${parsed.missing.length === 1 ? "y" : "ies"} (${parsed.missing.slice(0, 5).join(", ")}) — asked again`);
          const byRow = new Map<string, { itemIds: string[]; placement: Prisma.InputJsonValue; placed: boolean }>();
          for (const a of parsed.assignments) {
            const key = rowKey(a.row.name);
            const group = byRow.get(key) ?? { itemIds: [], placement: rowPlacement(a.row), placed: true };
            group.itemIds.push(a.itemId);
            byRow.set(key, group);
          }
          const at = new Date();
          await db.$transaction((tx) => savePlaces(tx, runId, at, [...byRow.values()]), { timeout: 120_000, maxWait: 30_000 });
          settled = parsed.assignments.length;
          ctx.log("info", `Unify, capabilities: ${todo.length} asked · ${Math.round(r.ms / 1000)} s · ${settled} placed on ${byRow.size} row${byRow.size === 1 ? "" : "s"}`);
          return r.tokens;
        },
      });
      // No loop that could spin: a call that places nothing fails the run.
      if (settled === 0) throw new AnalysisError("answer", `PMOS AI placed none of the ${todo.length} capabilities of a unify call`);
      unified = await loadUnified(companies);
      await ctx.flush();
    }
  }

  // ——— B. The review: only when the rows were made in more than one call — all rows together, once ———
  const cursor = ctx.run.cursor.unify && typeof ctx.run.cursor.unify === "object" ? (ctx.run.cursor.unify as Record<string, unknown>) : {};
  if (batches.length > 1 && cursor.reviewed !== true) {
    const rows = rowsOf(unified.capabilities);
    if (rows.length >= 2) {
      await ctx.paced({
        items: [renderUnifyReview(orgName, rows)],
        concurrency: 1,
        estimate: (t) => estimateTokens(t.length) + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
        work: async (t) => {
          // TEST KNOB: the review's answer; none given = nothing to merge.
          const injected = ctx.answers ? ctx.answers.unifyReview ?? '{"merge": []}' : undefined;
          const r = await ctx.call<Record<string, unknown>>(UNIFY_REVIEW_PROMPT, "", t, unifyReviewTool(rows.map((x) => x.code)), { role: "judge", maxTokens: UNIFY_REVIEW_MAX_TOKENS, injected });
          const parsed = parseUnifyReview(r.value, rows);
          if (parsed.problems.length) throw unusable("unify review", parsed.problems);
          const plan = planUnifyReview(parsed.merges, rows);
          const byKey = new Map(rows.map((x) => [x.key, x]));
          const places: Array<{ itemIds: string[]; placement: Prisma.InputJsonValue; placed: boolean }> = [];
          for (const [key, after] of plan) {
            const before = byKey.get(key)!;
            places.push({ itemIds: before.members.map((m) => m.id), placement: rowPlacement(after), placed: true });
            ctx.log("info", rowKey(after.name) === key ? `Unify review: "${before.name}" is called "${after.name}"` : `Unify review: "${before.name}" is the same capability as "${after.name}" — one row`);
          }
          const at = new Date();
          await db.$transaction((tx) => savePlaces(tx, runId, at, places), { timeout: 300_000, maxWait: 30_000 });
          ctx.log("info", `Unify review: ${rows.length} rows · ${Math.round(r.ms / 1000)} s · ${parsed.merges.length} group${parsed.merges.length === 1 ? "" : "s"} of rows merged`);
          return r.tokens;
        },
      });
    }
    await ctx.saveCursor({ unify: { reviewed: true } });
    unified = await loadUnified(companies);
  }

  // ——— C. Features → feature rows: first each feature with the row of its own capability, then the features a call moved ———
  const rows = rowsOf(unified.capabilities);
  const rowOfCapability = new Map(rows.flatMap((r) => r.members.map((m) => [m.id, r] as const)));
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  /** The row a feature is asked with: the one it was moved to, else its own capability's. */
  const homeOf = (f: UnifyFeature): UnifyRow | undefined => (f.movedTo ? rowByKey.get(rowKey(f.movedTo)) : rowOfCapability.get(f.capabilityItemId));
  for (const round of [1, 2] as const) {
    const moved = round === 2;
    const todoNow = unified.features.filter((f) => !f.placed && (moved ? f.movedTo != null : f.movedTo == null));
    if (!todoNow.length) continue;
    // The cuts are made over every feature of the round, placed or not, so a run that continues makes the same calls.
    // Round 1: every feature, with the row of its own capability. Round 2: the features that left that row — moved
    // and waiting, or already placed elsewhere — with the row they went to (round 1 is over, so the set is final).
    const perRow = new Map<string, number>();
    for (const f of unified.features) {
      const own = rowOfCapability.get(f.capabilityItemId);
      const went = f.movedTo ? rowByKey.get(rowKey(f.movedTo)) : f.placed ? rowByKey.get(rowKey(f.placed.row)) : undefined;
      const home = moved ? (went && went.key !== own?.key ? went : undefined) : own;
      if (home) perRow.set(home.key, (perRow.get(home.key) ?? 0) + 1);
    }
    const jobs = featureBatches(rows.map((r) => ({ key: r.key, features: perRow.get(r.key) ?? 0 }))).filter((keys) => todoNow.some((f) => keys.includes(homeOf(f)?.key ?? "")));
    env.log("info", `Unify, ${moved ? "features moved to another row" : "features"}: ${todoNow.length} to place in ${jobs.length} call${jobs.length === 1 ? "" : "s"} or more (${UNIFY_FEATURE_BATCH} features per call)`);
    await ctx.paced({
      items: jobs,
      // The calls of a round do not depend on each other: they go at the run's own speed. A run with injected answers makes them one at a time, in table order.
      concurrency: ctx.answers ? 1 : "self",
      estimate: (keys) => keys.reduce((n, k) => n + (perRow.get(k) ?? 0), 0) * 60 + rows.length * 40 + SETUP_CALL_OVERHEAD_TOKENS + OUTPUT_RESERVE,
      work: async (keys) => {
        let tokens = 0;
        for (;;) {
          const now = await loadUnified(companies);
          const open = now.features.filter((f) => !f.placed && (moved ? f.movedTo != null : f.movedTo == null) && keys.includes(homeOf(f)?.key ?? ""));
          if (!open.length) break;
          // A row with more features than one call takes is asked in consecutive parts; each part sees the feature rows the parts before it made.
          const part = open.slice(0, UNIFY_FEATURE_BATCH);
          const groups: UnifyFeatureGroup[] = keys
            .map((k) => rowByKey.get(k)!)
            .map((row) => ({ row, featureRows: featureRowsOf(row, now.features), entries: part.filter((f) => homeOf(f)?.key === row.key) }))
            .filter((g) => g.entries.length > 0);
          const batchRows = groups.map((g) => g.row.code);
          // TEST KNOB: the answer of the n-th unify call about features. None given while a feature needs a row → the run fails.
          let injected: string | undefined;
          if (ctx.answers) {
            injected = ctx.answers.unifyFeatures?.[ctx.counters.unifyFeatureCalls];
            if (injected === undefined) throw new AnalysisError("other", `no injected unifyFeatures answer for call ${ctx.counters.unifyFeatureCalls + 1} (test knob)`);
          }
          const r = await ctx.call<Record<string, unknown>>(
            moved ? UNIFY_MOVED_FEATURES_PROMPT : UNIFY_FEATURES_PROMPT,
            "",
            renderUnifyFeatures(orgName, rows, groups, { allRowsShown: !moved }),
            unifyFeaturesTool(part.map((f) => f.code), batchRows, rows.map((x) => x.code).filter((c) => !batchRows.includes(c)), !moved),
            { role: "judge", maxTokens: UNIFY_MAX_TOKENS, injected },
          );
          ctx.counters.unifyFeatureCalls++;
          tokens += r.tokens;
          const parsed = parseUnifyFeatures(r.value, groups, rows, !moved);
          if (parsed.problems.length) throw unusable("unify (features)", parsed.problems);
          if (parsed.twice.length) ctx.log("warn", `Unify: ${parsed.twice.length} feature${parsed.twice.length === 1 ? " was" : "s were"} used twice (${parsed.twice.slice(0, 5).join(", ")}) — the first place stays`);
          if (parsed.missing.length) ctx.log("warn", `Unify: the answer left out ${parsed.missing.length} feature${parsed.missing.length === 1 ? "" : "s"} (${parsed.missing.slice(0, 5).join(", ")}) — asked again`);
          const places = new Map<string, { itemIds: string[]; placement: Prisma.InputJsonValue; placed: boolean }>();
          for (const p of parsed.placements) {
            const key = `f|${p.rowKey}|${wordingKey(p.feature.name)}`;
            const group = places.get(key) ?? { itemIds: [], placement: featurePlacement(p.row, p.feature), placed: true };
            group.itemIds.push(p.itemId);
            places.set(key, group);
          }
          for (const m of parsed.moves) {
            const key = `m|${rowKey(m.row.name)}`;
            const group = places.get(key) ?? { itemIds: [], placement: movePlacement(m.row), placed: false };
            group.itemIds.push(m.itemId);
            places.set(key, group);
          }
          const at = new Date();
          await db.$transaction((tx) => savePlaces(tx, runId, at, [...places.values()]), { timeout: 120_000, maxWait: 30_000 });
          for (const m of parsed.moves) {
            const f = part.find((x) => x.id === m.itemId);
            if (f) ctx.log("info", `Unify: ${f.company}'s feature "${f.name}" belongs to the row "${m.row.name}", not to the row of the capability it was listed under`);
          }
          ctx.log("info", `Unify, features of ${groups.length} row${groups.length === 1 ? "" : "s"} (${groups.map((g) => g.row.code).join(", ")}): ${part.length} asked · ${Math.round(r.ms / 1000)} s · ${parsed.placements.length} placed${parsed.moves.length ? `, ${parsed.moves.length} moved to another row` : ""}`);
          // No loop that could spin: a call that settles nothing fails the run.
          if (parsed.placements.length + parsed.moves.length === 0) throw new AnalysisError("answer", `PMOS AI placed none of the ${part.length} features of a unify call`);
        }
        return tokens;
      },
    });
    unified = await loadUnified(companies);
    await ctx.flush();
  }

  // ——— D. Exactly once: every capability on one row, every feature on one feature row of a row that exists ———
  const check = checkUnified(unified.capabilities, unified.features);
  const wrong = check.capabilitiesUnplaced.length + check.featuresUnplaced.length + check.featuresOnNoRow.length;
  if (wrong) throw new AnalysisError("other", `the unify step ended with ${check.capabilitiesUnplaced.length} capabilities and ${check.featuresUnplaced.length} features on no row, and ${check.featuresOnNoRow.length} features on a row that does not exist — the table is not built from an incomplete list`);
  const finalRows = rowsOf(unified.capabilities);
  const featureRowCount = finalRows.reduce((n, r) => n + featureRowsOf(r, unified.features).length, 0);
  env.progress.rows = finalRows.length;
  env.progress.features = featureRowCount;
  env.log("info", `Unify: ${finalRows.length} row${finalRows.length === 1 ? "" : "s"} and ${featureRowCount} feature row${featureRowCount === 1 ? "" : "s"} — every capability and every feature is on exactly one. ${finalRows.filter((r) => r.members.some((m) => m.isOwn)).length} rows the organization has, ${finalRows.filter((r) => new Set(r.members.map((m) => m.competitorId)).size > 1).length} at more than one company`);
  await ctx.flush();
}

/** The rows as the domains step and the catalog need them: who has each (its own capability on it, or any feature under it), what the organization calls it, and its feature rows. */
function tableRowsOf(unified: Unified): Array<DomainsRow & { row: UnifyRow; featureRows: Array<{ name: string; description: string; itemIds: string[]; ours: boolean }> }> {
  return rowsOf(unified.capabilities).map((row) => {
    const under = unified.features.filter((f) => f.placed && rowKey(f.placed.row) === row.key);
    const featureRows = featureRowsOf(row, unified.features).map((fr) => {
      const members = under.filter((f) => wordingKey(f.placed!.name) === fr.key);
      return { name: fr.name, description: fr.description, itemIds: members.map((m) => m.id), ours: members.some((m) => m.isOwn) };
    });
    const companies: Array<{ name: string; isOwn: boolean }> = [];
    for (const m of [...row.members, ...under]) if (!companies.some((c) => c.name === m.company)) companies.push({ name: m.company, isOwn: m.isOwn });
    return {
      code: row.code, key: row.key, name: row.name, description: row.description, companies, ownNames: row.members.filter((m) => m.isOwn).map((m) => m.name), features: featureRows.map((f) => f.name),
      ours: companies.some((c) => c.isOwn), row, featureRows,
    };
  });
}

/**
 * 4. Build the domains: one call over all rows (consecutive calls only above DOMAINS_MAX_ROWS rows, or for rows an
 * answer left out — each given the domains made so far), then the catalog in ONE transaction: the domains, the
 * rows and the feature rows as ordinary active catalog rows (origin "ai"), in their stable order, and every item's
 * row as its saved match (matchedBy "ai"). Nothing is a suggestion; nothing waits for approval.
 */
async function domainsStep(env: SetupEnv, companies: SetupCompany[]): Promise<void> {
  const ctx = env.shared;
  const { workspaceId, id: runId } = env.run;
  const rows = tableRowsOf(await loadUnified(companies));
  if (!rows.length) throw new AnalysisError("other", "no capability was found on any site — there is nothing to build a table from");
  const [orgName, productLines] = await Promise.all([
    orgNameOf(workspaceId),
    db.productLine.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true, description: true } }),
  ]);
  const drafts: DomainDraft[] = [];
  const assigned = new Map<string, string>();
  let left = rows;
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
        const r = await ctx.call<Record<string, unknown>>(DOMAINS_SYSTEM_PROMPT, "", t, domainsTool(batch.map((x) => x.code)), { role: "judge", maxTokens: DOMAINS_MAX_TOKENS, injected });
        ctx.counters.domainsCalls++;
        const parsed = parseDomains(r.value, batch, known);
        if (parsed.problems.length) throw unusable("domains", parsed.problems);
        drafts.push(...parsed.created);
        for (const [key, domainKey] of parsed.assigned) assigned.set(key, domainKey);
        settled = parsed.assigned.size;
        if (parsed.missing.length) ctx.log("warn", `Domains: the answer left ${parsed.missing.length} row${parsed.missing.length === 1 ? "" : "s"} without a domain — asked again`);
        return r.tokens;
      },
    });
    // No loop that could spin: a call that places nothing fails the run.
    if (settled === 0) throw new AnalysisError("answer", `PMOS AI gave none of the ${batch.length} rows of a domains call a domain`);
    left = rows.filter((r) => !assigned.has(r.key));
  }
  // Every row in exactly one domain: checked before anything is created.
  const without = rowsWithoutDomain(rows, assigned);
  if (without.length) throw new AnalysisError("other", `${without.length} row${without.length === 1 ? " has" : "s have"} no domain — the catalog is not created with a row left out`);

  const catalog = planCatalog(rows, assigned, drafts);
  const at = new Date();
  const created = catalog.map((d) => ({ ...d, id: randomUUID(), rows: d.rows.map((r) => ({ ...r, id: randomUUID(), features: r.row.featureRows.map((f, n) => ({ ...f, id: randomUUID(), position: n })) })) }));
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-setup:${workspaceId}`}))`;
      // The setup run builds the FIRST catalog: were a domain or a capability added by hand meanwhile, nothing is created.
      const [domains, capabilities] = await Promise.all([tx.competitorDomain.count({ where: { workspaceId } }), tx.capability.count({ where: { workspaceId } })]);
      if (domains + capabilities > 0) throw new AnalysisError("other", "a domain or a capability was added to this organization while the setup run was working — the setup run builds the first catalog only, and created nothing");
      await tx.competitorDomain.createMany({ data: created.map((d) => ({ id: d.id, workspaceId, name: d.name, description: d.definition, position: d.position, origin: "ai", state: "active" })) });
      await tx.capability.createMany({
        data: created.flatMap((d) => d.rows.map((r) => ({ id: r.id, workspaceId, domainId: d.id, name: r.row.name, description: r.row.description, ourStatus: r.row.ours ? "found" : "not_found", origin: "ai", state: "active", position: r.position }))),
      });
      const features = created.flatMap((d) => d.rows.flatMap((r) => r.features.map((f) => ({ id: f.id, workspaceId, capabilityId: r.id, name: f.name, description: f.description, ourStatus: f.ours ? "found" : "not_found", origin: "ai", state: "active", position: f.position }))));
      for (let i = 0; i < features.length; i += CHUNK) await tx.feature.createMany({ data: features.slice(i, i + CHUNK) });
      const place = async (itemIds: string[], data: { capabilityId: string | null; featureId: string | null }) => {
        for (let i = 0; i < itemIds.length; i += CHUNK) {
          await tx.competitorItem.updateMany({ where: { id: { in: itemIds.slice(i, i + CHUNK) } }, data: { ...data, placement: Prisma.DbNull, matchedBy: "ai", matchedAt: at, matchAnalysisId: runId } });
        }
      };
      for (const d of created) {
        for (const r of d.rows) {
          await place(r.row.row.members.map((m) => m.id), { capabilityId: r.id, featureId: null });
          for (const f of r.features) await place(f.itemIds, { capabilityId: null, featureId: f.id });
        }
      }
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  const featureCount = created.reduce((n, d) => n + d.rows.reduce((m, r) => m + r.features.length, 0), 0);
  env.progress.rows = rows.length;
  env.progress.domains = created.length;
  env.progress.features = featureCount;
  for (const d of created) env.log("info", `Domain: ${d.name} — ${d.rows.length} row${d.rows.length === 1 ? "" : "s"}${d.definition ? ` · ${d.definition}` : ""}`);
  env.log("info", `Catalog created: ${created.length} domain${created.length === 1 ? "" : "s"}, ${rows.length} row${rows.length === 1 ? "" : "s"}, ${featureCount} feature row${featureCount === 1 ? "" : "s"} — ordinary active rows; the team edits them with the usual controls`);
  await recordCompetitorEvent(workspaceId, env.run.startedById, "cmp_setup_catalog_created", { analysisId: runId, rows: rows.length, domains: created.length, features: featureCount, ours: rows.filter((r) => r.ours).length });
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

  env.log("info", `Setup run ${env.run.resumed ? "continued" : "started"} — ${own.name}'s own site (${own.pages} page${own.pages === 1 ? "" : "s"}) and ${competitors.length} competitor${competitors.length === 1 ? "" : "s"}: ${competitors.map((c) => `${c.name} (${c.pages})`).join(", ")}${env.run.injected ? " — PMOS AI answers injected (test knob), no model is called" : ` — ${env.model} — thinking: ${env.thinking}`}`);
  env.log("info", `${readsLine(env.reads)} (Administration → Competitors → What the analysis reads)`);
  if (skipped.length) env.log("warn", `Not part of this setup run — no stored page yet: ${skipped.map((c) => c.name).join(", ")}. Their first scan queues an ordinary analysis`);
  await recordCompetitorEvent(workspaceId, env.run.startedById, "cmp_setup_started", { analysisId: runId, companies: work.length, competitors: competitors.length, skipped: skipped.length, pages: work.reduce((n, c) => n + c.pages, 0), resumed: env.run.resumed, model: env.model, injected: env.run.injected });
  await env.flush();

  const todo = work.filter((c) => !finished.has(c.id));
  // 1–2. Per company, exactly as in an analysis run: the reading plan, then the reading in chunks.
  await env.inStep("map", async () => {
    for (const c of todo) {
      env.setStage(c.id, "map");
      await mapStep(ctxOf(c));
    }
  });
  await env.inStep("reading", async () => {
    for (const c of todo) {
      env.setStage(c.id, "reading");
      await readingStep(ctxOf(c));
    }
  });

  // 3–4. Only while the catalog does not exist: the domains step creates it in one transaction.
  const [domains, capabilities] = await Promise.all([db.competitorDomain.count({ where: { workspaceId } }), db.capability.count({ where: { workspaceId } })]);
  if (domains + capabilities === 0) {
    for (const c of todo) env.setStage(c.id, "unify");
    await env.inStep("unify", () => unifyStep(env, work));
    await env.inStep("domains", () => domainsStep(env, work));
  } else {
    env.log("info", `The catalog exists (${domains} domain${domains === 1 ? "" : "s"}, ${capabilities} capabilit${capabilities === 1 ? "y" : "ies"}): unify and domains are not repeated — the run continues with filling the table`);
  }

  // 5. OUR column first (the own source): it decides which rows are ours.
  if (!finished.has(own.id)) {
    env.setStage(own.id, "apply");
    await env.inStep("apply", () => applyCells(ctxOf(own)));
    await recordCompany(env, own, ctxOf(own));
  }
  // The parity question: a second look, in bulk, only for OUR rows a competitor has no item for.
  for (const c of competitors) {
    if (finished.has(c.id)) continue;
    const ctx = ctxOf(c);
    env.setStage(c.id, "second_look");
    const waiting = await env.inStep("second_look", () => secondLookStep(ctx));
    env.setStage(c.id, "apply");
    await env.inStep("apply", () => applyCells(ctx, waiting));
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
  // in setup → done: from now on analyses fill the table and the pages show it.
  await moveSetupState(workspaceId, "run_done");
  env.log("info", `The organization is set up: ${domainCount} domain${domainCount === 1 ? "" : "s"}, ${rowCount} capabilit${rowCount === 1 ? "y" : "ies"}, ${featureCount} feature${featureCount === 1 ? "" : "s"}, ${work.length} compan${work.length === 1 ? "y" : "ies"}. From now on a scan of a competitor or of the own site queues an ordinary analysis. The table as text: --table ${workspaceId}`);
  await env.flush();
}

/**
 * A company's part of the setup run is finished: it gets a record — a "done" analysis run of its own (trigger
 * "setup", parentId = the setup run) with its counters, its caps, its incidents and the moment its cells were
 * filled. From then on the company is like one that was analysed before: its next run is an ordinary one (changes
 * are news, not a first picture), and it is skipped when this setup run continues. Made once per company.
 */
async function recordCompany(env: SetupEnv, c: SetupCompany, ctx: RunContext): Promise<void> {
  const entry = env.progress.companies.find((x) => x.competitorId === c.id);
  const at = new Date();
  const exists = await db.competitorAnalysis.findFirst({ where: { parentId: env.run.id, competitorId: c.id }, select: { id: true } });
  if (!exists) {
    const cases = env.incidentsOf(c.id);
    await db.competitorAnalysis.create({
      data: {
        workspaceId: env.run.workspaceId, competitorId: c.id, kind: "analysis", trigger: "setup", parentId: env.run.id, startedById: env.run.startedById,
        status: "done", step: "done", model: env.model, startedAt: env.run.startedAt, appliedAt: entry?.appliedAt ? new Date(entry.appliedAt) : at, finishedAt: at, heartbeatAt: at,
        pagesTotal: entry?.pagesTotal ?? 0, pagesDone: entry?.pagesDone ?? 0, counters: ctx.counters as unknown as Prisma.InputJsonValue, usage: (entry?.usage ?? []) as unknown as Prisma.InputJsonValue, caps: env.capsOf(c.id) as unknown as Prisma.InputJsonValue,
        ...(cases.total ? { incidents: cases as unknown as Prisma.InputJsonValue } : {}), errorKind: "none",
        log: [{ at: at.toISOString(), level: "info", msg: `Filled by the setup run ${env.run.id} — its log holds this company's lines` }] as unknown as Prisma.InputJsonValue,
      },
    });
  }
  env.setStage(c.id, "done");
  await env.flush();
}
