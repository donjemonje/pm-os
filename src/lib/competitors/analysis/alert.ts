import { capLines, type CapHit } from "./caps";

/**
 * The one email a run sends to support (Daniel 2026-11-15: "we shouldn't hit any limit, so if we do, I want to know
 * about it"). ONE email per run, when it ended failed or hit any cap — never an email per cap. A cancelled run (its
 * competitor was removed) sends none; a run that ended clean sends none. A setup run that is continued after a
 * failure is one more ending: it may send one more email, about that ending.
 *
 * This file decides and writes the email; sending it (and never failing the run over it) is analysis/engine.ts.
 * It follows the support-alert email of the scanner (local.ts alertStationOff): plain text, to support@pm-os.io,
 * with what happened, where, and what to do.
 *
 * Pure: no database, no network.
 */

export interface RunAlertInput {
  /** "analysis" | "setup" */
  kind: string;
  /** How the run ended. */
  outcome: "done" | "failed" | "cancelled";
  organization: string;
  /** The company the run was about; a setup run's is the organization's own site. */
  company: string;
  /** The run was an analysis of the organization's own site (never a competitor). */
  ownSite?: boolean;
  runId: string;
  workspaceId: string;
  /** The step it ended in ("done" when it finished). */
  step: string;
  error: string | null;
  errorKind: string | null;
  caps: CapHit[];
  models: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date | null;
  finishedAt: Date;
  appUrl: string;
}

/** Does this ending send the email? Failed → yes. Done with at least one cap hit → yes. Anything else → no. */
export function runAlertDue(r: Pick<RunAlertInput, "outcome"> & { caps: number }): boolean {
  return r.outcome === "failed" || (r.outcome === "done" && r.caps > 0);
}

const n = (v: number) => v.toLocaleString("en-US");

/** The email of one run: one subject, one body — every cap on its own line. */
export function runAlertEmail(r: RunAlertInput): { subject: string; text: string } {
  const what = r.kind === "setup" ? "Setup run" : "Analysis";
  const failed = r.outcome === "failed";
  const limits = r.caps.length ? `hit ${r.caps.length} limit${r.caps.length === 1 ? "" : "s"}` : "";
  const happened = [failed ? "failed" : "", limits].filter(Boolean).join(" and ");
  const about = r.kind === "setup" ? r.organization : r.ownSite ? `the own site of ${r.organization}` : `${r.company} (${r.organization})`;
  const lines = capLines(r.caps);
  const took = r.startedAt ? `${Math.max(1, Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 60_000))} min` : "–";
  const text = [
    failed
      ? `${r.kind === "setup" ? "A setup run" : "An analysis run"} failed${r.caps.length ? " and hit a limit that should never be hit" : ""}.`
      : `${r.kind === "setup" ? "A setup run" : "An analysis run"} finished, and hit a limit that should never be hit. Limits are safety nets: what is listed below was left undone.`,
    ``,
    `Organization: ${r.organization}`,
    r.kind === "setup" || r.ownSite ? `Own site:     ${r.company}` : `Competitor:   ${r.company}`,
    `Run:          ${r.runId} (${r.kind})`,
    `Ended:        ${failed ? `failed in the ${r.step.replace(/_/g, " ")} step` : "done"} at ${r.finishedAt.toISOString()}, after ${took}`,
    ...(failed ? [`Error:        ${r.error ?? "no reason recorded"}${r.errorKind && r.errorKind !== "none" ? ` [${r.errorKind}]` : ""}`] : []),
    `Models:       ${r.models}`,
    `PMOS AI:      ${n(r.calls)} calls · ${n(r.inputTokens)} input + ${n(r.outputTokens)} output tokens`,
    ``,
    lines.length ? `Limits hit (${lines.length}):` : `Limits hit: none`,
    ...lines.map((l) => `  - ${l}`),
    ``,
    failed
      ? r.kind === "setup"
        ? `What to do: read the run's log, fix the cause, then continue the same run: --setup ${r.workspaceId}. Nothing it wrote is redone.`
        : `What to do: read the run's log and fix the cause. A failed run is not retried by itself: the competitor's next scan queues a new one, or queue one from Administration → Competitors.`
      : `What to do: raise the limit that was hit, then run the analysis again — what was left undone is still due. The token budget is in Administration → Competitors; second looks per run is the organization's setting competitorsConfig.secondLooksPerRun (1–500, no screen yet); the others are constants in src/lib/competitors/analysis.`,
    `This email is sent once per run, whatever the number of limits.`,
    `Run log: ${r.appUrl}/admin/competitors`,
  ].join("\n");
  return { subject: `[PM-OS] ${what} ${happened}: ${about}`, text };
}
