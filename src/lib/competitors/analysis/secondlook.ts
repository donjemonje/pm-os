import { createHash } from "node:crypto";
import { LOOK_VERSION } from "./prompts";

/**
 * The second look, in bulk (Capability Analysis, "How the analysis runs"; Daniel 2026-11-16).
 *
 * It answers the parity question: OUR rows — the capabilities the organization itself has — that a competitor has
 * no item for. Instead of one request per capability, each chunk of the competitor's pages (the same chunks the
 * reading uses, analysis/chunks.ts) is asked ONCE: "which of these does this company offer? quote + page, or
 * nothing", with the rows as a closed set of codes. A row that a chunk shows is not asked about again in the
 * chunks after it. Only after every chunk found nothing does the cell say not found.
 *
 * Rows that are not ours (found only at competitors) are not looked for: a company that has no item for such a
 * row simply does not have it in the table.
 *
 * What decides whether a row is asked again is its key (lookKey): the same question is not asked twice. This file
 * is the keys; the prompt and its parser are analysis/prompts.ts, the database side analysis/steps.ts.
 *
 * Pure: no database, no network.
 */

/**
 * What a row was looked for with. The same key = the same question: it is not asked again. It changes with the
 * prompt version, the model, the row's name, description or aliases, and its domain's name or definition — not
 * with the company's pages: a page that is new or changed is read by the reading step, which lists what it offers
 * and the match puts it on its row; asking every row again for every edited page would read the whole company again
 * after every scan.
 */
export function lookKey(capability: { name: string; description: string; aliases: string[] }, domain: { name: string; description: string }, model: string): string {
  const payload = JSON.stringify([LOOK_VERSION, model, capability.name, capability.description, [...capability.aliases].sort(), domain.name, domain.description]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * What identifies one look of a company in a run: the rows it asks about and the chunks it asks them on. A run
 * that stopped half-way continues after the chunks it already asked only when this is the same — the same rows and
 * the same chunks (their pages and texts); otherwise it starts the look again.
 */
export function lookFingerprint(rowKeys: string[], chunkKeys: string[]): string {
  return createHash("sha256").update(JSON.stringify([[...rowKeys].sort(), chunkKeys])).digest("hex").slice(0, 32);
}

/** How far a look got, as the run's cursor keeps it. */
export interface LookProgress {
  fingerprint: string;
  /** Chunks asked so far. */
  done: number;
}

/** The cursor's record of a look, checked field by field; null for anything that is not one. */
export function readLookProgress(raw: unknown): LookProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fingerprint !== "string" || !r.fingerprint || typeof r.done !== "number" || !Number.isInteger(r.done) || r.done < 0) return null;
  return { fingerprint: r.fingerprint, done: r.done };
}

/** The chunks a continued look still has to ask: all of them, unless the saved progress is of this very look. */
export function chunksLeft(total: number, saved: LookProgress | null, fingerprint: string): { from: number; left: number } {
  const done = saved && saved.fingerprint === fingerprint ? Math.min(saved.done, total) : 0;
  return { from: done, left: total - done };
}
