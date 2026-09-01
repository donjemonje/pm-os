import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  addJiraCommentAdf,
  createJiraIssue,
  fetchIssuesRaw,
  getCreateMetaFields,
  getEditMetaFields,
  getJiraConnectionStatus,
  listAllFields,
  textToAdf,
  updateJiraIssue,
  type JiraFieldMeta,
} from "../jira";
import {
  ATTRIBUTE_LABELS,
  MAPPED_ATTRIBUTES,
  mergeIdeasJiraConfig,
  type IdeasJiraConfig,
  type MappedAttribute,
} from "./jira-mapping";
import { getIdeasState, type IdeasState } from "./store";

/** The workspace's stored output config merged over defaults. */
async function getIdeasJiraConfig(workspaceId: string): Promise<IdeasJiraConfig> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { ideasConfig: true },
  });
  return mergeIdeasJiraConfig(workspace?.ideasConfig);
}

/**
 * Write-back of reviewed ideas to Jira ("Merge to Jira").
 *
 * Output semantics (Daniel, 2026-09-01 — all configurable in Admin → Ideas,
 * see jira-mapping.ts):
 * - Description is OVERWRITTEN with PM-OS details, then a gap, then a
 *   "Supported Tickets:" numbered list (reporter: title, link).
 * - Votes / Product Line / Customers / P_Components are custom Jira fields.
 *   Votes increments; single-select is set only when empty; multi-selects
 *   are add-only unions. Option values that don't exist in Jira are skipped
 *   with a visible warning — Jira rejects unknown options.
 * - Every update gets a "#update from @PM-OS" comment listing affected fields.
 *
 * Safety rules:
 * - Plan-then-write: execute re-derives the plan server-side and writes
 *   exactly that. Blockers refuse the run before any write.
 * - Per-issue idempotency: each success is recorded before the next write;
 *   failures stay reviewed and are retryable without double-creating.
 */

// ————— helpers —————

/** Union of string lists, first occurrence wins on casing, insertion order kept. */
function distinct(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (v && !seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values());
}

export function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Idea in scope = any of its product lines is selected (null scope = all). */
export function inScope(products: string[], scope: string[] | null): boolean {
  if (!scope || scope.length === 0) return true;
  const wanted = new Set(scope.map((s) => s.toLowerCase()));
  return products.some((p) => wanted.has(p.toLowerCase()));
}

// ————— description (details + Supported Tickets block) —————

interface TicketRef {
  id: string;
  requester: string | null;
  subject: string;
}

function ticketUrl(config: IdeasJiraConfig, id: string): string | null {
  if (!config.zendeskTicketUrlTemplate) return null;
  return config.zendeskTicketUrlTemplate.replace("{id}", encodeURIComponent(id));
}

/** The full new description as ADF plus its plain-text twin (for diffing). */
function buildDescription(
  config: IdeasJiraConfig,
  details: string,
  tickets: TicketRef[]
): { adf: unknown; text: string } {
  const content: unknown[] = [...(textToAdf(details.trimEnd()).content as unknown[])];
  const textLines: string[] = [details.trimEnd()];

  if (tickets.length > 0) {
    for (let i = 0; i < config.descriptionGapLines; i++) {
      content.push({ type: "paragraph", content: [] });
    }
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: config.supportedTicketsHeading, marks: [{ type: "strong" }] },
      ],
    });
    content.push({
      type: "orderedList",
      attrs: { order: 1 },
      content: tickets.map((t) => {
        const url = ticketUrl(config, t.id);
        const lead = `${t.requester || "Unknown reporter"}: ${t.subject}`;
        const inline: unknown[] = [{ type: "text", text: url ? `${lead}, ` : `${lead} (ticket ${t.id})` }];
        if (url) {
          inline.push({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] });
        }
        return { type: "listItem", content: [{ type: "paragraph", content: inline }] };
      }),
    });
    textLines.push(config.supportedTicketsHeading);
    tickets.forEach((t, i) => {
      const url = ticketUrl(config, t.id);
      textLines.push(
        `${i + 1}. ${t.requester || "Unknown reporter"}: ${t.subject}${url ? `, ${url}` : ` (ticket ${t.id})`}`
      );
    });
  }

  return { adf: { type: "doc", version: 1, content }, text: textLines.join("\n") };
}

// ————— custom-field value plumbing —————

/** Current value of a select/number custom field from the raw issue payload. */
export function readSingleSelect(v: unknown): string | null {
  if (v && typeof v === "object" && "value" in v) return String((v as { value: unknown }).value ?? "") || null;
  return null;
}
export function readMultiSelect(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((o) => (o && typeof o === "object" && "value" in o ? String((o as { value: unknown }).value ?? "") : ""))
    .filter(Boolean);
}
export function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Split wanted option values into allowed / rejected per Jira's own list. */
function filterAllowed(
  wanted: string[],
  meta: JiraFieldMeta | undefined
): { allowed: string[]; rejected: string[] } {
  if (!meta?.allowedValues) return { allowed: [], rejected: wanted };
  const ok = new Map(meta.allowedValues.map((v) => [v.toLowerCase(), v]));
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const w of wanted) {
    const hit = ok.get(w.toLowerCase());
    if (hit) allowed.push(hit);
    else rejected.push(w);
  }
  return { allowed, rejected };
}

// ————— plan types —————

export interface PushFieldChange {
  field: string;
  /** Display name, e.g. "Product Line" — also used in the update comment. */
  label: string;
  from: string;
  to: string;
}

export interface PushPlanItem {
  ideaId: string;
  action: "create" | "update";
  title: string;
  jiraKey: string | null;
  url: string | null;
  votes: number;
  newVotes: number;
  changes: PushFieldChange[];
  /** Update with nothing left to write — marked injected, no Jira call. */
  noop: boolean;
  projectKey: string;
}

export interface PushPlan {
  target: { projectKey: string; issueType: string } | null;
  items: PushPlanItem[];
  /** Non-blocking issues: unknown Jira fields, option values Jira doesn't
   *  have yet, fields not on the screen. The write skips exactly these. */
  warnings: string[];
  skipped: { ideaId: string; title: string; reason: string }[];
  blockers: string[];
  scope: string[] | null;
  pendingInScope: number;
}

export interface PushResult {
  ideaId: string;
  title: string;
  ok: boolean;
  action: "create" | "update" | "none";
  jiraKey: string | null;
  url: string | null;
  error?: string;
}

const APPROVAL_EXEMPT = ["deleted", "unchanged"];

const PUSH_INCLUDE = {
  sources: {
    include: {
      ticket: {
        select: {
          externalId: true,
          subject: true,
          requester: true,
          affectedCustomers: true,
          dismissedCustomers: true,
        },
      },
    },
  },
} as const;
type PushIdeaRow = Prisma.IdeaGetPayload<{ include: typeof PUSH_INCLUDE }>;

/** One written custom field's before/after, captured for per-idea undo. */
export interface UndoFieldSnap {
  kind: "number" | "single" | "multi";
  /** number → previous number; single → always null (set-if-empty); multi → previous option values. */
  before: number | string[] | null;
  /** Exactly what the push wrote — undo restores only while Jira still holds this. */
  after: number | string | string[];
}

/** Everything a per-idea undo of the last merge needs; stored in IdeasPushUndo.payload. */
export interface PushUndoPayload {
  summary?: { before: string; after: string };
  description?: { beforeAdf: unknown; afterTextNorm: string };
  /** Keyed by Jira field id. */
  fields: Record<string, UndoFieldSnap>;
  /** Creates only: the origin the push flipped to "jira". */
  beforeOrigin?: string;
}

interface UpdateWrite {
  jiraKey: string;
  summary?: string;
  descriptionAdf?: unknown;
  extraFields?: Record<string, unknown>;
  commentLabels: string[];
  undo: PushUndoPayload;
}
interface CreateWrite {
  summary: string;
  descriptionAdf: unknown;
  extraFields: Record<string, unknown>;
  /** Idea.origin before markInjected flips it — restored on undo. */
  beforeOrigin: string;
}
interface PushWrites {
  creates: Map<string, CreateWrite>;
  updates: Map<string, UpdateWrite>;
}

function ideaCustomers(row: PushIdeaRow): string[] {
  const tickets = row.sources.flatMap((s) => (s.kind === "zendesk" && s.ticket ? [s.ticket] : []));
  const dismissed = new Set(
    tickets.flatMap((t) => ((t.dismissedCustomers as string[]) ?? []).map((c) => c.toLowerCase()))
  );
  return distinct(tickets.flatMap((t) => (t.affectedCustomers as string[]) ?? [])).filter(
    (c) => !dismissed.has(c.toLowerCase())
  );
}

function ideaTickets(row: PushIdeaRow): TicketRef[] {
  return row.sources.flatMap((s) =>
    s.kind === "zendesk" && s.ticket
      ? [{ id: s.ticket.externalId, requester: s.ticket.requester, subject: s.ticket.subject }]
      : []
  );
}

function ideaJiraKey(row: PushIdeaRow): string | null {
  return row.sources.find((s) => s.kind === "jira" && s.jiraKey)?.jiraKey ?? null;
}

// ————— plan —————

async function derivePlan(
  workspaceId: string,
  scope: string[] | null
): Promise<{ plan: PushPlan; writes: PushWrites; config: IdeasJiraConfig }> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const items: PushPlanItem[] = [];
  const skipped: PushPlan["skipped"] = [];
  const writes: PushWrites = { creates: new Map(), updates: new Map() };
  const config = await getIdeasJiraConfig(workspaceId);

  const status = await getJiraConnectionStatus(workspaceId);
  if (!status?.connected) {
    return {
      plan: {
        target: null,
        items,
        warnings,
        skipped,
        blockers: ["Jira is not connected — connect it in Settings → Integrations."],
        scope,
        pendingInScope: 0,
      },
      writes,
      config,
    };
  }

  const targetProject =
    status.ideasProjectKey ?? (status.projectKeys.length === 1 ? status.projectKeys[0] : null);
  const target = targetProject
    ? { projectKey: targetProject, issueType: status.ideasIssueType || "Story" }
    : null;

  const rows = await db.idea.findMany({
    where: { workspaceId, batchStatus: { not: "deleted" } },
    include: PUSH_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const scoped = rows.filter((r) => inScope((r.products as string[]) ?? [], scope));
  // Pending ideas never block a merge — only approved ones go.
  const pendingInScope = scoped.filter(
    (r) => !APPROVAL_EXEMPT.includes(r.batchStatus) && r.decision === "pending"
  ).length;

  const candidates = scoped.filter((r) => r.decision === "reviewed");
  const updates: PushIdeaRow[] = [];
  const creates: PushIdeaRow[] = [];
  for (const row of candidates) {
    if (row.batchStatus === "archive") {
      skipped.push({
        ideaId: row.id,
        title: row.title,
        reason: "Archive proposals aren't written to Jira yet — the idea stays approved here.",
      });
      continue;
    }
    if (ideaJiraKey(row)) updates.push(row);
    else creates.push(row);
  }

  if (candidates.length === 0) {
    blockers.push("Nothing approved in the selected product lines.");
  }
  if (creates.length > 0 && !target) {
    blockers.push(
      "Pick which Jira project new ideas are created in (Settings → Integrations → Jira)."
    );
  }
  if (creates.length > 0 && target && !status.projectKeys.includes(target.projectKey)) {
    blockers.push(
      `Ideas target project ${target.projectKey} is not in the connected project list — the next import would not see created issues. Fix it in Settings → Integrations → Jira.`
    );
  }
  if (blockers.length > 0) {
    return {
      plan: { target, items, warnings, skipped, blockers, scope, pendingInScope },
      writes,
      config,
    };
  }

  // Resolve the configured Jira fields (by display name) to field ids once.
  const enabledAttrs = MAPPED_ATTRIBUTES.filter((a) => config.fields[a].enabled);
  let fieldIdByAttr = new Map<MappedAttribute, string>();
  try {
    const allFields = await listAllFields(workspaceId);
    fieldIdByAttr = new Map(
      enabledAttrs.flatMap((attr) => {
        const hit = allFields.get(config.fields[attr].jiraField.toLowerCase());
        if (!hit) {
          warnings.push(
            `Jira field "${config.fields[attr].jiraField}" (${ATTRIBUTE_LABELS[attr]}) not found on this Jira site — skipped. Fix the name in Admin → Ideas.`
          );
          return [];
        }
        return [[attr, hit.id] as const];
      })
    );
  } catch (err) {
    blockers.push(
      `Could not read Jira's field list: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return {
      plan: { target, items, warnings, skipped, blockers, scope, pendingInScope },
      writes,
      config,
    };
  }
  const extraFieldIds = Array.from(fieldIdByAttr.values());

  // Live state for updates — diffs run against Jira right now, not a snapshot.
  let liveByKey = new Map<string, Awaited<ReturnType<typeof fetchIssuesRaw>>[number]>();
  if (updates.length > 0) {
    const keys = updates.map((r) => ideaJiraKey(r)!) as string[];
    try {
      const live = await fetchIssuesRaw(workspaceId, keys, extraFieldIds);
      liveByKey = new Map(live.map((i) => [i.key, i]));
    } catch (err) {
      blockers.push(
        `Could not read the live state of ${keys.length} Jira issue${keys.length === 1 ? "" : "s"}: ${err instanceof Error ? err.message : "unknown error"}`
      );
      return {
        plan: { target, items, warnings, skipped, blockers, scope, pendingInScope },
        writes,
        config,
      };
    }
  }

  // ——— updates ———
  for (const row of updates) {
    const key = ideaJiraKey(row)!;
    const live = liveByKey.get(key);
    if (!live) {
      skipped.push({
        ideaId: row.id,
        title: row.title,
        reason: `${key} no longer exists in Jira — re-import to resync before merging.`,
      });
      continue;
    }

    // Which fields Jira lets us edit on this issue (with allowed options).
    let editMeta = new Map<string, JiraFieldMeta>();
    try {
      editMeta = await getEditMetaFields(workspaceId, key);
    } catch (err) {
      warnings.push(
        `Could not read edit metadata of ${key}: ${err instanceof Error ? err.message : "unknown error"} — custom fields skipped for it.`
      );
    }

    const votes = row.existingVotes + row.newVotes;
    const changes: PushFieldChange[] = [];
    const extraFields: Record<string, unknown> = {};
    const undoFields: Record<string, UndoFieldSnap> = {};
    const write: UpdateWrite = { jiraKey: key, commentLabels: [], undo: { fields: undoFields } };

    if (row.title !== live.summary) {
      changes.push({ field: "summary", label: ATTRIBUTE_LABELS.summary, from: live.summary, to: row.title });
      write.summary = row.title;
      write.undo.summary = { before: live.summary, after: row.title };
    }

    const desc = buildDescription(config, row.details, ideaTickets(row));
    if (normText(desc.text) !== normText(live.descriptionText)) {
      changes.push({
        field: "description",
        label: ATTRIBUTE_LABELS.description,
        from: "(replaced)",
        to: desc.text,
      });
      write.descriptionAdf = desc.adf;
      write.undo.description = { beforeAdf: live.descriptionAdf, afterTextNorm: normText(desc.text) };
    }

    const attrValue = (attr: MappedAttribute, fieldId: string): PushFieldChange | null => {
      const mapping = config.fields[attr];
      const meta = editMeta.get(fieldId);
      if (editMeta.size > 0 && !meta) {
        warnings.push(
          `${key}: Jira field "${mapping.jiraField}" is not on the issue's edit screen — skipped.`
        );
        return null;
      }
      if (mapping.type === "number" && mapping.policy === "increment") {
        if (row.newVotes <= 0) return null;
        const cur = readNumber(live.extra[fieldId]);
        extraFields[fieldId] = cur + row.newVotes;
        undoFields[fieldId] = { kind: "number", before: cur, after: cur + row.newVotes };
        return {
          field: attr,
          label: ATTRIBUTE_LABELS[attr],
          from: String(cur),
          to: String(cur + row.newVotes),
        };
      }
      if (mapping.type === "single_select") {
        const cur = readSingleSelect(live.extra[fieldId]);
        // Set-if-empty: a value a human chose is never replaced.
        if (cur) return null;
        const wanted = ((row.products as string[]) ?? []).filter((p) => p !== "Other");
        if (wanted.length === 0) return null;
        const { allowed, rejected } = filterAllowed([wanted[0]], meta);
        if (rejected.length > 0) {
          warnings.push(
            `${key}: "${rejected[0]}" is not an option of Jira field "${mapping.jiraField}" — add it in Jira, then re-merge.`
          );
        }
        if (allowed.length === 0) return null;
        extraFields[fieldId] = { value: allowed[0] };
        undoFields[fieldId] = { kind: "single", before: null, after: allowed[0] };
        return { field: attr, label: ATTRIBUTE_LABELS[attr], from: "(empty)", to: allowed[0] };
      }
      // multi_select union
      const cur = readMultiSelect(live.extra[fieldId]);
      const wanted =
        attr === "customers"
          ? ideaCustomers(row)
          : ((row.platforms as string[]) ?? []).filter(Boolean);
      const missing = wanted.filter((w) => !cur.some((c) => c.toLowerCase() === w.toLowerCase()));
      if (missing.length === 0) return null;
      const { allowed, rejected } = filterAllowed(missing, meta);
      if (rejected.length > 0) {
        warnings.push(
          `${key}: ${rejected.map((r) => `"${r}"`).join(", ")} ${rejected.length === 1 ? "is not an option" : "are not options"} of Jira field "${mapping.jiraField}" — add ${rejected.length === 1 ? "it" : "them"} in Jira, then re-merge.`
        );
      }
      if (allowed.length === 0) return null;
      const next = distinct([...cur, ...allowed]);
      extraFields[fieldId] = next.map((value) => ({ value }));
      undoFields[fieldId] = { kind: "multi", before: cur, after: next };
      return {
        field: attr,
        label: ATTRIBUTE_LABELS[attr],
        from: cur.join(", ") || "(none)",
        to: next.join(", "),
      };
    };

    for (const [attr, fieldId] of fieldIdByAttr) {
      const change = attrValue(attr, fieldId);
      if (change) changes.push(change);
    }

    if (Object.keys(extraFields).length > 0) write.extraFields = extraFields;
    write.commentLabels = changes.map((c) => c.label);
    const noop = changes.length === 0;
    if (!noop) writes.updates.set(row.id, write);
    items.push({
      ideaId: row.id,
      action: "update",
      title: row.title,
      jiraKey: key,
      url: `${status.siteUrl}/browse/${key}`,
      votes,
      newVotes: row.newVotes,
      changes,
      noop,
      projectKey: key.split("-")[0],
    });
  }

  // ——— creates ———
  let createMeta = new Map<string, JiraFieldMeta>();
  if (creates.length > 0 && target) {
    try {
      createMeta = await getCreateMetaFields(workspaceId, target.projectKey, target.issueType);
    } catch (err) {
      warnings.push(
        `Could not read create metadata of ${target.projectKey}: ${err instanceof Error ? err.message : "unknown error"} — custom fields skipped for new issues.`
      );
    }
  }

  for (const row of creates) {
    const votes = row.existingVotes + row.newVotes;
    const desc = buildDescription(config, row.details, ideaTickets(row));
    const changes: PushFieldChange[] = [
      { field: "summary", label: ATTRIBUTE_LABELS.summary, from: "", to: row.title },
      { field: "description", label: ATTRIBUTE_LABELS.description, from: "", to: desc.text },
    ];
    const extraFields: Record<string, unknown> = {};

    for (const [attr, fieldId] of fieldIdByAttr) {
      const mapping = config.fields[attr];
      const meta = createMeta.get(fieldId);
      if (createMeta.size > 0 && !meta) {
        warnings.push(
          `New issues: Jira field "${mapping.jiraField}" is not on the create screen of ${target?.projectKey} — skipped.`
        );
        continue;
      }
      if (mapping.type === "number") {
        if (votes > 0) {
          extraFields[fieldId] = votes;
          changes.push({ field: attr, label: ATTRIBUTE_LABELS[attr], from: "", to: String(votes) });
        }
        continue;
      }
      const wanted =
        attr === "productLine"
          ? ((row.products as string[]) ?? []).filter((p) => p !== "Other").slice(0, 1)
          : attr === "customers"
            ? ideaCustomers(row)
            : ((row.platforms as string[]) ?? []).filter(Boolean);
      if (wanted.length === 0) continue;
      const { allowed, rejected } = filterAllowed(wanted, meta);
      if (rejected.length > 0) {
        warnings.push(
          `"${row.title}": ${rejected.map((r) => `"${r}"`).join(", ")} not available in Jira field "${mapping.jiraField}" — add the option${rejected.length === 1 ? "" : "s"} in Jira, then re-merge.`
        );
      }
      if (allowed.length === 0) continue;
      if (mapping.type === "single_select") {
        extraFields[fieldId] = { value: allowed[0] };
        changes.push({ field: attr, label: ATTRIBUTE_LABELS[attr], from: "", to: allowed[0] });
      } else {
        extraFields[fieldId] = allowed.map((value) => ({ value }));
        changes.push({ field: attr, label: ATTRIBUTE_LABELS[attr], from: "", to: allowed.join(", ") });
      }
    }

    writes.creates.set(row.id, {
      summary: row.title,
      descriptionAdf: desc.adf,
      extraFields,
      beforeOrigin: row.origin,
    });
    items.push({
      ideaId: row.id,
      action: "create",
      title: row.title,
      jiraKey: null,
      url: null,
      votes,
      newVotes: row.newVotes,
      changes,
      noop: false,
      projectKey: target?.projectKey ?? "",
    });
  }

  return {
    plan: { target, items, warnings, skipped, blockers, scope, pendingInScope },
    writes,
    config,
  };
}

export async function buildPushPlan(
  workspaceId: string,
  scope: string[] | null
): Promise<PushPlan> {
  const { plan } = await derivePlan(workspaceId, scope);
  return plan;
}

// ————— execute —————

function buildUpdateComment(config: IdeasJiraConfig, labels: string[]): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: config.commentPrefix }] },
      {
        type: "bulletList",
        content: distinct(labels).map((label) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
        })),
      },
    ],
  };
}

export async function executePush(
  workspaceId: string,
  scope: string[] | null
): Promise<
  | { ok: false; blockers: string[] }
  | { ok: true; results: PushResult[]; state: IdeasState }
> {
  // The plan is re-derived server-side — the client preview is display only.
  const { plan, writes, config } = await derivePlan(workspaceId, scope);
  if (plan.blockers.length > 0) return { ok: false, blockers: plan.blockers };

  // Only the LAST merge is undoable — this run's snapshots replace the
  // previous batch's wholesale.
  await db.ideasPushUndo.deleteMany({ where: { workspaceId } });

  const results: PushResult[] = [];
  const recordUndo = async (
    ideaId: string,
    action: "create" | "update",
    jiraKey: string,
    payload: PushUndoPayload,
    commentId: string | null
  ) => {
    await db.ideasPushUndo.create({
      data: {
        workspaceId,
        ideaId,
        action,
        jiraKey,
        payload: payload as unknown as Prisma.InputJsonValue,
        commentId,
      },
    });
  };
  const markInjected = async (
    ideaId: string,
    payload: Prisma.InputJsonValue,
    alsoJiraSource?: string
  ) => {
    await db.idea.update({
      where: { id: ideaId },
      data: {
        decision: "injected",
        // A created issue now lives in Jira: flip origin so the next import's
        // resync upserts it by key instead of duplicating it.
        ...(alsoJiraSource
          ? { origin: "jira", sources: { create: [{ kind: "jira", jiraKey: alsoJiraSource }] } }
          : {}),
      },
    });
    await db.reviewEvent.create({
      data: { workspaceId, ideaId, action: "inject", payload },
    });
  };

  for (const item of plan.items) {
    try {
      if (item.action === "update") {
        const write = writes.updates.get(item.ideaId);
        if (!write) {
          // No-op update: Jira already reflects everything — record it.
          await markInjected(item.ideaId, { jiraAction: "none", jiraKey: item.jiraKey });
          results.push({
            ideaId: item.ideaId,
            title: item.title,
            ok: true,
            action: "none",
            jiraKey: item.jiraKey,
            url: item.url,
          });
          continue;
        }
        const { jiraKey, commentLabels, undo, ...fields } = write;
        await updateJiraIssue(workspaceId, jiraKey, fields);
        let commentNote: string | undefined;
        let commentId: string | null = null;
        if (config.updateComment && commentLabels.length > 0) {
          try {
            commentId = (
              await addJiraCommentAdf(workspaceId, jiraKey, buildUpdateComment(config, commentLabels))
            ).id;
          } catch (err) {
            // The update itself succeeded — say so, don't fail the item.
            commentNote = `Updated, but the comment failed: ${err instanceof Error ? err.message : "unknown error"}`;
          }
        }
        await recordUndo(item.ideaId, "update", jiraKey, undo, commentId);
        await markInjected(item.ideaId, {
          jiraAction: "update",
          jiraKey,
          fields: item.changes.map((c) => c.label),
        } as unknown as Prisma.InputJsonValue);
        results.push({
          ideaId: item.ideaId,
          title: item.title,
          ok: true,
          action: "update",
          jiraKey,
          url: item.url,
          error: commentNote,
        });
      } else {
        const write = writes.creates.get(item.ideaId);
        if (!write || !plan.target) continue;
        const { key } = await createJiraIssue(workspaceId, {
          projectKey: plan.target.projectKey,
          issueTypeName: plan.target.issueType,
          summary: write.summary,
          descriptionAdf: write.descriptionAdf,
          extraFields: write.extraFields,
        });
        await recordUndo(
          item.ideaId,
          "create",
          key,
          { fields: {}, beforeOrigin: write.beforeOrigin },
          null
        );
        await markInjected(
          item.ideaId,
          { jiraAction: "create", jiraKey: key } as unknown as Prisma.InputJsonValue,
          key
        );
        results.push({
          ideaId: item.ideaId,
          title: item.title,
          ok: true,
          action: "create",
          jiraKey: key,
          url: null,
        });
      }
    } catch (err) {
      // The idea stays reviewed — rerunning the merge retries exactly the
      // failed writes and nothing else.
      results.push({
        ideaId: item.ideaId,
        title: item.title,
        ok: false,
        action: item.action,
        jiraKey: item.jiraKey,
        url: item.url,
        error: err instanceof Error ? err.message : "Write failed",
      });
    }
  }

  return { ok: true, results, state: await getIdeasState(workspaceId) };
}
