import type { PacingView } from "@/lib/competitors/analysis/pacing";
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

/**
 * The caps a run hit (analysis/caps.ts): a clearly visible warning with every cap on its own line — which limit, its
 * value, what was left undone, at which company — or the clean state. Limits are safety nets: a hit is never silent.
 */
const CAPS_COPY = {
  none: "No cap was hit",
  hit: (count: number) => `${count} cap${count === 1 ? " was" : "s were"} hit — limits are safety nets: what is listed here was left undone`,
  notRecorded: "Caps: not recorded for this run (it ran before caps were recorded).",
  noneYet: "No cap was hit so far",
};

export function RunCaps({ caps, recorded, active }: { /** One line per cap (caps.ts capLine). */ caps: string[]; /** False for a run from before caps were recorded. */ recorded: boolean; /** The run is still queued or working. */ active?: boolean }) {
  if (caps.length === 0) {
    if (!recorded) return <div className="text-xs text-slate-500" data-testid="admin-caps-unknown">{CAPS_COPY.notRecorded}</div>;
    return <span className="inline-block rounded-full border border-emerald-200 bg-emerald-50 px-2 py-px text-[11px] font-semibold text-emerald-700" data-testid="admin-caps-none">{active ? CAPS_COPY.noneYet : CAPS_COPY.none}</span>;
  }
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert" data-testid="admin-caps-hit">
      <div className="font-semibold">{CAPS_COPY.hit(caps.length)}</div>
      <ul className="mt-1 list-disc pl-4">
        {caps.map((line) => (
          <li key={line} data-testid="admin-cap-line">{line}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How a run paced itself (analysis/pacing.ts), next to its tokens: the speed it started with, the fastest it got,
 * its ceiling, and every time the provider pushed back — when, in which step, at what speed, the speed after, how
 * long the run waited. A run paces itself from the provider's answers; nothing here is a setting.
 */
const PACING_COPY = {
  title: "Speed",
  notRecorded: "Speed: not recorded for this run (it ran before a run paced itself).",
  older: (n: number) => `${n} earlier pushback${n === 1 ? "" : "s"} of this run ${n === 1 ? "is" : "are"} counted above and not listed.`,
  reason: { capacity: "no capacity / slow down", endpoint: "the endpoint failed" } as Record<string, string>,
  asked: (ms: number) => ` (the provider asked for ${Math.round(ms / 1000)} s)`,
};

export function RunPacing({ pacing }: { /** Null for a run from before pacing was recorded. */ pacing: PacingView | null }) {
  if (!pacing) return <div className="text-xs text-slate-500" data-testid="admin-pacing-unknown">{PACING_COPY.notRecorded}</div>;
  return (
    <div className="text-xs" data-testid="admin-pacing">
      <div className="text-slate-600"><span className="font-semibold">{PACING_COPY.title}:</span> <span data-testid="admin-pacing-line">{pacing.line}</span></div>
      {pacing.pushbacks.length > 0 && (
        <table className="mt-1.5">
          <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className={TH}>When</th><th className={TH}>Step</th><th className={TH}>Company</th><th className={TH}>Why</th><th className={`${TH} text-right`}>Calls at once</th><th className={`${TH} text-right`}>Waited</th></tr>
          </thead>
          <tbody>
            {pacing.pushbacks.map((p, i) => (
              <tr key={`${p.at}|${i}`} className="border-t border-slate-200" data-testid="admin-pushback-row">
                <td className={`${TD} whitespace-nowrap`}>{new Date(p.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                <td className={TD}>{p.step.replace(/_/g, " ")}</td>
                <td className={TD}>{p.company ?? "–"}</td>
                <td className={TD}>{PACING_COPY.reason[p.reason] ?? p.reason}</td>
                <td className={`${TD} text-right tabular-nums`}>{p.speed} → {p.next}</td>
                <td className={`${TD} text-right tabular-nums`}>{Math.round(p.waitMs / 1000)} s{p.retryAfterMs ? PACING_COPY.asked(p.retryAfterMs) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pacing.total > pacing.pushbacks.length && <div className="mt-1 text-slate-500">{PACING_COPY.older(pacing.total - pacing.pushbacks.length)}</div>}
    </div>
  );
}
