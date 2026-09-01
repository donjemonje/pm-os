import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  deleteJiraComment,
  deleteJiraIssue,
  fetchIssuesRaw,
  updateJiraIssue,
} from "../jira";
import {
  normText,
  readMultiSelect,
  readNumber,
  readSingleSelect,
  type PushUndoPayload,
  type UndoFieldSnap,
} from "./push";
import { getIdeasState, type IdeasState } from "./store";

/**
 * Per-idea undo of the LAST merge to Jira (feature-flagged: "ideasUndo").
 *
 * Semantics:
 * - Update: each field is restored ONLY while Jira still holds exactly what
 *   the merge wrote — a value a human changed since is left alone and
 *   reported as a warning, never clobbered. The merge's update comment is
 *   deleted.
 * - Create: the created issue is DELETED (permanent in Jira Cloud — the
 *   client confirms before calling), and the idea's Jira link and origin are
 *   restored.
 * - Either way the idea flips back from "injected" to "reviewed", the
 *   reversal is logged as a ReviewEvent, and the snapshot row is consumed —
 *   undo is once per idea per merge.
 */
export async function undoIdeaPush(
  workspaceId: string,
  ideaId: string
): Promise<
  | { ok: false; error: string }
  | { ok: true; warnings: string[]; jiraKey: string; action: "create" | "update"; state: IdeasState }
> {
  const record = await db.ideasPushUndo.findFirst({ where: { ideaId, workspaceId } });
  if (!record) {
    return { ok: false, error: "Nothing to undo — only the last merge is undoable." };
  }
  const payload = record.payload as unknown as PushUndoPayload;
  const warnings: string[] = [];

  if (record.action === "create") {
    try {
      await deleteJiraIssue(workspaceId, record.jiraKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      // Already gone is fine — the goal state is "no issue".
      if (!message.includes("(404)")) {
        return { ok: false, error: `Could not delete ${record.jiraKey}: ${message}` };
      }
    }
    await db.ideaSource.deleteMany({
      where: { ideaId, kind: "jira", jiraKey: record.jiraKey },
    });
    await db.idea.update({
      where: { id: ideaId },
      data: { decision: "reviewed", origin: payload.beforeOrigin ?? "zendesk" },
    });
  } else {
    // Refetch live state; restore only fields still holding our write.
    const fieldIds = Object.keys(payload.fields);
    const [live] = await fetchIssuesRaw(workspaceId, [record.jiraKey], fieldIds);
    if (!live) {
      return { ok: false, error: `${record.jiraKey} no longer exists in Jira — nothing to restore.` };
    }

    const write: {
      summary?: string;
      descriptionAdf?: unknown;
      extraFields?: Record<string, unknown>;
    } = {};
    const extraFields: Record<string, unknown> = {};

    if (payload.summary) {
      if (live.summary === payload.summary.after) write.summary = payload.summary.before;
      else warnings.push(`Summary was edited in Jira after the merge — left as is.`);
    }
    if (payload.description) {
      if (normText(live.descriptionText) === payload.description.afterTextNorm) {
        // Restoring a previously-empty description writes an empty doc.
        write.descriptionAdf = payload.description.beforeAdf ?? {
          type: "doc",
          version: 1,
          content: [],
        };
      } else {
        warnings.push(`Description was edited in Jira after the merge — left as is.`);
      }
    }
    for (const [fieldId, snap] of Object.entries(payload.fields)) {
      const s = snap as UndoFieldSnap;
      const cur = live.extra[fieldId];
      if (s.kind === "number") {
        if (readNumber(cur) === s.after) extraFields[fieldId] = s.before ?? 0;
        else warnings.push(`A number field changed in Jira after the merge — left as is.`);
      } else if (s.kind === "single") {
        if (readSingleSelect(cur) === s.after) extraFields[fieldId] = null;
        else warnings.push(`A select field changed in Jira after the merge — left as is.`);
      } else {
        const now = readMultiSelect(cur);
        const wrote = (s.after as string[]) ?? [];
        const same =
          now.length === wrote.length &&
          now.every((v) => wrote.some((w) => w.toLowerCase() === v.toLowerCase()));
        if (same) {
          extraFields[fieldId] = ((s.before as string[]) ?? []).map((value) => ({ value }));
        } else {
          warnings.push(`A multi-select field changed in Jira after the merge — left as is.`);
        }
      }
    }
    if (Object.keys(extraFields).length > 0) write.extraFields = extraFields;

    if (write.summary !== undefined || write.descriptionAdf !== undefined || write.extraFields) {
      await updateJiraIssue(workspaceId, record.jiraKey, write);
    }
    if (record.commentId) {
      try {
        await deleteJiraComment(workspaceId, record.jiraKey, record.commentId);
      } catch {
        warnings.push("The merge's update comment could not be deleted — remove it in Jira.");
      }
    }
    await db.idea.update({ where: { id: ideaId }, data: { decision: "reviewed" } });
  }

  await db.reviewEvent.create({
    data: {
      workspaceId,
      ideaId,
      action: "undo_push",
      payload: {
        jiraAction: record.action,
        jiraKey: record.jiraKey,
        skipped: warnings,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await db.ideasPushUndo.delete({ where: { id: record.id } });

  return {
    ok: true,
    warnings,
    jiraKey: record.jiraKey,
    action: record.action as "create" | "update",
    state: await getIdeasState(workspaceId),
  };
}
