import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { PrefixWarmer } from "./ai-cache";
import { nextChipColor } from "./colors";
import { buildCustomerResolver, customerKey } from "./customer-key";
import { CATALOG_PREFIX_KEY, catalogTickets, prepareCatalog } from "./catalog";
import { getJiraConnectionStatus } from "../jira";
import { type CsvMapping } from "./csv-mapping";
import { mergeIdeasJiraConfig } from "./jira-mapping";
import { fetchJiraLiveSources } from "./jira-sync";
import { MATCH_GROUP_PREFIX_KEY, matchTickets, prepareMatch } from "./match";
import { parseCustomerCells, type ParsedCell } from "./field-parse";
import {
  SPLIT_PREFIX_KEY,
  splitTickets,
  prepareSplit,
  type SplitRequest,
} from "./split";
import { ImportTrace, markAbandonedImports } from "./trace";
import type {
  CatalogKind,
  Idea,
  JiraSource,
  MatchNote,
  ZendeskTicket,
} from "./types";

/**
 * Postgres-backed state for the Ideas feature. The DB rows are shaped back
 * into the client types the UI already uses: ticket refs are Zendesk external
 * ids, Jira refs are issue keys, idea ids are DB uuids.
 */

export interface IdeasState {
  tickets: ZendeskTicket[];
  jiraSources: JiraSource[];
  ideas: Idea[];
  /** Customer catalog names — the client tells confirmed from suggested with this. */
  customerCatalog: string[];
  /** Jira integration is set up for the workspace — gates Jira Merge. */
  jiraConnected: boolean;
  /** The org's CSV import mapping — the client parses uploads with it. */
  csvMapping: CsvMapping;
}

/** A parsed CSV row plus the original record verbatim (the raw store). */
export interface ImportTicketInput {
  key: string;
  subject: string;
  body: string;
  requester?: string;
  tags: string[];
  /** From the dedicated Zendesk field when the export carries it — one signal, not the source of truth. */
  affectedCustomers?: string[];
  createdAt?: string;
  productLine?: string;
  module?: string;
  customerName?: string;
  whyBuild?: string;
  insights?: string;
  dealRelated?: string;
  customerType?: string;
  url?: string;
  raw: Record<string, string>;
}

export interface ImportSummary {
  imported: number;
  frs: number;
  /** FRs merged into an existing Jira idea instead of becoming new ideas. */
  matched: number;
  bugs: number;
  needsDetails: number;
  /** Parked kinds beyond bugs: requests for someone to act, and product questions. */
  opsTasks: number;
  questions: number;
  duplicates: number;
  /** Tickets broken into more than one idea by the split stage. */
  split: number;
  called: number;
  jiraConnected: boolean;
  jiraCount: number;
  /** The batch row holding this run's trace (Admin/monitoring). */
  batchId: string;
  /** Server-side wall time of the whole import. */
  durationMs: number;
}

const APPROVAL_EXEMPT = ["deleted", "unchanged"];

type TicketRow = Prisma.ZendeskTicketRawGetPayload<Record<string, never>>;
/** Sources carry the ticket fields idea-level lists are derived from. */
const IDEA_INCLUDE = {
  sources: {
    include: {
      ticket: {
        select: {
          externalId: true,
          requester: true,
          affectedCustomers: true,
          affectsAllCustomers: true,
          dismissedCustomers: true,
        },
      },
    },
  },
} as const;
type IdeaRow = Prisma.IdeaGetPayload<{ include: typeof IDEA_INCLUDE }>;

/** Union of string lists, first occurrence wins on casing, insertion order kept. */
function distinct(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (v && !seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values());
}

function toClientTicket(row: TicketRow): ZendeskTicket {
  return {
    key: row.externalId,
    id: row.externalId,
    subject: row.subject,
    body: row.body,
    requester: row.requester ?? undefined,
    affectedCustomers: (row.affectedCustomers as string[]) ?? [],
    dismissedCustomers: (row.dismissedCustomers as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    createdAt: row.sourceCreatedAt ?? undefined,
    productLine: row.productLine ?? undefined,
    module: row.module ?? undefined,
    customerName: row.customerName ?? undefined,
    affectsAllCustomers: row.affectsAllCustomers || undefined,
    whyBuild: row.whyBuild ?? undefined,
    insights: row.insights ?? undefined,
    dealRelated: row.dealRelated ?? undefined,
    customerType: row.customerType ?? undefined,
    url: row.url ?? undefined,
    raw: (row.raw as Record<string, string>) ?? undefined,
    matchNotes: (row.matchNotes as unknown as MatchNote[]) ?? [],
    catalog: row.catalogKind
      ? {
          kind: row.catalogKind as CatalogKind,
          reason: row.catalogReason ?? "",
        }
      : null,
  };
}

function toClientIdea(row: IdeaRow): Idea {
  // Reporters and affected customers are derived from the linked tickets on
  // every read — reassigning sources keeps them correct with no stored copy
  // to go stale.
  const ticketRows = row.sources.flatMap((s) =>
    s.kind === "zendesk" && s.ticket ? [s.ticket] : [],
  );
  // Dismissals subtract at read time; the extraction itself is never edited,
  // so a dismissed customer can always be restored.
  const dismissed = distinct(
    ticketRows.flatMap((t) => (t.dismissedCustomers as string[]) ?? []),
  );
  const dismissedKeys = new Set(dismissed.map((d) => d.toLowerCase()));
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    products: (row.products as string[]) ?? [],
    platforms: (row.platforms as string[]) ?? [],
    reporters: distinct(
      ticketRows.flatMap((t) => (t.requester ? [t.requester] : [])),
    ),
    customers: distinct([
      ...ticketRows.flatMap((t) => (t.affectedCustomers as string[]) ?? []),
      ...((row.addedCustomers as string[]) ?? []),
    ]).filter((c) => !dismissedKeys.has(c.toLowerCase())),
    addedCustomers: (row.addedCustomers as string[]) ?? [],
    affectsAllCustomers:
      ticketRows.some((t) => t.affectsAllCustomers) || undefined,
    dismissedCustomers: dismissed,
    batch: row.batchStatus as Idea["batch"],
    batchChanges: (row.batchChanges as string[]) ?? [],
    decision: row.decision as Idea["decision"],
    origin: row.origin as Idea["origin"],
    pmScore: row.pmScore,
    manual: row.manualScore,
    existingVotes: row.existingVotes,
    newVotes: row.newVotes,
    zen: row.sources.flatMap((s) =>
      s.kind === "zendesk" && s.ticket ? [s.ticket.externalId] : [],
    ),
    jira: row.sources.flatMap((s) =>
      s.kind === "jira" && s.jiraKey ? [s.jiraKey] : [],
    ),
  };
}

export async function getIdeasState(workspaceId: string): Promise<IdeasState> {
  const [
    ticketRows,
    snapshotRows,
    ideaRows,
    customerRows,
    undoRows,
    jiraStatus,
    wsRow,
  ] = await Promise.all([
    db.zendeskTicketRaw.findMany({
      where: { workspaceId },
      orderBy: [{ importedAt: "asc" }, { id: "asc" }],
    }),
    db.jiraIdeaSnapshot.findMany({
      where: { workspaceId },
      orderBy: { key: "asc" },
    }),
    db.idea.findMany({
      where: { workspaceId },
      include: IDEA_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.customer.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { name: true },
    }),
    db.ideasPushUndo.findMany({
      where: { workspaceId },
      select: { ideaId: true, action: true, jiraKey: true },
    }),
    getJiraConnectionStatus(workspaceId),
    db.workspace.findUnique({
      where: { id: workspaceId },
      select: { ideasConfig: true },
    }),
  ]);

  const undoByIdea = new Map(
    undoRows.map((u) => [
      u.ideaId,
      { action: u.action as "create" | "update", jiraKey: u.jiraKey },
    ]),
  );

  return {
    jiraConnected: Boolean(jiraStatus?.connected),
    csvMapping: mergeIdeasJiraConfig(wsRow?.ideasConfig).csv,
    tickets: ticketRows.map(toClientTicket),
    jiraSources: snapshotRows.map((s) => ({
      key: s.key,
      id: s.key,
      title: s.title,
      body: s.body,
      status: s.status ?? undefined,
      url: s.url ?? undefined,
      products: (s.components as string[]) ?? [],
    })),
    ideas: ideaRows.map((row) => {
      const idea = toClientIdea(row);
      const undo = undoByIdea.get(row.id);
      return undo ? { ...idea, undoable: undo } : idea;
    }),
    customerCatalog: customerRows.map((c) => c.name),
  };
}

/**
 * One import: dedupe against the raw store, resync Jira live state, catalog
 * the new tickets (only FRs become ideas), then match each FR against the
 * live Jira ideas (PRD step 3). A matched FR merges into the existing idea
 * as evidence — a vote, an Updated status, optional enrichment — instead of
 * becoming a new idea.
 *
 * The batch row exists from the first moment and carries the run trace
 * (stage timings, calls, tokens, errors) — a run that dies is recorded as
 * such, never silently missing.
 */
export async function importBatch(
  workspaceId: string,
  inputs: ImportTicketInput[],
): Promise<{ summary: ImportSummary; state: IdeasState }> {
  await markAbandonedImports("stale heartbeat");
  const batch = await db.ideaBatch.create({ data: { workspaceId } });
  const trace = new ImportTrace(batch.id);
  trace.uploaded = inputs.length;
  console.log(
    `[ideas:import ${batch.id.slice(0, 8)}] start · ${inputs.length} tickets uploaded · workspace ${workspaceId}`,
  );
  try {
    return await runImport(workspaceId, inputs, batch.id, trace);
  } catch (err) {
    const message = trace.fail(err);
    await trace.flush({ status: "failed", error: message });
    throw new Error(message);
  }
}

async function runImport(
  workspaceId: string,
  inputs: ImportTicketInput[],
  batchId: string,
  trace: ImportTrace,
): Promise<{ summary: ImportSummary; state: IdeasState }> {
  trace.begin("dedupe", "db", inputs.length);
  const existing = await db.zendeskTicketRaw.findMany({
    where: { workspaceId },
    select: { externalId: true },
  });
  const known = new Set(existing.map((t) => t.externalId));
  const fresh = inputs.filter((t) => !known.has(t.key));
  const duplicates = inputs.length - fresh.length;
  trace.fresh = fresh.length;
  trace.end({ note: `${fresh.length} new, ${duplicates} already imported` });

  // Jira live state is fetched before any judgment: FRs are matched against
  // the same backlog this batch will display.
  trace.begin("jira-fetch", "http");
  const jira = await fetchJiraLiveSources(workspaceId);
  trace.end({
    note: jira.connected
      ? `${jira.sources.length} live issues`
      : "Jira not connected",
  });

  // Stage contexts (catalogs + template) are loaded once, and the prompt
  // prefixes known now are warmed in the provider's cache while the parse
  // runs — by the time classify fires they are readable. Split and group
  // prefixes are only worth pre-warming for imports big enough to need them.
  trace.begin("prepare", "db");
  const [catalogCtx, splitCtx, matchCtx] = await Promise.all([
    prepareCatalog(workspaceId),
    prepareSplit(workspaceId),
    prepareMatch(workspaceId),
  ]);
  const warmer = new PrefixWarmer(trace.side("prewarm", "ai"));
  if (fresh.length > 1) warmer.ensure(CATALOG_PREFIX_KEY, catalogCtx.prefix);
  if (fresh.length >= 10) {
    warmer.ensure(SPLIT_PREFIX_KEY, splitCtx.prefix);
    warmer.ensure(MATCH_GROUP_PREFIX_KEY, matchCtx.groupPrefix);
  }
  trace.end();

  // LLM judgments happen before any DB writes — the ledger records each
  // verdict as it lands, so a failure here loses nothing.
  // AI field parsing (Gemini, one call): clean customer names + all-customers
  // flags from the raw field values. Off per org → the legacy split below.
  const importCfg = mergeIdeasJiraConfig(
    (
      await db.workspace.findUnique({
        where: { id: workspaceId },
        select: { ideasConfig: true },
      })
    )?.ideasConfig,
  );
  const parseOn = importCfg.fieldParsing.customers;
  const parseCells = fresh.flatMap((t) => [
    t.customerName ?? "",
    ...(t.affectedCustomers ?? []),
  ]);
  trace.begin("parse", "ai", parseCells.filter((c) => c.trim()).length);
  const parse = parseOn
    ? await parseCustomerCells(workspaceId, parseCells, trace)
    : {
        byRaw: new Map<string, ParsedCell>(),
        model: "",
        promptVersion: "",
        called: 0,
      };
  trace.end({
    model: parse.model,
    promptVersion: parse.promptVersion,
    ...(parseOn ? {} : { note: "field parsing off for this org" }),
  });
  // Parenthetical rule (Daniel, 09-13): a cell "NAME (OTHER)" names ONE
  // customer. If OTHER is already a customer on its own — in the catalog or
  // on any other ticket — it is the parent/group and is dropped; otherwise
  // the whole "NAME (OTHER)" is kept as the name. Never two customers.
  if (parseOn && parse.byRaw.size > 0) {
    const [catalogRows, ticketRows] = await Promise.all([
      db.customer.findMany({ where: { workspaceId }, select: { name: true, aliases: true } }),
      db.zendeskTicketRaw.findMany({
        where: { workspaceId },
        select: { customerName: true, affectedCustomers: true },
      }),
    ]);
    const standalone = new Map<string, Set<string>>(); // key → sources ("catalog", ticket keys)
    const seen = (name: string, source: string) => {
      const k = customerKey(name);
      if (!k) return;
      if (!standalone.has(k)) standalone.set(k, new Set());
      standalone.get(k)!.add(source);
    };
    for (const c of catalogRows) {
      seen(c.name, "catalog");
      for (const a of (c.aliases as string[]) ?? []) seen(a, "catalog");
    }
    for (const t of ticketRows) {
      for (const n of (t.affectedCustomers as string[]) ?? []) seen(n, `db:${t.customerName ?? ""}`);
    }
    for (const t of fresh) {
      for (const cell of [t.customerName ?? "", ...(t.affectedCustomers ?? [])]) {
        // Only names that stand alone in the cell count as "appears elsewhere".
        for (const piece of cell.split(/[,;/]+/)) {
          const bare = piece.trim().replace(/^and\s+/i, "").replace(/^prospect\s+/i, "");
          if (bare && !/[()]/.test(bare)) seen(bare, `import:${t.key}`);
        }
      }
    }
    for (const [rawKey, cell] of parse.byRaw) {
      const m = cell.raw.match(/^\s*(.+?)\s*\((.+?)\)\s*$/);
      if (!m) continue;
      const outer = m[1].trim();
      const inner = m[2].trim();
      const innerSources = standalone.get(customerKey(inner));
      const innerElsewhere =
        !!innerSources &&
        Array.from(innerSources).some((src) => src !== `import:${rawKey}`);
      parse.byRaw.set(rawKey, {
        ...cell,
        names: innerElsewhere ? [outer] : [`${outer} (${inner})`],
      });
    }
  }
  const parsedOf = (value: string | undefined | null): ParsedCell | null =>
    value ? (parse.byRaw.get(value.trim().toLowerCase()) ?? null) : null;
  /** Names a field value contributes — parsed when on, legacy split when off. */
  const namesOf = (value: string | undefined | null): string[] => {
    if (!value) return [];
    if (parseOn) return parsedOf(value)?.names ?? [];
    return value
      .split(/[,;/]+/)
      .map((n) => n.trim())
      .filter(Boolean);
  };

  trace.begin("classify", "ai", fresh.length);
  const catalog = await catalogTickets(
    workspaceId,
    fresh.map(
      ({
        key,
        subject,
        body,
        requester,
        tags,
        module,
        whyBuild,
        insights,
      }) => ({
        key,
        subject,
        body,
        requester,
        tags,
        module,
        whyBuild,
        insights,
      }),
    ),
    { hooks: trace, warmer, ctx: catalogCtx },
  );
  const kindCounts = new Map<string, number>();
  for (const v of catalog.results)
    kindCounts.set(v.kind, (kindCounts.get(v.kind) ?? 0) + 1);
  trace.end({
    model: catalog.model,
    promptVersion: catalog.promptVersion,
    note: Array.from(kindCounts, ([k, n]) => `${n} ${k}`).join(", "),
  });
  const verdictByKey = new Map(catalog.results.map((v) => [v.key, v]));

  // Split stage: only tickets the catalog flagged as multi-problem pay for
  // it. A ticket's FR "units" are what flows through match and idea
  // creation — one unit for normal tickets, one per sub-idea for split ones
  // (unit keys "<ticket>#1..n"). A split that comes back with one request is
  // the escape hatch: the catalog rewrite stands.
  const flagged = catalog.results.filter(
    (v) => v.kind === "fr" && v.requestCount > 1,
  );
  trace.begin("split", "ai", flagged.length);
  const split = await splitTickets(
    workspaceId,
    flagged.map((v) => {
      const input = fresh.find((t) => t.key === v.key);
      return {
        key: v.key,
        subject: input?.subject ?? "",
        body: input?.body ?? "",
        requester: input?.requester,
        module: input?.module,
        whyBuild: input?.whyBuild,
        insights: input?.insights,
      };
    }),
    { hooks: trace, warmer, ctx: splitCtx },
  );
  trace.end({
    model: split.model,
    promptVersion: split.promptVersion,
    note: `${split.results.filter((r) => r.requests.length > 1).length} actually split`,
  });
  const splitByKey = new Map(split.results.map((r) => [r.key, r]));
  let splitTicketCount = 0;

  interface FrUnit {
    unitKey: string;
    rewrite: SplitRequest;
  }
  /** Ticket key → the FR units it produces (always at least one for an FR). */
  const unitsByTicket = new Map<string, FrUnit[]>();
  for (const v of catalog.results) {
    if (v.kind !== "fr") continue;
    const sr = splitByKey.get(v.key);
    if (sr && sr.requests.length > 1) {
      splitTicketCount++;
      unitsByTicket.set(
        v.key,
        sr.requests.map((r, i) => ({
          unitKey: `${v.key}#${i + 1}`,
          rewrite: r,
        })),
      );
    } else {
      unitsByTicket.set(v.key, [
        {
          unitKey: v.key,
          rewrite: {
            productTitle: v.productTitle,
            productSummary: v.productSummary,
            productLines: v.productLines,
            platforms: v.platforms,
          },
        },
      ]);
    }
  }

  // Match candidates are the CURRENT ideas list — however each idea was born
  // — plus live Jira issues not yet represented as ideas (they become ideas
  // later in this import). Jira disconnected just means fewer candidates.
  const existingIdeas = await db.idea.findMany({
    where: { workspaceId, batchStatus: { not: "deleted" } },
    select: {
      id: true,
      title: true,
      details: true,
      sources: { select: { kind: true, jiraKey: true } },
    },
  });
  const representedJiraKeys = new Set(
    existingIdeas.flatMap((i) =>
      i.sources.flatMap((src) =>
        src.kind === "jira" && src.jiraKey ? [src.jiraKey] : [],
      ),
    ),
  );
  const matchCandidates = [
    ...existingIdeas.map((i) => ({
      key: i.id,
      title: i.title,
      body: i.details,
    })),
    ...(jira.connected ? jira.sources : [])
      .filter((src) => !representedJiraKeys.has(src.key))
      .map((src) => ({
        key: `jira:${src.key}`,
        title: src.title,
        body: src.body,
      })),
  ];

  const matchInputs = catalog.results
    .filter((v) => v.kind === "fr")
    .flatMap((v) => {
      const input = fresh.find((t) => t.key === v.key);
      return (unitsByTicket.get(v.key) ?? []).map((u) => ({
        key: u.unitKey,
        subject: input?.subject ?? "",
        body: input?.body ?? "",
        productTitle: u.rewrite.productTitle,
        productSummary: u.rewrite.productSummary,
      }));
    });
  trace.begin("match", "ai", matchInputs.length);
  const match = await matchTickets(workspaceId, matchInputs, matchCandidates, {
    warmer,
    ctx: matchCtx,
    hooks: {
      call: (s) => trace.call(s),
      groupPhase: (groups, meta) => {
        trace.end({
          ...meta,
          note: `${matchCandidates.length} existing candidates`,
        });
        trace.begin("match-group", "ai", groups);
      },
    },
  });
  trace.end({
    model: match.model,
    promptVersion: match.promptVersion,
    note: `${match.results.filter((m) => m.matchedKey).length} units merged`,
  });
  const matchByKey = new Map(match.results.map((m) => [m.key, m]));

  // Catalog casing wins wherever a name (from the model or the CSV's
  // dedicated field) matches a cataloged customer; unmatched names stay
  // verbatim and surface as suggestions.
  // The dedicated Customer Name column is truth: names it carries that are
  // not in the catalog yet are added to Settings → Ideas → Customers now, so
  // they canonicalize as confirmed customers rather than suggestions.
  trace.begin("customers", "db");
  const existingCustomers = await db.customer.findMany({
    where: { workspaceId },
    select: { name: true, aliases: true, color: true },
  });
  // Identity is the normalized key (case, punctuation, a leading "The", a
  // legal suffix) plus each customer's merged aliases — so "Whitfield Group"
  // in the column and "The Whitfield Group" in a ticket are one customer.
  const customerCatalog = existingCustomers.map((c) => ({
    name: c.name,
    aliases: (c.aliases as string[]) ?? [],
  }));
  const truthNames = new Map<string, string>();
  const knownKeys = new Set(
    customerCatalog.flatMap((c) => [customerKey(c.name), ...c.aliases.map(customerKey)]),
  );
  for (const t of fresh) {
    // The column can carry a list ("A, B / C") — each entry is a customer.
    for (const name of namesOf(t.customerName)) {
      if (!name) continue;
      const key = customerKey(name);
      if (!key || knownKeys.has(key) || truthNames.has(key)) continue;
      truthNames.set(key, name);
    }
  }
  if (truthNames.size > 0) {
    const used = existingCustomers.map((c) => c.color);
    await db.customer.createMany({
      data: Array.from(truthNames.values()).map((name) => {
        const color = nextChipColor(used);
        used.push(color);
        return { workspaceId, name, description: "", color };
      }),
    });
  }
  const canonicalCustomer = buildCustomerResolver([
    ...customerCatalog,
    ...Array.from(truthNames.values()).map((name) => ({ name, aliases: [] })),
  ]);
  trace.end({ note: `${truthNames.size} added to the catalog` });

  // Snapshots are replaced wholesale; Jira-origin ideas are upserted by key
  // so evidence matched in earlier batches survives the resync.
  trace.begin("jira-sync", "db", jira.connected ? jira.sources.length : 0);
  if (jira.connected) {
    await db.jiraIdeaSnapshot.deleteMany({ where: { workspaceId } });
    await db.jiraIdeaSnapshot.createMany({
      data: jira.sources.map((s) => ({
        workspaceId,
        key: s.key,
        title: s.title,
        body: s.body,
        status: s.status ?? null,
        url: s.url ?? null,
        components: s.products as Prisma.InputJsonValue,
      })),
    });

    const jiraIdeas = await db.idea.findMany({
      where: { workspaceId, origin: "jira" },
      include: { sources: true },
    });
    const ideaByJiraKey = new Map(
      jiraIdeas.flatMap((i) => {
        const key = i.sources.find((s) => s.kind === "jira")?.jiraKey;
        return key ? [[key, i] as const] : [];
      }),
    );
    const liveKeys = new Set(jira.sources.map((s) => s.key));
    const gone = jiraIdeas.filter((i) => {
      const key = i.sources.find((s) => s.kind === "jira")?.jiraKey;
      return !key || !liveKeys.has(key);
    });
    if (gone.length > 0) {
      await db.idea.deleteMany({
        where: { id: { in: gone.map((i) => i.id) } },
      });
    }

    for (const s of jira.sources) {
      const cur = ideaByJiraKey.get(s.key);
      // Same fallback as Zendesk-origin ideas: a Jira issue with no
      // components gets "Other", so every idea has a product line — the
      // product filter and the scoped merge gate can never silently miss one.
      const products = s.products.length > 0 ? s.products : ["Other"];
      if (cur) {
        // Title and products track live Jira; details stay local — they may
        // carry enrichment or PM edits, and the write-back (push.ts) sends
        // them as a PM-OS section, never as an overwrite of the live body. On
        // a batch with new data, last batch's vote delta becomes existing
        // and the idea re-enters as Unchanged until a match says otherwise.
        const rollover = fresh.length > 0;
        await db.idea.update({
          where: { id: cur.id },
          data: {
            title: s.title,
            products: products as Prisma.InputJsonValue,
            ...(rollover
              ? {
                  existingVotes: cur.existingVotes + cur.newVotes,
                  newVotes: 0,
                  batchStatus: "unchanged",
                  // Last import's narration is stale once the batch rolls over.
                  batchChanges: [] as unknown as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
      } else {
        await db.idea.create({
          data: {
            workspaceId,
            title: s.title,
            details: s.body,
            products: products as Prisma.InputJsonValue,
            batchStatus: "unchanged",
            decision: "pending",
            origin: "jira",
            sources: { create: [{ kind: "jira", jiraKey: s.key }] },
          },
        });
      }
    }
  }

  trace.end(jira.connected ? {} : { note: "skipped" });

  trace.begin("write", "db", fresh.length);
  let frs = 0;
  let matched = 0;
  let bugs = 0;
  let needsDetails = 0;
  let opsTasks = 0;
  let questions = 0;
  /** "new:<ticket key>" → idea created for that ticket earlier in this loop. */
  const createdByMatchKey = new Map<string, string>();
  const createdThisBatch = new Set<string>();
  for (const input of fresh) {
    const verdict = verdictByKey.get(input.key);
    const ticket = await db.zendeskTicketRaw.create({
      data: {
        workspaceId,
        externalId: input.key,
        subject: input.subject,
        body: input.body,
        requester: input.requester ?? null,
        affectedCustomers: distinct(
          [
            ...(verdict?.affectedCustomers ?? []),
            ...(input.affectedCustomers ?? []).flatMap((v) => namesOf(v)),
          ].map(canonicalCustomer),
        ) as Prisma.InputJsonValue,
        affectsAllCustomers:
          parseOn &&
          [input.customerName ?? "", ...(input.affectedCustomers ?? [])].some(
            (v) => parsedOf(v)?.all === true,
          ),
        tags: input.tags as Prisma.InputJsonValue,
        productLine: input.productLine ?? null,
        module: input.module ?? null,
        customerName: input.customerName ?? null,
        whyBuild: input.whyBuild ?? null,
        insights: input.insights ?? null,
        dealRelated: input.dealRelated ?? null,
        customerType: input.customerType ?? null,
        url: input.url ?? null,
        sourceCreatedAt: input.createdAt ?? null,
        raw: input.raw as Prisma.InputJsonValue,
        batchId,
        catalogKind: verdict?.kind ?? null,
        catalogReason: verdict?.reason ?? null,
      },
    });
    if (verdict?.kind === "bug") bugs++;
    else if (verdict?.kind === "needs_details") needsDetails++;
    else if (verdict?.kind === "ops_task") opsTasks++;
    else if (verdict?.kind === "question") questions++;
    else if (verdict?.kind === "fr") {
      frs++;
      const notes: MatchNote[] = [];
      for (const unit of unitsByTicket.get(input.key) ?? []) {
        const m = matchByKey.get(unit.unitKey);
        // The matched key can be an idea id, "jira:<KEY>" (an issue that only
        // became an idea during this import's snapshot sync), or "new:<ticket>"
        // (an idea created from an earlier ticket of this same import).
        const targetId = m?.matchedKey
          ? m.matchedKey.startsWith("new:")
            ? (createdByMatchKey.get(m.matchedKey) ?? null)
            : null
          : null;
        const target = m?.matchedKey
          ? m.matchedKey.startsWith("new:")
            ? targetId
              ? await db.idea.findFirst({
                  where: { workspaceId, id: targetId },
                })
              : null
            : m.matchedKey.startsWith("jira:")
              ? await db.idea.findFirst({
                  where: {
                    workspaceId,
                    sources: {
                      some: { kind: "jira", jiraKey: m.matchedKey.slice(5) },
                    },
                  },
                })
              : await db.idea.findFirst({
                  where: { workspaceId, id: m.matchedKey },
                })
          : null;
        if (target) {
          // Mandatory guard (self-merge double vote): a ticket never sources
          // the same idea twice — if a sibling sub-idea already landed here,
          // this unit adds nothing.
          const alreadySourced = await db.ideaSource.findFirst({
            where: { ideaId: target.id, kind: "zendesk", ticketId: ticket.id },
            select: { id: true },
          });
          notes.push({
            unit: unit.unitKey,
            ideaId: target.id,
            merged: true,
            reason: m?.reason ?? "",
          });
          if (alreadySourced) continue;
          // Matched FR unit: evidence on the existing idea, never a new one.
          // The idea re-enters review as Updated and absorbs the new
          // evidence's metadata (union — nothing is ever removed here).
          // batchChanges narrates exactly what this import did.
          matched++;
          const curProducts = (target.products as string[]) ?? [];
          const curPlatforms = (target.platforms as string[]) ?? [];
          let nextProducts = distinct([
            ...curProducts,
            ...unit.rewrite.productLines,
          ]);
          // A real product line replaces the "Other" placeholder.
          if (nextProducts.length > 1)
            nextProducts = nextProducts.filter((p) => p !== "Other");
          const nextPlatforms = distinct([
            ...curPlatforms,
            ...unit.rewrite.platforms,
          ]);
          const addedProducts = nextProducts.filter(
            (p) =>
              !curProducts.some((c) => c.toLowerCase() === p.toLowerCase()),
          );
          const addedPlatforms = nextPlatforms.filter(
            (p) =>
              !curPlatforms.some((c) => c.toLowerCase() === p.toLowerCase()),
          );

          const changes: string[] = [`+1 vote (ticket ${input.key})`];
          if (m?.enrichedSummary)
            changes.push("Summary enriched with the new ticket");
          for (const p of addedProducts)
            changes.push(`Product line added: ${p}`);
          for (const p of addedPlatforms) changes.push(`Platform added: ${p}`);
          // Several tickets can match the same idea in one import — accumulate.
          // (fresh tickets exist here, so rollover already reset last batch's
          // status: "updated" can only mean updated in THIS import.)
          const prior =
            target.batchStatus === "updated" || createdThisBatch.has(target.id)
              ? ((target.batchChanges as string[]) ?? [])
              : [];

          await db.idea.update({
            where: { id: target.id },
            data: {
              newVotes: { increment: 1 },
              // An idea born in THIS import that absorbs another ticket is
              // still New — Updated is for ideas that pre-date the import.
              batchStatus: createdThisBatch.has(target.id) ? "new" : "updated",
              decision: "pending",
              products: nextProducts as Prisma.InputJsonValue,
              platforms: nextPlatforms as Prisma.InputJsonValue,
              batchChanges: [...prior, ...changes] as Prisma.InputJsonValue,
              ...(m && m.enrichedSummary ? { details: m.enrichedSummary } : {}),
              sources: { create: [{ kind: "zendesk", ticketId: ticket.id }] },
            },
          });
          continue;
        }
        // Model assignment wins; the CSV product_line column is only a fallback
        // when the model returned nothing at all.
        // A group-reconciled rewrite (match stage) wins over the unit's own
        // catalog text: it was written with every member ticket in view.
        const finalRewrite = m?.rewrite ?? unit.rewrite;
        const products =
          finalRewrite.productLines.length > 0
            ? finalRewrite.productLines
            : input.productLine
              ? [input.productLine]
              : ["Other"];
        // Ideas read in product voice; the customer's original wording stays
        // intact on ZendeskTicketRaw. Fallbacks guard empty model output.
        const created = await db.idea.create({
          data: {
            workspaceId,
            title: finalRewrite.productTitle || input.subject,
            details: finalRewrite.productSummary || input.body,
            products: products as Prisma.InputJsonValue,
            platforms: finalRewrite.platforms as Prisma.InputJsonValue,
            batchStatus: "new",
            decision: "pending",
            origin: "zendesk",
            newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: ticket.id }] },
          },
        });
        createdByMatchKey.set(`new:${unit.unitKey}`, created.id);
        createdThisBatch.add(created.id);
        notes.push({
          unit: unit.unitKey,
          ideaId: created.id,
          merged: false,
          reason: m?.reason ?? "",
        });
      }
      if (notes.length > 0) {
        await db.zendeskTicketRaw.update({
          where: { id: ticket.id },
          data: { matchNotes: notes as unknown as Prisma.InputJsonValue },
        });
      }
    }
  }

  const summary: ImportSummary = {
    imported: fresh.length,
    frs,
    matched,
    bugs,
    needsDetails,
    opsTasks,
    questions,
    duplicates,
    split: splitTicketCount,
    called: catalog.called + split.called + match.called + parse.called,
    jiraConnected: jira.connected,
    jiraCount: jira.sources.length,
    batchId,
    durationMs: 0,
  };
  trace.end({
    note: `${frs} FRs, ${matched} merged, ${createdThisBatch.size} ideas created`,
  });

  trace.begin("state", "db");
  const state = await getIdeasState(workspaceId);
  trace.end();
  summary.durationMs = trace.elapsedMs;
  await trace.flush({ status: "completed", stats: summary });

  return { summary, state };
}

// "inject" is not a mutation anymore — marking an idea as In Jira without a
// real write was the demo behavior. The write-back lives in ./push.ts.
export type IdeasMutation =
  | { type: "decision"; ideaId: string; decision: "pending" | "reviewed" }
  | {
      type: "edit";
      ideaId: string;
      title: string;
      details: string;
      manual: number | null;
      /** Full lists as edited; omitted = unchanged. */
      products?: string[];
      platforms?: string[];
      addedCustomers?: string[];
      /** Ticket-derived names the PM removed — dismissed on their tickets (reversible). */
      removeCustomers?: string[];
    }
  | { type: "approveAll" }
  | { type: "reassign"; ideaId: string; zen: string[]; jira: string[] }
  | { type: "approveCustomer"; ideaId: string; name: string }
  | { type: "dismissCustomer"; ideaId: string; name: string }
  | { type: "undismissCustomer"; ideaId: string; name: string };

/**
 * Suggested metadata still awaiting the PM's call on this idea. Today that is
 * customers the extraction surfaced that are neither in the catalog nor
 * dismissed; any future suggested attribute joins this check. An idea with an
 * unresolved suggestion cannot be approved — each one must be approved or
 * dismissed first.
 */
function unresolvedSuggestions(
  row: IdeaRow,
  catalogLower: Set<string>,
): string[] {
  const ticketRows = row.sources.flatMap((s) =>
    s.kind === "zendesk" && s.ticket ? [s.ticket] : [],
  );
  const dismissed = new Set(
    ticketRows.flatMap((t) =>
      ((t.dismissedCustomers as string[]) ?? []).map((c) => c.toLowerCase()),
    ),
  );
  return distinct(
    ticketRows.flatMap((t) => (t.affectedCustomers as string[]) ?? []),
  ).filter(
    (c) =>
      !dismissed.has(c.toLowerCase()) && !catalogLower.has(c.toLowerCase()),
  );
}

async function customerCatalogLower(workspaceId: string): Promise<Set<string>> {
  const rows = await db.customer.findMany({
    where: { workspaceId },
    select: { name: true },
  });
  return new Set(rows.map((c) => c.name.toLowerCase()));
}

async function logEvents(
  workspaceId: string,
  events: { ideaId: string; action: string; payload?: unknown }[],
): Promise<void> {
  if (events.length === 0) return;
  await db.reviewEvent.createMany({
    data: events.map((e) => ({
      workspaceId,
      ideaId: e.ideaId,
      action: e.action,
      payload: (e.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    })),
  });
}

export interface MutateResult {
  state: IdeasState;
  /** Something the PM should be told about the action (shown as a toast). */
  notice?: string;
}

export async function mutateIdeas(
  workspaceId: string,
  mutation: IdeasMutation,
): Promise<MutateResult> {
  let notice: string | undefined;
  switch (mutation.type) {
    case "decision": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: IDEA_INCLUDE,
      });
      // Approval-exempt ideas carry zero changes for Jira — approving one
      // would inject a no-op, so the server refuses it outright.
      if (
        mutation.decision === "reviewed" &&
        idea &&
        APPROVAL_EXEMPT.includes(idea.batchStatus)
      ) {
        break;
      }
      if (mutation.decision === "reviewed" && idea) {
        const open = unresolvedSuggestions(
          idea,
          await customerCatalogLower(workspaceId),
        );
        if (open.length > 0) {
          throw new Error(
            `Review the suggested customer${open.length === 1 ? "" : "s"} first — approve or dismiss: ${open.join(", ")}`,
          );
        }
      }
      if (idea && idea.decision !== "injected") {
        await db.idea.update({
          where: { id: idea.id },
          data: { decision: mutation.decision },
        });
        await logEvents(workspaceId, [
          {
            ideaId: idea.id,
            action: mutation.decision === "reviewed" ? "approve" : "unapprove",
            payload: { from: idea.decision, to: mutation.decision },
          },
        ]);
      }
      break;
    }
    case "edit": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: {
          sources: {
            include: {
              ticket: {
                select: { id: true, affectedCustomers: true, dismissedCustomers: true },
              },
            },
          },
        },
      });
      if (idea) {
        const clean = (v: string[] | undefined) =>
          v === undefined ? undefined : distinct(v.map((x) => x.trim()).filter(Boolean));
        const products = clean(mutation.products);
        const platforms = clean(mutation.platforms);
        const addedCustomers = clean(mutation.addedCustomers);
        await db.idea.update({
          where: { id: idea.id },
          data: {
            title: mutation.title,
            details: mutation.details,
            manualScore: mutation.manual,
            ...(products ? { products: products as Prisma.InputJsonValue } : {}),
            ...(platforms ? { platforms: platforms as Prisma.InputJsonValue } : {}),
            ...(addedCustomers
              ? { addedCustomers: addedCustomers as Prisma.InputJsonValue }
              : {}),
          },
        });
        // An added name that was dismissed earlier on one of the tickets is
        // being brought back on purpose — lift those dismissals.
        for (const name of addedCustomers ?? []) {
          const wanted = name.toLowerCase();
          for (const s of idea.sources) {
            if (s.kind !== "zendesk" || !s.ticket) continue;
            const dismissed = (s.ticket.dismissedCustomers as string[]) ?? [];
            const next = dismissed.filter((c) => c.toLowerCase() !== wanted);
            if (next.length !== dismissed.length) {
              await db.zendeskTicketRaw.update({
                where: { id: s.ticket.id },
                data: { dismissedCustomers: next as Prisma.InputJsonValue },
              });
            }
          }
        }
        // A removed ticket-derived customer is a dismissal on the tickets
        // that named it — never a deletion, so "show dismissed" restores it.
        for (const name of mutation.removeCustomers ?? []) {
          const wanted = name.trim().toLowerCase();
          if (!wanted) continue;
          for (const s of idea.sources) {
            if (s.kind !== "zendesk" || !s.ticket) continue;
            const affected = (s.ticket.affectedCustomers as string[]) ?? [];
            const dismissed = (s.ticket.dismissedCustomers as string[]) ?? [];
            if (!affected.some((c) => c.toLowerCase() === wanted)) continue;
            if (dismissed.some((c) => c.toLowerCase() === wanted)) continue;
            await db.zendeskTicketRaw.update({
              where: { id: s.ticket.id },
              data: {
                dismissedCustomers: [...dismissed, name.trim()] as Prisma.InputJsonValue,
              },
            });
          }
        }
        await logEvents(workspaceId, [
          {
            ideaId: idea.id,
            action: "edit",
            payload: {
              before: {
                title: idea.title,
                details: idea.details,
                manual: idea.manualScore,
                products: idea.products,
                platforms: idea.platforms,
                addedCustomers: idea.addedCustomers,
              },
              after: {
                title: mutation.title,
                details: mutation.details,
                manual: mutation.manual,
                products: products ?? idea.products,
                platforms: platforms ?? idea.platforms,
                addedCustomers: addedCustomers ?? idea.addedCustomers,
                removedCustomers: mutation.removeCustomers ?? [],
              },
            },
          },
        ]);
      }
      break;
    }
    case "approveAll": {
      const approvable = await db.idea.findMany({
        where: { workspaceId, batchStatus: { notIn: APPROVAL_EXEMPT } },
        include: IDEA_INCLUDE,
      });
      const revert = approvable.every((i) => i.decision !== "pending");
      // Bulk approve skips (never fails on) ideas with unresolved suggested
      // metadata — those need a per-idea call; reverting is always allowed.
      const catalogLower = revert
        ? null
        : await customerCatalogLower(workspaceId);
      const targets = approvable.filter((i) =>
        revert
          ? i.decision === "reviewed"
          : i.decision === "pending" &&
            unresolvedSuggestions(i, catalogLower!).length === 0,
      );
      await db.idea.updateMany({
        where: { id: { in: targets.map((i) => i.id) } },
        data: { decision: revert ? "pending" : "reviewed" },
      });
      if (!revert) {
        const skipped = approvable.filter(
          (i) => i.decision === "pending" && !targets.includes(i),
        ).length;
        notice =
          skipped > 0
            ? `${targets.length} approved · ${skipped} skipped — review the suggested customer${skipped === 1 ? "" : "s"} on ${skipped === 1 ? "that idea" : "those ideas"} first`
            : `${targets.length} approved`;
      } else {
        notice = `${targets.length} back to pending`;
      }
      await logEvents(
        workspaceId,
        targets.map((i) => ({
          ideaId: i.id,
          action: revert ? "unapprove" : "approve",
          payload: { bulk: true },
        })),
      );
      break;
    }
    case "reassign": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: IDEA_INCLUDE,
      });
      if (!idea) break;
      const ticketRows = await db.zendeskTicketRaw.findMany({
        where: { workspaceId, externalId: { in: mutation.zen } },
        select: { id: true },
      });
      await db.ideaSource.deleteMany({ where: { ideaId: idea.id } });
      await db.ideaSource.createMany({
        data: [
          ...ticketRows.map((t) => ({
            ideaId: idea.id,
            kind: "zendesk",
            ticketId: t.id,
          })),
          ...mutation.jira.map((key) => ({
            ideaId: idea.id,
            kind: "jira",
            jiraKey: key,
          })),
        ],
      });
      // Votes = all merged evidence: every ticket and every merged Jira idea
      // counts, excluding a jira-origin idea's own issue (it is always one of
      // its jira sources). The this-batch delta follows that evidence count.
      const selfJira = idea.origin === "jira" ? 1 : 0;
      const oldZen = idea.sources.filter((s) => s.kind === "zendesk").length;
      const oldJira = idea.sources.filter((s) => s.kind === "jira").length;
      const oldEvidence = oldZen + Math.max(0, oldJira - selfJira);
      const newEvidence =
        ticketRows.length + Math.max(0, mutation.jira.length - selfJira);
      const voteDelta = newEvidence - oldEvidence;
      if (voteDelta !== 0) {
        await db.idea.update({
          where: { id: idea.id },
          data: { newVotes: Math.max(0, idea.newVotes + voteDelta) },
        });
      }
      await logEvents(workspaceId, [
        {
          ideaId: idea.id,
          action: "reassign",
          payload: {
            before: {
              zen: toClientIdea(idea).zen,
              jira: toClientIdea(idea).jira,
            },
            after: { zen: mutation.zen, jira: mutation.jira },
          },
        },
      ]);

      // Manual reassignment moves ideas between states (PRD): no sources →
      // Deleted; a Jira idea with ticket evidence → Updated (back to
      // Unchanged when evidence is removed); a batch-created idea stays New.
      const all = await db.idea.findMany({
        where: { workspaceId },
        include: { sources: true },
      });
      for (const i of all) {
        const zenCount = i.sources.filter((s) => s.kind === "zendesk").length;
        const total = i.sources.length;
        let next: string;
        if (total === 0) next = "deleted";
        else if (i.origin === "jira")
          next = zenCount > 0 ? "updated" : "unchanged";
        else next = "new";
        if (next !== i.batchStatus) {
          await db.idea.update({
            where: { id: i.id },
            data: { batchStatus: next },
          });
        }
      }
      break;
    }
    // A suggested customer (extracted from ticket text, not yet in the
    // catalog) is approved into Settings → Ideas → Customers…
    case "approveCustomer": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
      });
      const name = mutation.name.trim();
      if (idea && name) {
        const key = customerKey(name);
        const exists = (
          await db.customer.findMany({
            where: { workspaceId },
            select: { name: true, aliases: true },
          })
        ).some(
          (c) =>
            customerKey(c.name) === key ||
            ((c.aliases as string[]) ?? []).some((a) => customerKey(a) === key),
        );
        if (!exists) {
          const used = (
            await db.customer.findMany({ where: { workspaceId }, select: { color: true } })
          ).map((c) => c.color);
          await db.customer.create({
            data: { workspaceId, name, description: "", color: nextChipColor(used) },
          });
        }
        await logEvents(workspaceId, [
          { ideaId: idea.id, action: "approve_customer", payload: { name } },
        ]);
      }
      break;
    }
    // …or dismissed: marked on this idea's tickets, never deleted — the
    // extraction stays intact so the PM can restore it at any time. A future
    // ticket naming the same customer is new evidence and suggests again.
    case "dismissCustomer": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: {
          sources: {
            include: {
              ticket: {
                select: {
                  id: true,
                  affectedCustomers: true,
                  dismissedCustomers: true,
                },
              },
            },
          },
        },
      });
      const name = mutation.name.trim();
      const wanted = name.toLowerCase();
      if (idea && name) {
        for (const s of idea.sources) {
          if (s.kind !== "zendesk" || !s.ticket) continue;
          const affected = (s.ticket.affectedCustomers as string[]) ?? [];
          const dismissed = (s.ticket.dismissedCustomers as string[]) ?? [];
          if (!affected.some((c) => c.toLowerCase() === wanted)) continue;
          if (dismissed.some((c) => c.toLowerCase() === wanted)) continue;
          await db.zendeskTicketRaw.update({
            where: { id: s.ticket.id },
            data: {
              dismissedCustomers: [...dismissed, name] as Prisma.InputJsonValue,
            },
          });
        }
        await logEvents(workspaceId, [
          { ideaId: idea.id, action: "dismiss_customer", payload: { name } },
        ]);
      }
      break;
    }
    // Regret path: un-dismiss puts the customer back on the idea.
    case "undismissCustomer": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: {
          sources: {
            include: {
              ticket: { select: { id: true, dismissedCustomers: true } },
            },
          },
        },
      });
      const wanted = mutation.name.trim().toLowerCase();
      if (idea && wanted) {
        for (const s of idea.sources) {
          if (s.kind !== "zendesk" || !s.ticket) continue;
          const current = (s.ticket.dismissedCustomers as string[]) ?? [];
          const next = current.filter((c) => c.toLowerCase() !== wanted);
          if (next.length !== current.length) {
            await db.zendeskTicketRaw.update({
              where: { id: s.ticket.id },
              data: { dismissedCustomers: next as Prisma.InputJsonValue },
            });
          }
        }
        await logEvents(workspaceId, [
          {
            ideaId: idea.id,
            action: "undismiss_customer",
            payload: { name: mutation.name },
          },
        ]);
      }
      break;
    }
  }

  return { state: await getIdeasState(workspaceId), notice };
}

/** Clear imported data. The ledger and the batch rows are deliberately kept —
 *  the append-only audit trail and the run history (traces) of every import. */
export async function clearIdeas(workspaceId: string): Promise<IdeasState> {
  await db.idea.deleteMany({ where: { workspaceId } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId } });
  await db.jiraIdeaSnapshot.deleteMany({ where: { workspaceId } });
  return getIdeasState(workspaceId);
}
