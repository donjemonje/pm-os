/**
 * Who may start an analysis run while the PMOS AI step is switched off (test knob: COMPETITORS_AI=off with
 * COMPETITORS_TEST_KNOBS=on — local dev and the e2e server; production never sets either).
 *
 * Off means: nothing automatic reaches a model. A finished scan, a catalog change and the kicks (server start, the
 * minute timer, the hourly tick) queue nothing and start nothing. Two kinds of run still go through:
 *   - a run somebody asked for by hand (trigger "manual": the CLI `--analyze`, a PM-OS admin's action);
 *   - a run whose answers a test injected (it never calls a model).
 *
 * Pure: no database, no network, no environment.
 */

export interface GateState {
  /** The PMOS AI step is switched off (settings.ts aiStepEnabled() is false). */
  aiOff: boolean;
}

/** May a run with this trigger be queued (and later started)? */
export function analysisMayRun(run: { trigger: string; injected: boolean }, gate: GateState): boolean {
  return !gate.aiOff || run.trigger === "manual" || run.injected;
}

/**
 * The runs that take part in "one at a time, oldest first", as a query filter. With the AI step off, a queued run
 * that may not run (queued while the step was on) is left out: it is never the head of the queue, so it is never
 * started and never stands in the way of a manual run.
 */
export function queueFilter(gate: GateState): Record<string, unknown> {
  if (!gate.aiOff) return { status: { in: ["queued", "running", "waiting"] } };
  return { OR: [{ status: { in: ["running", "waiting"] } }, { status: "queued", OR: [{ trigger: "manual" }, { injected: true }] }] };
}
