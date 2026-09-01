import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { catalogTickets } from "./catalog";
import { fetchJiraLiveSources } from "./jira-sync";
import { matchTickets } from "./match";
import type { CatalogKind, Idea, JiraSource, ZendeskTicket } from "./types";

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
  raw: Record<string, string>;
}

export interface ImportSummary {
  imported: number;
  frs: number;
  /** FRs merged into an existing Jira idea instead of becoming new ideas. */
  matched: number;
  bugs: number;
  needsDetails: number;
  duplicates: number;
  called: number;
  jiraConnected: boolean;
  jiraCount: number;
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
    catalog: row.catalogKind
      ? { kind: row.catalogKind as CatalogKind, reason: row.catalogReason ?? "" }
      : null,
  };
}

function toClientIdea(row: IdeaRow): Idea {
  // Reporters and affected customers are derived from the linked tickets on
  // every read — reassigning sources keeps them correct with no stored copy
  // to go stale.
  const ticketRows = row.sources.flatMap((s) => (s.kind === "zendesk" && s.ticket ? [s.ticket] : []));
  // Dismissals subtract at read time; the extraction itself is never edited,
  // so a dismissed customer can always be restored.
  const dismissed = distinct(ticketRows.flatMap((t) => (t.dismissedCustomers as string[]) ?? []));
  const dismissedKeys = new Set(dismissed.map((d) => d.toLowerCase()));
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    products: (row.products as string[]) ?? [],
    platforms: (row.platforms as string[]) ?? [],
    reporters: distinct(ticketRows.flatMap((t) => (t.requester ? [t.requester] : []))),
    customers: distinct(
      ticketRows.flatMap((t) => (t.affectedCustomers as string[]) ?? [])
    ).filter((c) => !dismissedKeys.has(c.toLowerCase())),
    dismissedCustomers: dismissed,
    batch: row.batchStatus as Idea["batch"],
    batchChanges: (row.batchChanges as string[]) ?? [],
    decision: row.decision as Idea["decision"],
    origin: row.origin as Idea["origin"],
    pmScore: row.pmScore,
    manual: row.manualScore,
    existingVotes: row.existingVotes,
    newVotes: row.newVotes,
    zen: row.sources.flatMap((s) => (s.kind === "zendesk" && s.ticket ? [s.ticket.externalId] : [])),
    jira: row.sources.flatMap((s) => (s.kind === "jira" && s.jiraKey ? [s.jiraKey] : [])),
  };
}

export async function getIdeasState(workspaceId: string): Promise<IdeasState> {
  const [ticketRows, snapshotRows, ideaRows, customerRows] = await Promise.all([
    db.zendeskTicketRaw.findMany({
      where: { workspaceId },
      orderBy: [{ importedAt: "asc" }, { id: "asc" }],
    }),
    db.jiraIdeaSnapshot.findMany({ where: { workspaceId }, orderBy: { key: "asc" } }),
    db.idea.findMany({
      where: { workspaceId },
      include: IDEA_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.customer.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: { name: true } }),
  ]);

  return {
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
    ideas: ideaRows.map(toClientIdea),
    customerCatalog: customerRows.map((c) => c.name),
  };
}

/**
 * One import: dedupe against the raw store, resync Jira live state, catalog
 * the new tickets (only FRs become ideas), then match each FR against the
 * live Jira ideas (PRD step 3). A matched FR merges into the existing idea
 * as evidence — a vote, an Updated status, optional enrichment — instead of
 * becoming a new idea.
 */
export async function importBatch(
  workspaceId: string,
  inputs: ImportTicketInput[]
): Promise<{ summary: ImportSummary; state: IdeasState }> {
  const existing = await db.zendeskTicketRaw.findMany({
    where: { workspaceId },
    select: { externalId: true },
  });
  const known = new Set(existing.map((t) => t.externalId));
  const fresh = inputs.filter((t) => !known.has(t.key));
  const duplicates = inputs.length - fresh.length;

  // Jira live state is fetched before any judgment: FRs are matched against
  // the same backlog this batch will display.
  const jira = await fetchJiraLiveSources(workspaceId);

  // LLM judgments happen before any DB writes — the ledger records each
  // verdict as it lands, so a failure here loses nothing.
  const catalog = await catalogTickets(
    workspaceId,
    fresh.map(({ key, subject, body, requester, tags }) => ({ key, subject, body, requester, tags }))
  );
  const verdictByKey = new Map(catalog.results.map((v) => [v.key, v]));

  const match = await matchTickets(
    workspaceId,
    catalog.results
      .filter((v) => v.kind === "fr")
      .map((v) => {
        const input = fresh.find((t) => t.key === v.key);
        return {
          key: v.key,
          subject: input?.subject ?? "",
          body: input?.body ?? "",
          productTitle: v.productTitle,
          productSummary: v.productSummary,
        };
      }),
    jira.connected ? jira.sources : []
  );
  const matchByKey = new Map(match.results.map((m) => [m.key, m]));

  // Catalog casing wins wherever a name (from the model or the CSV's
  // dedicated field) matches a cataloged customer; unmatched names stay
  // verbatim and surface as suggestions.
  const customerNames = (
    await db.customer.findMany({ where: { workspaceId }, select: { name: true } })
  ).map((c) => c.name);
  const canonicalCustomer = (name: string): string =>
    customerNames.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;

  const batch = await db.ideaBatch.create({ data: { workspaceId } });

  // Snapshots are replaced wholesale; Jira-origin ideas are upserted by key
  // so evidence matched in earlier batches survives the resync.
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
      })
    );
    const liveKeys = new Set(jira.sources.map((s) => s.key));
    const gone = jiraIdeas.filter((i) => {
      const key = i.sources.find((s) => s.kind === "jira")?.jiraKey;
      return !key || !liveKeys.has(key);
    });
    if (gone.length > 0) {
      await db.idea.deleteMany({ where: { id: { in: gone.map((i) => i.id) } } });
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

  let frs = 0;
  let matched = 0;
  let bugs = 0;
  let needsDetails = 0;
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
          [...(verdict?.affectedCustomers ?? []), ...(input.affectedCustomers ?? [])].map(
            canonicalCustomer
          )
        ) as Prisma.InputJsonValue,
        tags: input.tags as Prisma.InputJsonValue,
        productLine: input.productLine ?? null,
        sourceCreatedAt: input.createdAt ?? null,
        raw: input.raw as Prisma.InputJsonValue,
        batchId: batch.id,
        catalogKind: verdict?.kind ?? null,
        catalogReason: verdict?.reason ?? null,
      },
    });
    if (verdict?.kind === "bug") bugs++;
    else if (verdict?.kind === "needs_details") needsDetails++;
    else if (verdict?.kind === "fr") {
      frs++;
      const m = matchByKey.get(input.key);
      const target = m?.matchedKey
        ? await db.idea.findFirst({
            where: {
              workspaceId,
              origin: "jira",
              sources: { some: { kind: "jira", jiraKey: m.matchedKey } },
            },
          })
        : null;
      if (target) {
        // Matched FR: evidence on the existing idea, never a new one. The
        // idea re-enters review as Updated and absorbs the new evidence's
        // metadata (union — nothing is ever removed here). batchChanges
        // narrates exactly what this import did, for the review UI.
        matched++;
        const curProducts = (target.products as string[]) ?? [];
        const curPlatforms = (target.platforms as string[]) ?? [];
        let nextProducts = distinct([...curProducts, ...verdict.productLines]);
        // A real product line replaces the "Other" placeholder.
        if (nextProducts.length > 1) nextProducts = nextProducts.filter((p) => p !== "Other");
        const nextPlatforms = distinct([...curPlatforms, ...verdict.platforms]);
        const addedProducts = nextProducts.filter(
          (p) => !curProducts.some((c) => c.toLowerCase() === p.toLowerCase())
        );
        const addedPlatforms = nextPlatforms.filter(
          (p) => !curPlatforms.some((c) => c.toLowerCase() === p.toLowerCase())
        );

        const changes: string[] = [`+1 vote (ticket ${input.key})`];
        if (m?.enrichedSummary) changes.push("Summary enriched with the new ticket");
        for (const p of addedProducts) changes.push(`Product line added: ${p}`);
        for (const p of addedPlatforms) changes.push(`Platform added: ${p}`);
        // Several tickets can match the same idea in one import — accumulate.
        // (fresh tickets exist here, so rollover already reset last batch's
        // status: "updated" can only mean updated in THIS import.)
        const prior =
          target.batchStatus === "updated" ? ((target.batchChanges as string[]) ?? []) : [];

        await db.idea.update({
          where: { id: target.id },
          data: {
            newVotes: { increment: 1 },
            batchStatus: "updated",
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
      const products =
        verdict.productLines.length > 0
          ? verdict.productLines
          : input.productLine
            ? [input.productLine]
            : ["Other"];
      // Ideas read in product voice; the customer's original wording stays
      // intact on ZendeskTicketRaw. Fallbacks guard empty model output.
      await db.idea.create({
        data: {
          workspaceId,
          title: verdict.productTitle || input.subject,
          details: verdict.productSummary || input.body,
          products: products as Prisma.InputJsonValue,
          platforms: verdict.platforms as Prisma.InputJsonValue,
          batchStatus: "new",
          decision: "pending",
          origin: "zendesk",
          newVotes: 1,
          sources: { create: [{ kind: "zendesk", ticketId: ticket.id }] },
        },
      });
    }
  }

  const summary: ImportSummary = {
    imported: fresh.length,
    frs,
    matched,
    bugs,
    needsDetails,
    duplicates,
    called: catalog.called + match.called,
    jiraConnected: jira.connected,
    jiraCount: jira.sources.length,
  };
  await db.ideaBatch.update({
    where: { id: batch.id },
    data: { completedAt: new Date(), stats: summary as unknown as Prisma.InputJsonValue },
  });

  return { summary, state: await getIdeasState(workspaceId) };
}

// "inject" is not a mutation anymore — marking an idea as In Jira without a
// real write was the demo behavior. The write-back lives in ./push.ts.
export type IdeasMutation =
  | { type: "decision"; ideaId: string; decision: "pending" | "reviewed" }
  | { type: "edit"; ideaId: string; title: string; details: string; manual: number | null }
  | { type: "approveAll" }
  | { type: "reassign"; ideaId: string; zen: string[]; jira: string[] }
  | { type: "approveCustomer"; ideaId: string; name: string }
  | { type: "dismissCustomer"; ideaId: string; name: string }
  | { type: "undismissCustomer"; ideaId: string; name: string };

async function logEvents(
  workspaceId: string,
  events: { ideaId: string; action: string; payload?: unknown }[]
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

export async function mutateIdeas(
  workspaceId: string,
  mutation: IdeasMutation
): Promise<IdeasState> {
  switch (mutation.type) {
    case "decision": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
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
      });
      if (idea) {
        await db.idea.update({
          where: { id: idea.id },
          data: {
            title: mutation.title,
            details: mutation.details,
            manualScore: mutation.manual,
          },
        });
        await logEvents(workspaceId, [
          {
            ideaId: idea.id,
            action: "edit",
            payload: {
              before: { title: idea.title, details: idea.details, manual: idea.manualScore },
              after: { title: mutation.title, details: mutation.details, manual: mutation.manual },
            },
          },
        ]);
      }
      break;
    }
    case "approveAll": {
      const approvable = await db.idea.findMany({
        where: { workspaceId, batchStatus: { notIn: APPROVAL_EXEMPT } },
      });
      const revert = approvable.every((i) => i.decision !== "pending");
      const targets = approvable.filter((i) =>
        revert ? i.decision === "reviewed" : i.decision === "pending"
      );
      await db.idea.updateMany({
        where: { id: { in: targets.map((i) => i.id) } },
        data: { decision: revert ? "pending" : "reviewed" },
      });
      await logEvents(
        workspaceId,
        targets.map((i) => ({
          ideaId: i.id,
          action: revert ? "unapprove" : "approve",
          payload: { bulk: true },
        }))
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
          ...ticketRows.map((t) => ({ ideaId: idea.id, kind: "zendesk", ticketId: t.id })),
          ...mutation.jira.map((key) => ({ ideaId: idea.id, kind: "jira", jiraKey: key })),
        ],
      });
      // Manually reassigned ticket evidence counts as votes, same as a
      // pipeline match: the this-batch delta follows the zendesk source count.
      const oldZen = idea.sources.filter((s) => s.kind === "zendesk").length;
      const voteDelta = ticketRows.length - oldZen;
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
            before: { zen: toClientIdea(idea).zen, jira: toClientIdea(idea).jira },
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
        else if (i.origin === "jira") next = zenCount > 0 ? "updated" : "unchanged";
        else next = "new";
        if (next !== i.batchStatus) {
          await db.idea.update({ where: { id: i.id }, data: { batchStatus: next } });
        }
      }
      break;
    }
    // A suggested customer (extracted from ticket text, not yet in the
    // catalog) is approved into Settings → Ideas → Customers…
    case "approveCustomer": {
      const idea = await db.idea.findFirst({ where: { id: mutation.ideaId, workspaceId } });
      const name = mutation.name.trim();
      if (idea && name) {
        const exists = await db.customer.findFirst({
          where: { workspaceId, name: { equals: name, mode: "insensitive" } },
          select: { id: true },
        });
        if (!exists) {
          await db.customer.create({ data: { workspaceId, name, description: "" } });
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
              ticket: { select: { id: true, affectedCustomers: true, dismissedCustomers: true } },
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
            data: { dismissedCustomers: [...dismissed, name] as Prisma.InputJsonValue },
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
          sources: { include: { ticket: { select: { id: true, dismissedCustomers: true } } } },
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
          { ideaId: idea.id, action: "undismiss_customer", payload: { name: mutation.name } },
        ]);
      }
      break;
    }
  }

  return getIdeasState(workspaceId);
}

/** Clear imported data. The ledger is deliberately kept — it's the append-only
 *  audit trail and the raw material for determinism statistics. */
export async function clearIdeas(workspaceId: string): Promise<IdeasState> {
  await db.idea.deleteMany({ where: { workspaceId } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId } });
  await db.jiraIdeaSnapshot.deleteMany({ where: { workspaceId } });
  await db.ideaBatch.deleteMany({ where: { workspaceId } });
  return getIdeasState(workspaceId);
}
