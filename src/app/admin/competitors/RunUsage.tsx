import type { StepUsage } from "@/lib/competitors/analysis/usage";

/**
 * Administration → Competitors: the tokens of one run (or of one company of a setup run), per step, with the model
 * that step used — input, output and, when any was served from a cache, cached. Read-only, from the rows the run
 * recorded (analysis/usage.ts). Shared by the analysis runs and the setup runs sections.
 */

const COPY = {
  none: "Not recorded for this run (it ran before tokens were split by step).",
  noCalls: "No PMOS AI call was made.",
  total: "Total",
};

const n = (v: number) => v.toLocaleString("en-US");
const TH = "px-2 py-1";
const TD = "px-2 py-1 align-top";

export function RunUsage({ usage, calls }: { usage: StepUsage[]; /** The run's own count of calls: tells "no call" from "not recorded". */ calls: number }) {
  if (usage.length === 0) return <div className="text-xs text-slate-500" data-testid="admin-usage-empty">{calls > 0 ? COPY.none : COPY.noCalls}</div>;
  const cached = usage.some((u) => u.cached > 0);
  const total = usage.reduce((t, u) => ({ calls: t.calls + u.calls, input: t.input + u.input, output: t.output + u.output, cached: t.cached + u.cached }), { calls: 0, input: 0, output: 0, cached: 0 });
  return (
    <table className="text-xs" data-testid="admin-usage">
      <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
        <tr><th className={TH}>Step</th><th className={TH}>Model</th><th className={`${TH} text-right`}>Calls</th><th className={`${TH} text-right`}>Input tokens</th><th className={`${TH} text-right`}>Output tokens</th>{cached && <th className={`${TH} text-right`}>Cached</th>}</tr>
      </thead>
      <tbody>
        {usage.map((u) => (
          <tr key={`${u.step}|${u.model}`} className="border-t border-slate-200" data-testid="admin-usage-row">
            <td className={TD}>{u.step.replace(/_/g, " ")}</td>
            <td className={`${TD} font-mono`}>{u.model}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.calls)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.input)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.output)}</td>
            {cached && <td className={`${TD} text-right tabular-nums`}>{u.cached > 0 ? n(u.cached) : "–"}</td>}
          </tr>
        ))}
        <tr className="border-t border-slate-300 font-semibold">
          <td className={TD} colSpan={2}>{COPY.total}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.calls)}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.input)}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.output)}</td>
          {cached && <td className={`${TD} text-right tabular-nums`}>{n(total.cached)}</td>}
        </tr>
      </tbody>
    </table>
  );
}
