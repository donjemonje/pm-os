import { capLines, type CapHit } from "./caps";
import { incidentLine, type IncidentLog } from "./incidents";

/**
 * The one email a run sends to support (Daniel 2026-11-15: "we shouldn't hit any limit, so if we do, I want to know
 * about it"; 2026-11-16: a quote that is not on its page "should never happen … not just drop — investigate").
 * ONE email per run, when it ended failed, hit any cap or had any incident — never an email per cap or per case. A cancelled run (its
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
  /** The run's incidents (incidents.ts): answers that should never happen. Not given = none. */
  incidents?: IncidentLog;
  models: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date | null;
  finishedAt: Date;
  appUrl: string;
}

/** Incidents listed in the email with their details; the rest are counted. */
export const ALERT_INCIDENT_LINES = 40;

/** Does this ending send the email? Failed → yes. Done with at least one cap hit or one incident → yes. Anything else → no. */
export function runAlertDue(r: Pick<RunAlertInput, "outcome"> & { caps: number; incidents?: number }): boolean {
  return r.outcome === "failed" || (r.outcome === "done" && (r.caps > 0 || (r.incidents ?? 0) > 0));
}

const n = (v: number) => v.toLocaleString("en-US");

/** The email of one run: one subject, one body — every cap on its own line. */
export function runAlertEmail(r: RunAlertInput): { subject: string; text: string } {
  const what = r.kind === "setup" ? "Setup run" : "Analysis";
  const failed = r.outcome === "failed";
  const limits = r.caps.length ? `hit ${r.caps.length} limit${r.caps.length === 1 ? "" : "s"}` : "";
  const cases = r.incidents?.total ?? 0;
  const happened = [failed ? "failed" : "", limits, cases ? `had ${cases} incident${cases === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const about = r.kind === "setup" ? r.organization : r.ownSite ? `the own site of ${r.organization}` : `${r.company} (${r.organization})`;
  const lines = capLines(r.caps);
  const took = r.startedAt ? `${Math.max(1, Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 60_000))} min` : "–";
  const text = [
    failed
      ? `${r.kind === "setup" ? "A setup run" : "An analysis run"} failed${r.caps.length ? " and hit a limit that should never be hit" : ""}${cases ? `${r.caps.length ? "," : ""} and PMOS AI gave ${cases} answer${cases === 1 ? "" : "s"} that should never happen` : ""}.`
      : r.caps.length
        ? `${r.kind === "setup" ? "A setup run" : "An analysis run"} finished, and hit a limit that should never be hit. Limits are safety nets: what is listed below was left undone.${cases ? ` PMOS AI also gave ${cases} answer${cases === 1 ? "" : "s"} that should never happen.` : ""}`
        : `${r.kind === "setup" ? "A setup run" : "An analysis run"} finished, and PMOS AI gave ${cases} answer${cases === 1 ? "" : "s"} that should never happen. Nothing of them is in the table; each case is kept on the run to be looked at.`,
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
    cases ? `Incidents (${cases}) — a quote that is not on the page it names, or a page or an item that was not given. The finding is not in the table:` : `Incidents: none`,
    ...(r.incidents?.list ?? []).slice(0, ALERT_INCIDENT_LINES).map((i) => `  - ${incidentLine(i)}`),
    ...(cases > ALERT_INCIDENT_LINES ? [`  … and ${cases - ALERT_INCIDENT_LINES} more: the run keeps them (Administration → Competitors).`] : []),
    ``,
    failed
      ? r.kind === "setup"
        ? `What to do: read the run's log, fix the cause, then continue the same run: --setup ${r.workspaceId}. Nothing it wrote is redone.`
        : `What to do: read the run's log and fix the cause. A failed run is not retried by itself: the competitor's next scan queues a new one, or queue one from Administration → Competitors.`
      : r.caps.length
        ? `What to do: raise the limit that was hit, then run the analysis again — what was left undone is still due. The token budget is in Administration → Competitors; the two ceilings of a run's speed are environment settings of the job (COMPETITORS_ANALYSIS_MAX_SPEED, COMPETITORS_ANALYSIS_TPM); the others are constants in src/lib/competitors/analysis.${cases ? " And look at every incident: open the page, search for the quote, and see why PMOS AI named it." : ""}`
        : `What to do: look at every incident — open the page, search for the quote, and see why PMOS AI named it (the wrong page of the same request, or a passage that is on no page). The run's record keeps the page, the text's hash and the quote.`,
    `This email is sent once per run, whatever the number of limits.`,
    `Run log: ${r.appUrl}/admin/competitors`,
  ].join("\n");
  return { subject: `[PM-OS] ${what} ${happened}: ${about}`, text };
}
