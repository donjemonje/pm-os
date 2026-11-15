/**
 * The tokens of a run, split by step and by model (Daniel 2026-11-15: Administration → Competitors shows, per run,
 * input and output tokens per step with the model that step used; for a setup run also per company).
 *
 * Every model call of a run adds to one row: the step that was running and the model that answered. The model's
 * own thinking is billed as output and is kept apart on every row (`thinking`), wherever the provider reports it:
 * on the first real run roughly half of the reading step's output was thinking. A go-back
 * round's research, merge and match calls count under "go_back", each with its own model. A setup run keeps one
 * list per company and one for the calls that belong to no company (unify, domains); the run's own list is their
 * roll-up. The run's counters (counters.ts) keep the totals; this is the split.
 *
 * Pure: no database, no network.
 */

export interface StepUsage {
  /** The engine's step when the call was made: map | research | merge | unify | domains | match | go_back | second_look | apply | facts. */
  step: string;
  model: string;
  /** Calls that were made and billed — the ones whose answer was unusable included. */
  calls: number;
  input: number;
  /** Everything the model wrote and is billed for: the visible answer AND its own thinking. */
  output: number;
  /** The part of `input` served from a cache. */
  cached: number;
  /** The part of `output` that was the model's own thinking — not the answer. 0 where the provider does not report it (and for a run from before it was recorded). */
  thinking: number;
}

export interface TokenSum {
  calls: number;
  input: number;
  output: number;
  cached: number;
  thinking: number;
}

/** The order steps are shown in: the order they run. A step that is not on the list comes last. */
export const STEP_ORDER: readonly string[] = ["map", "research", "merge", "unify", "domains", "match", "go_back", "second_look", "apply", "facts"];

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** One call's tokens, added to the row of its step and model (made when it is the first). */
export function addUsage(list: StepUsage[], step: string, model: string, u: { input: number; output: number; cached: number; thinking?: number }): void {
  let row = list.find((r) => r.step === step && r.model === model);
  if (!row) {
    row = { step, model, calls: 0, input: 0, output: 0, cached: 0, thinking: 0 };
    list.push(row);
  }
  row.calls++;
  row.input += num(u.input);
  row.output += num(u.output);
  row.cached += num(u.cached);
  row.thinking += num(u.thinking);
}

/** The stored list (a Json column), checked row by row: anything that is not a row is left out. */
export function readUsage(raw: unknown): StepUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: StepUsage[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.step !== "string" || !o.step || typeof o.model !== "string" || !o.model) continue;
    out.push({ step: o.step, model: o.model, calls: num(o.calls), input: num(o.input), output: num(o.output), cached: num(o.cached), thinking: num(o.thinking) });
  }
  return out;
}

const stepRank = (step: string) => {
  const i = STEP_ORDER.indexOf(step);
  return i < 0 ? STEP_ORDER.length : i;
};

/** Rows in the order they are shown: by step (run order), then by model. */
export function sortUsage(list: StepUsage[]): StepUsage[] {
  return [...list].sort((a, b) => stepRank(a.step) - stepRank(b.step) || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** Several lists as one — a setup run's companies and its shared calls: one row per step and model, sorted. */
export function rollUp(lists: StepUsage[][]): StepUsage[] {
  const out: StepUsage[] = [];
  for (const list of lists) {
    for (const r of list) {
      const row = out.find((x) => x.step === r.step && x.model === r.model);
      if (row) {
        row.calls += r.calls;
        row.input += r.input;
        row.output += r.output;
        row.cached += r.cached;
        row.thinking += r.thinking;
      } else {
        out.push({ ...r });
      }
    }
  }
  return sortUsage(out);
}

export function usageTotal(list: StepUsage[]): TokenSum {
  return list.reduce((t, r) => ({ calls: t.calls + r.calls, input: t.input + r.input, output: t.output + r.output, cached: t.cached + r.cached, thinking: t.thinking + r.thinking }), { calls: 0, input: 0, output: 0, cached: 0, thinking: 0 });
}

/** The tokens of each model, whatever the step — by model name. */
export function usageByModel(list: StepUsage[]): Array<TokenSum & { model: string }> {
  const out = new Map<string, TokenSum & { model: string }>();
  for (const r of list) {
    const m = out.get(r.model) ?? { model: r.model, calls: 0, input: 0, output: 0, cached: 0, thinking: 0 };
    m.calls += r.calls;
    m.input += r.input;
    m.output += r.output;
    m.cached += r.cached;
    m.thinking += r.thinking;
    out.set(r.model, m);
  }
  return [...out.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** The tokens of each step, whatever the model, with the models it used — in run order. */
export function usageByStep(list: StepUsage[]): Array<TokenSum & { step: string; models: string[] }> {
  const out: Array<TokenSum & { step: string; models: string[] }> = [];
  for (const r of sortUsage(list)) {
    let s = out.find((x) => x.step === r.step);
    if (!s) {
      s = { step: r.step, models: [], calls: 0, input: 0, output: 0, cached: 0, thinking: 0 };
      out.push(s);
    }
    if (!s.models.includes(r.model)) s.models.push(r.model);
    s.calls += r.calls;
    s.input += r.input;
    s.output += r.output;
    s.cached += r.cached;
    s.thinking += r.thinking;
  }
  return out;
}

/** What was added since `before` (a copy taken earlier): the rows that grew, with only the growth. */
export function usageSince(now: StepUsage[], before: StepUsage[]): StepUsage[] {
  const out: StepUsage[] = [];
  for (const r of now) {
    const b = before.find((x) => x.step === r.step && x.model === r.model);
    const d = { step: r.step, model: r.model, calls: r.calls - (b?.calls ?? 0), input: r.input - (b?.input ?? 0), output: r.output - (b?.output ?? 0), cached: r.cached - (b?.cached ?? 0), thinking: r.thinking - (b?.thinking ?? 0) };
    if (d.calls > 0) out.push(d);
  }
  return sortUsage(out);
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * "gemini-4-hydrogen: 12 calls · 120,000 input + 8,000 output tokens, 4,500 of them thinking (3,000 cached)" — one
 * model's part of a step, for the run log. The thinking part is said only where the provider reported any.
 */
export function usageLine(u: TokenSum & { model: string }): string {
  return `${u.model}: ${n(u.calls)} call${u.calls === 1 ? "" : "s"} · ${n(u.input)} input + ${n(u.output)} output tokens${u.thinking > 0 ? `, ${n(u.thinking)} of them thinking` : ""}${u.cached > 0 ? ` (${n(u.cached)} cached)` : ""}`;
}

/** The visible answer's tokens: the output without the model's own thinking. */
export function answerTokens(u: { output: number; thinking: number }): number {
  return Math.max(0, u.output - u.thinking);
}

/** "gemini-4-argon 1,200/300; gemini-4-hydrogen 90,000/4,000" — input/output per model in one string, for a usage event. */
export function usageByModelText(list: StepUsage[]): string {
  return usageByModel(list).map((m) => `${m.model} ${m.input}/${m.output}`).join("; ");
}
