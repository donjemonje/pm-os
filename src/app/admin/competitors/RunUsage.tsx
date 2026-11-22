import type { ChunkView } from "@/lib/competitors/analysis/chunk-view";
import type { PacingView } from "@/lib/competitors/analysis/pacing";
import type { StepUsage } from "@/lib/competitors/analysis/usage";

/**
 * Administration → Competitors: the tokens of one run (or of one company of a setup run), per step, with the model
 * that step used — input, output, the part of the output that was the model's own thinking (where the provider
 * reported any), the time its calls took and, when any was served from a cache, cached. Read-only, from the rows the run
 * recorded (analysis/usage.ts). Shared by the analysis runs and the setup runs sections.
 */

const COPY = {
  none: "Not recorded for this run (it ran before tokens were split by step).",
  noCalls: "No PMOS AI call was made.",
  total: "Total",
};

const n = (v: number) => v.toLocaleString("en-US");
/** "4 min 12 s" / "38 s" — the time the calls of a step took, added up. */
const time = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
/** "57%" — the part of the output that was thinking. */
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
const TH = "px-2 py-1";
const TD = "px-2 py-1 align-top";

export function RunUsage({ usage, calls }: { usage: StepUsage[]; /** The run's own count of calls: tells "no call" from "not recorded". */ calls: number }) {
  if (usage.length === 0) return <div className="text-xs text-slate-500" data-testid="admin-usage-empty">{calls > 0 ? COPY.none : COPY.noCalls}</div>;
  const cached = usage.some((u) => u.cached > 0);
  // The model's own thinking is part of the output tokens: shown apart wherever the provider reported any.
  const thinking = usage.some((u) => u.thinking > 0);
  // The time of the calls: shown for every run that recorded it.
  const timed = usage.some((u) => u.ms > 0);
  const total = usage.reduce((t, u) => ({ calls: t.calls + u.calls, input: t.input + u.input, output: t.output + u.output, cached: t.cached + u.cached, thinking: t.thinking + u.thinking, ms: t.ms + u.ms }), { calls: 0, input: 0, output: 0, cached: 0, thinking: 0, ms: 0 });
  return (
    <table className="text-xs" data-testid="admin-usage">
      <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
        <tr><th className={TH}>Step</th><th className={TH}>Model</th><th className={`${TH} text-right`}>Calls</th><th className={`${TH} text-right`}>Input tokens</th><th className={`${TH} text-right`}>Output tokens</th>{thinking && <th className={`${TH} text-right`} title="The part of the output tokens that was the model's own thinking, not the answer">Of them thinking</th>}{timed && <th className={`${TH} text-right`} title="The time the calls of the step took, added up — calls that ran at the same time each count their own time">Time of the calls</th>}{cached && <th className={`${TH} text-right`}>Cached</th>}</tr>
      </thead>
      <tbody>
        {usage.map((u) => (
          <tr key={`${u.step}|${u.model}`} className="border-t border-slate-200" data-testid="admin-usage-row">
            <td className={TD}>{u.step.replace(/_/g, " ")}</td>
            <td className={`${TD} font-mono`}>{u.model}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.calls)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.input)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(u.output)}</td>
            {thinking && <td className={`${TD} text-right tabular-nums`} data-testid="admin-usage-thinking">{u.thinking > 0 ? `${n(u.thinking)} (${share(u.thinking, u.output)})` : "–"}</td>}
            {timed && <td className={`${TD} text-right tabular-nums`} data-testid="admin-usage-time">{u.ms > 0 ? time(u.ms) : "–"}</td>}
            {cached && <td className={`${TD} text-right tabular-nums`}>{u.cached > 0 ? n(u.cached) : "–"}</td>}
          </tr>
        ))}
        <tr className="border-t border-slate-300 font-semibold">
          <td className={TD} colSpan={2}>{COPY.total}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.calls)}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.input)}</td>
          <td className={`${TD} text-right tabular-nums`}>{n(total.output)}</td>
          {thinking && <td className={`${TD} text-right tabular-nums`}>{n(total.thinking)} ({share(total.thinking, total.output)})</td>}
          {timed && <td className={`${TD} text-right tabular-nums`}>{time(total.ms)}</td>}
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
 * The incidents of a run (analysis/incidents.ts): answers of PMOS AI that should never happen — a quote that is not
 * on the page it names, a page or an item that was not given. Shown like a cap hit: never silent. Nothing of an
 * incident is in the table; each line is the case to look at.
 */
const INCIDENTS_COPY = {
  none: "No incident",
  hit: (count: number) => `${count} incident${count === 1 ? "" : "s"} — an answer of PMOS AI that should never happen. Nothing of ${count === 1 ? "it" : "them"} is in the table; each case is kept to be looked at`,
  more: (n: number) => `… and ${n} more: the run counted them and did not keep their details.`,
};

export function RunIncidents({ incidents, total }: { /** One line per case (incidents.ts incidentLine). */ incidents: string[]; /** Every incident of the run, also the ones not listed. */ total?: number }) {
  const count = Math.max(total ?? 0, incidents.length);
  if (count === 0) return <span className="inline-block rounded-full border border-emerald-200 bg-emerald-50 px-2 py-px text-[11px] font-semibold text-emerald-700" data-testid="admin-incidents-none">{INCIDENTS_COPY.none}</span>;
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900" role="alert" data-testid="admin-incidents-hit">
      <div className="font-semibold">{INCIDENTS_COPY.hit(count)}</div>
      <ul className="mt-1 list-disc pl-4">
        {incidents.map((line, i) => (
          <li key={`${i}|${line}`} data-testid="admin-incident-line">{line}</li>
        ))}
      </ul>
      {count > incidents.length && <div className="mt-1">{INCIDENTS_COPY.more(count - incidents.length)}</div>}
    </div>
  );
}

/**
 * The reading requests of a company (analysis/read-step.ts): one row per chunk of pages sent to PMOS AI — how many
 * pages of which kind, how many tokens, the model, the time, and what the answer did to the company's list.
 */
const CHUNKS_COPY = {
  none: "No reading request yet.",
  kind: { list: "the list", changes: "changes" } as Record<string, string>,
};

export function RunChunks({ chunks }: { chunks: ChunkView[] }) {
  if (chunks.length === 0) return <div className="text-xs text-slate-500" data-testid="admin-chunks-empty">{CHUNKS_COPY.none}</div>;
  return (
    <table className="text-xs" data-testid="admin-chunks">
      <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
        <tr><th className={TH}>Request</th><th className={TH}>When</th><th className={`${TH} text-right`}>Pages</th><th className={TH}>By kind</th><th className={`${TH} text-right`} title="Estimated before the call: characters / 4">Estimated tokens</th><th className={`${TH} text-right`}>Input tokens</th><th className={`${TH} text-right`}>Output tokens</th><th className={`${TH} text-right`}>Of them thinking</th><th className={`${TH} text-right`}>Time</th><th className={TH}>Model</th><th className={TH}>What the answer did</th></tr>
      </thead>
      <tbody>
        {chunks.map((c) => (
          <tr key={c.id} className="border-t border-slate-200" data-testid="admin-chunk-row" title={`${c.firstUrl} … ${c.lastUrl}`}>
            <td className={`${TD} whitespace-nowrap`}>{c.position} · {CHUNKS_COPY.kind[c.kind] ?? c.kind}</td>
            <td className={`${TD} whitespace-nowrap`}>{new Date(c.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(c.pages)}</td>
            <td className={TD}>{c.kinds || "–"}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(c.tokens)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(c.inputTokens)}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(c.outputTokens)}</td>
            <td className={`${TD} text-right tabular-nums`}>{c.thinkingTokens > 0 ? n(c.thinkingTokens) : "–"}</td>
            <td className={`${TD} text-right tabular-nums`}>{n(c.seconds)} s</td>
            <td className={`${TD} font-mono`}>{c.model}</td>
            <td className={TD}>
              {c.did}
              {c.unexplained > 0 && <span className="text-slate-500"> · {c.unexplained} label{c.unexplained === 1 ? "" : "s"} seen but not explained</span>}
              {c.incidents > 0 && <span className="ml-1 rounded-full border border-red-200 bg-red-50 px-2 py-px text-[11px] font-semibold text-red-700">{c.incidents} incident{c.incidents === 1 ? "" : "s"}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
