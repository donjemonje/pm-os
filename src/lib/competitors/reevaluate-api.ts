/**
 * What the routes share to re-evaluate a capability's row after a PM's change (reevaluate.ts): claim the row, answer
 * the request at once, and make the one call to PMOS AI after the answer. The page shows "re-evaluating" from the
 * state the route returns and keeps asking for the state until the row is done.
 */
import { after } from "next/server";
import type { CompetitorsApiContext } from "./api";
import { claimReevaluation, reevaluateRow } from "./reevaluate";
import { testKnobsEnabled } from "./settings";

/**
 * Starts the re-evaluation of the capability's row. False when the capability is not of the coverage model (it has no
 * score): nothing to do. TEST KNOB: with test knobs on, `body.testAnswer` (the raw JSON text PMOS AI would have
 * answered) is used instead of a model call.
 */
export async function reevaluateAfter(ctx: CompetitorsApiContext, capabilityId: string, body?: Record<string, unknown>): Promise<boolean> {
  const stamp = await claimReevaluation(ctx.workspaceId, capabilityId);
  if (!stamp) return false;
  const injected = testKnobsEnabled() && typeof body?.testAnswer === "string" ? body.testAnswer : undefined;
  after(async () => {
    await reevaluateRow(ctx.workspaceId, capabilityId, ctx.orgName, stamp, { injected });
  });
  return true;
}
