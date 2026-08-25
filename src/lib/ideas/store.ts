import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { catalogTickets } from "./catalog";
import { fetchJiraLiveSources } from "./jira-sync";
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
}

/** A parsed CSV row plus the original record verbatim (the raw store). */
export interface ImportTicketInput {
  key: string;
  subject: string;
  body: string;
  requester?: string;
  tags: string[];
  createdAt?: string;
  productLine?: string;
  raw: Record<string, string>;
}

export interface ImportSummary {
  imported: number;
  frs: number;
  bugs: number;
  needsDetails: number;
  duplicates: number;
  called: number;
  jiraConnected: boolean;
  jiraCount: number;
}

const APPROVAL_EXEMPT = ["deleted", "unchanged"];

type TicketRow = Prisma.ZendeskTicketRawGetPayload<Record<string, never>>;
type IdeaRow = Prisma.IdeaGetPayload<{
  include: { sources: { include: { ticket: { select: { externalId: true } } } } };
}>;

function toClientTicket(row: TicketRow): ZendeskTicket {
  return {
    key: row.externalId,
    id: row.externalId,
    subject: row.subject,
    body: row.body,
    requester: row.requester ?? undefined,
    tags: (row.tags as string[]) ?? [],
    createdAt: row.sourceCreatedAt ?? undefined,
    productLine: row.productLine ?? undefined,
    catalog: row.catalogKind
      ? { kind: row.catalogKind as CatalogKind, reason: row.catalogReason ?? "" }
      : null,
  };
}

function toClientIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    products: (row.products as string[]) ?? [],
    platforms: (row.platforms as string[]) ?? [],
    batch: row.batchStatus as Idea["batch"],
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
  const [ticketRows, snapshotRows, ideaRows] = await Promise.all([
    db.zendeskTicketRaw.findMany({
      where: { workspaceId },
      orderBy: [{ importedAt: "asc" }, { id: "asc" }],
    }),
    db.jiraIdeaSnapshot.findMany({ where: { workspaceId }, orderBy: { key: "asc" } }),
    db.idea.findMany({
      where: { workspaceId },
      include: { sources: { include: { ticket: { select: { externalId: true } } } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
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
  };
}

/**
 * One import: dedupe against the raw store, catalog the new tickets (only
 * FRs become ideas), then resync Jira live state (Jira-origin ideas are
 * replaced wholesale, entering as Unchanged).
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

  // LLM judgments happen before any DB writes — the ledger records each
  // verdict as it lands, so a failure here loses nothing.
  const catalog = await catalogTickets(
    workspaceId,
    fresh.map(({ key, subject, body, tags }) => ({ key, subject, body, tags }))
  );
  const verdictByKey = new Map(catalog.results.map((v) => [v.key, v]));

  const batch = await db.ideaBatch.create({ data: { workspaceId } });

  let frs = 0;
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
      // Model assignment wins; the CSV product_line column is only a fallback
      // when the model returned nothing at all.
      const products =
        verdict.productLines.length > 0
          ? verdict.productLines
          : input.productLine
            ? [input.productLine]
            : ["Other"];
      await db.idea.create({
        data: {
          workspaceId,
          title: input.subject,
          details: input.body,
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

  // Jira live state — replace snapshots and Jira-origin ideas wholesale.
  const jira = await fetchJiraLiveSources(workspaceId);
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
    await db.idea.deleteMany({ where: { workspaceId, origin: "jira" } });
    for (const s of jira.sources) {
      await db.idea.create({
        data: {
          workspaceId,
          title: s.title,
          details: s.body,
          products: s.products as Prisma.InputJsonValue,
          batchStatus: "unchanged",
          decision: "pending",
          origin: "jira",
          sources: { create: [{ kind: "jira", jiraKey: s.key }] },
        },
      });
    }
  }

  const summary: ImportSummary = {
    imported: fresh.length,
    frs,
    bugs,
    needsDetails,
    duplicates,
    called: catalog.called,
    jiraConnected: jira.connected,
    jiraCount: jira.sources.length,
  };
  await db.ideaBatch.update({
    where: { id: batch.id },
    data: { completedAt: new Date(), stats: summary as unknown as Prisma.InputJsonValue },
  });

  return { summary, state: await getIdeasState(workspaceId) };
}

export type IdeasMutation =
  | { type: "decision"; ideaId: string; decision: "pending" | "reviewed" }
  | { type: "edit"; ideaId: string; title: string; details: string; manual: number | null }
  | { type: "approveAll" }
  | { type: "inject" }
  | { type: "reassign"; ideaId: string; zen: string[]; jira: string[] };

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
    case "inject": {
      const reviewed = await db.idea.findMany({
        where: { workspaceId, decision: "reviewed" },
      });
      await db.idea.updateMany({
        where: { id: { in: reviewed.map((i) => i.id) } },
        data: { decision: "injected" },
      });
      await logEvents(
        workspaceId,
        reviewed.map((i) => ({ ideaId: i.id, action: "inject" }))
      );
      break;
    }
    case "reassign": {
      const idea = await db.idea.findFirst({
        where: { id: mutation.ideaId, workspaceId },
        include: { sources: { include: { ticket: { select: { externalId: true } } } } },
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
