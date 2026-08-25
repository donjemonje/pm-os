import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * The judgment ledger: an append-only audit log of every LLM judgment the
 * pipeline makes — the exact input, prompt version, model, and verdict.
 * It never short-circuits the model: every run judges fresh, and repeated
 * judgments of the same input land as separate rows sharing a key, which is
 * what makes determinism measurable (group by key, look at the spread).
 *
 * Workspace-scoped: entries contain customer ticket text, so tenant
 * isolation and deletability outrank cross-tenant reuse.
 */

/** Content hash grouping identical judgments; identical key = identical ask. */
export function ledgerKey(
  stage: string,
  promptVersion: string,
  model: string,
  input: unknown
): string {
  const hash = createHash("sha256");
  hash.update(stage);
  hash.update(" ");
  hash.update(promptVersion);
  hash.update(" ");
  hash.update(model);
  hash.update(" ");
  hash.update(JSON.stringify(input));
  return hash.digest("hex");
}

export interface VerdictRecord {
  stage: string;
  promptVersion: string;
  model: string;
  input: unknown;
  verdict: unknown;
}

/** Append one judgment; existing rows are never touched. */
export async function recordVerdict(
  workspaceId: string,
  key: string,
  record: VerdictRecord
): Promise<void> {
  await db.ledgerEntry.create({
    data: {
      workspaceId,
      key,
      stage: record.stage,
      promptVersion: record.promptVersion,
      model: record.model,
      input: record.input as Prisma.InputJsonValue,
      verdict: record.verdict as Prisma.InputJsonValue,
    },
  });
}
