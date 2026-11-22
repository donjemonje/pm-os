/**
 * Re-evaluating one capability's row of the coverage model (prompt: reevaluate-prompt.ts): ONE small call to PMOS AI
 * that scores every company of the row again. Asked by a PM's action — reasoning added to a cell, a fixed score
 * released, a feature row added, removed, restored, renamed or re-marked — never by a run.
 *
 *   claimReevaluation   marks the row "re-evaluating" (Capability.reevaluatingAt) and returns the stamp; null when the
 *                       capability is not of the coverage model (no score): there is nothing to re-evaluate.
 *   reevaluateRow       makes the call and applies the answer — only when the stamp is still the row's: a newer
 *                       change started a newer re-evaluation, and only the newest one writes.
 *
 * A score a PM fixed is never written. Every other company gets the new score and reasoning, and its found / not
 * found value follows the score. A failure leaves every score as it was and says why on the row (reevaluateError).
 * Asked by hand, so it reaches PMOS AI also where the test knob COMPETITORS_AI=off stops everything automatic.
 */
import { db } from "../db";
import { callTool } from "./ai";
import { NOT_OWN } from "./own";
import { readRowAnswer, reevaluateTool, renderRow, REEVALUATE_SYSTEM_PROMPT, type RowInput } from "./reevaluate-prompt";
import { valueOfScore } from "./scores";

/** Daniel 2026-11-22: every prompt of the coverage model runs on this model with high thinking. */
export const REEVALUATE_MODEL = "gemini-4-carbon";
/**
 * The answer itself is small (a score and 350 characters per company), but thinking is billed against the same limit and
 * high thinking took more than 24,000 tokens on a row of 7 companies and 5 features (2026-11-22: the call ended
 * "MAX_TOKENS" with an empty answer at 8,000 + the call's headroom). The limit leaves room for it.
 */
const REEVALUATE_MAX_TOKENS = 64_000;

/** Marks the row as being re-evaluated. Null = not a row of the coverage model. */
export async function claimReevaluation(workspaceId: string, capabilityId: string): Promise<Date | null> {
  const at = new Date();
  const done = await db.capability.updateMany({ where: { id: capabilityId, workspaceId, state: { not: "removed" }, ourScore: { not: null } }, data: { reevaluatingAt: at, reevaluateError: null } });
  return done.count ? at : null;
}

/** The row as the prompt takes it, read from the table. Null when the capability is gone. */
export async function loadRow(workspaceId: string, capabilityId: string, orgName: string): Promise<RowInput | null> {
  const cap = await db.capability.findFirst({ where: { id: capabilityId, workspaceId, state: { not: "removed" } }, include: { domain: true, features: { where: { state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }], include: { statuses: true } }, statuses: true } });
  if (!cap) return null;
  const competitors = await db.competitor.findMany({ where: { workspaceId, deletedAt: null, ...NOT_OWN }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true } });
  const cellOf = new Map(cap.statuses.map((s) => [s.competitorId, s]));
  const how = (raw: unknown) => { const d = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).description : null; return typeof d === "string" && d ? d : null; };
  return {
    domain: { name: cap.domain.name, covers: cap.domain.summary || cap.domain.description },
    capability: { name: cap.name, covers: cap.description },
    features: cap.features.map((f) => ({
      name: f.name,
      has: Object.fromEntries([
        ...(f.ourStatus === "found" ? [["own", { how: how(f.ourEvidence) }] as const] : []),
        ...f.statuses.filter((s) => (s.overrideValue ?? s.value) !== "not_found").map((s) => [s.competitorId, { how: s.description }] as const),
      ]),
    })),
    companies: [
      { key: "own", name: orgName, score: cap.ourScore, reasoning: cap.ourScoreReasoning, locked: cap.ourScoreLockedAt != null, note: cap.ourPmReasoning },
      // Only the companies that have a score on this row: a company whose analysis has not run yet (no cell, or a cell
      // of the earlier model) is not scored by a re-evaluation — its own analysis brings it into the row.
      ...competitors.flatMap((c) => { const s = cellOf.get(c.id); return s && s.score != null ? [{ key: c.id, name: c.name, score: s.score, reasoning: s.scoreReasoning, locked: s.scoreLockedAt != null, note: s.pmReasoning }] : []; }),
    ],
  };
}

/**
 * The call and its result. `stamp` is what claimReevaluation returned. `injected` (TEST KNOB) is the raw JSON text the
 * model would have answered: with it no model is called.
 */
export async function reevaluateRow(workspaceId: string, capabilityId: string, orgName: string, stamp: Date, opts: { injected?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const mine = { id: capabilityId, workspaceId, reevaluatingAt: stamp };
  // The reason is for us (the server log and the row's reevaluateError): the page says only that it did not finish.
  const fail = async (error: string) => {
    console.error(`[competitors] re-evaluation of capability ${capabilityId} did not finish: ${error}`);
    await db.capability.updateMany({ where: mine, data: { reevaluatingAt: null, reevaluateError: error.slice(0, 300) } });
    return { ok: false, error };
  };
  try {
    const row = await loadRow(workspaceId, capabilityId, orgName);
    if (!row) return { ok: false, error: "the capability is gone" };
    // An answer that cannot be used (a company left out, a score against the features) is asked for once more; a second one ends the re-evaluation.
    let read = readRowAnswer((await callTool<unknown>(REEVALUATE_SYSTEM_PROMPT, "", renderRow(row), reevaluateTool(row), { model: REEVALUATE_MODEL, maxTokens: REEVALUATE_MAX_TOKENS, thinking: "high", injected: opts.injected })).value, row);
    if (read.problems.length && opts.injected === undefined) {
      console.warn(`[competitors] re-evaluation of capability ${capabilityId}: the answer could not be used (${read.problems.slice(0, 3).join("; ")}) — asked again`);
      read = readRowAnswer((await callTool<unknown>(REEVALUATE_SYSTEM_PROMPT, "", renderRow(row), reevaluateTool(row), { model: REEVALUATE_MODEL, maxTokens: REEVALUATE_MAX_TOKENS, thinking: "high" })).value, row);
    }
    if (read.problems.length) return fail(`PMOS AI's answer could not be used (${read.problems.slice(0, 2).join("; ")})`);
    const applied = await db.$transaction(async (tx) => {
      // Only the newest re-evaluation of the row writes: a newer change claimed the row again while this one was asking.
      const still = await tx.capability.updateMany({ where: mine, data: { reevaluatingAt: null, reevaluateError: null } });
      if (!still.count) return false;
      for (const s of read.scores) {
        if (s.key === "own") {
          await tx.capability.updateMany({ where: { id: capabilityId, workspaceId, ourScoreLockedAt: null }, data: { ourScore: s.score, ourScoreReasoning: s.reasoning, ourStatus: valueOfScore(s.score) } });
          continue;
        }
        const cell = await tx.capabilityStatus.findUnique({ where: { competitorId_capabilityId: { competitorId: s.key, capabilityId } }, select: { id: true, scoreLockedAt: true, value: true } });
        if (!cell || cell.scoreLockedAt) continue;
        const value = valueOfScore(s.score);
        await tx.capabilityStatus.update({ where: { id: cell.id }, data: { score: s.score, scoreReasoning: s.reasoning, value, ...(cell.value !== value ? { changedAt: new Date() } : {}) } });
      }
      return true;
    });
    return { ok: applied };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "PMOS AI could not be reached");
  }
}
