"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { RunView } from "@/app/api/admin/organizations/[id]/ideas-runs/route";
import type { StageTrace } from "@/lib/ideas/trace";

/**
 * Import run history: one row per batch (status, duration, tickets, tokens,
 * cached share), expandable into the per-stage trace. Read-only monitoring
 * of the pipeline's health and cost; the numbers come straight from the
 * batch row written by the import itself.
 */

const STATUS_CHIP: Record<RunView["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  completed: { label: "Completed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700 border-red-200" },
  aborted: { label: "Aborted", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  stale: { label: "Stale — no heartbeat", cls: "bg-amber-50 text-amber-800 border-amber-200" },
};

function secs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function kilo(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  calls: number;
  warmups: number;
}

function totalsOf(stages: StageTrace[]): Totals {
  const t: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, calls: 0, warmups: 0 };
  for (const s of stages) {
    t.input += s.tokens?.input ?? 0;
    t.output += s.tokens?.output ?? 0;
    t.cacheRead += s.tokens?.cacheRead ?? 0;
    t.cacheWrite += s.tokens?.cacheWrite ?? 0;
    t.thinking += s.tokens?.thinking ?? 0;
    t.calls += s.calls ?? 0;
    t.warmups += s.warmups ?? 0;
  }
  return t;
}

function cachedShare(t: Totals): string {
  return t.input ? `${Math.round((t.cacheRead / t.input) * 100)}%` : "–";
}

export function ImportRuns({ orgId }: { orgId: string }) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/ideas-runs?limit=20`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not load import runs");
        return;
      }
      setRuns(data.runs as RunView[]);
    } catch {
      setError("Could not load import runs");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setRuns(null);
    setOpen(null);
    void load();
  }, [load]);

  // A run in progress updates its heartbeat every few seconds — follow it.
  const live = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [live, load]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold">Import runs</h2>
          <p className="mt-1 text-xs text-slate-500">
            Every import, newest first: how long it took, what it cost in tokens, and where it failed if it did.
            Open a run for the stage-by-stage breakdown. Cached = prompt tokens served from the model cache (billed at a fraction).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:border-slate-500 disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {runs && runs.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No imports yet for this organization.</p>
      )}

      {runs && runs.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="w-6 pb-2"></th>
                <th className="pb-2 pr-3 font-semibold">Started</th>
                <th className="pb-2 pr-3 font-semibold">Status</th>
                <th className="pb-2 pr-3 font-semibold text-right">Duration</th>
                <th className="pb-2 pr-3 font-semibold text-right">Tickets</th>
                <th className="pb-2 pr-3 font-semibold text-right">Calls</th>
                <th className="pb-2 pr-3 font-semibold text-right">Tokens in</th>
                <th className="pb-2 pr-3 font-semibold text-right">Tokens out</th>
                <th className="pb-2 pr-3 font-semibold text-right">Cached</th>
                <th className="pb-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {runs.map((r) => {
                const stages = r.trace?.stages ?? [];
                const t = totalsOf(stages);
                const chip = STATUS_CHIP[r.status];
                const isOpen = open === r.id;
                const s = r.stats ?? {};
                const result =
                  r.error ??
                  (r.stats
                    ? `${s.frs ?? 0} FRs · ${s.matched ?? 0} merged · ${s.split ?? 0} split · ${
                        (Number(s.bugs ?? 0) + Number(s.opsTasks ?? 0) + Number(s.questions ?? 0) + Number(s.needsDetails ?? 0))
                      } parked`
                    : stages.length
                      ? `in ${stages[stages.length - 1].stage}`
                      : "");
                return (
                  <FragmentRow
                    key={r.id}
                    run={r}
                    open={isOpen}
                    onToggle={() => setOpen(isOpen ? null : r.id)}
                    chip={chip}
                    totals={t}
                    result={result}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FragmentRow({
  run,
  open,
  onToggle,
  chip,
  totals,
  result,
}: {
  run: RunView;
  open: boolean;
  onToggle: () => void;
  chip: { label: string; cls: string };
  totals: Totals;
  result: string;
}) {
  const stages = run.trace?.stages ?? [];
  const uploaded = run.trace?.uploaded ?? (run.stats?.imported as number | undefined);
  const fresh = run.trace?.fresh;
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="py-2 text-slate-400">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap">{when(run.startedAt)}</td>
        <td className="py-2 pr-3">
          <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
            {chip.label}
          </span>
        </td>
        <td className="py-2 pr-3 text-right whitespace-nowrap">{secs(run.durationMs)}</td>
        <td className="py-2 pr-3 text-right whitespace-nowrap">
          {uploaded ?? "–"}
          {fresh !== undefined && uploaded !== undefined && fresh !== uploaded ? (
            <span className="text-slate-400"> ({fresh} new)</span>
          ) : null}
        </td>
        <td className="py-2 pr-3 text-right">{totals.calls}{totals.warmups ? <span className="text-slate-400"> +{totals.warmups}</span> : null}</td>
        <td className="py-2 pr-3 text-right">{kilo(totals.input)}</td>
        <td className="py-2 pr-3 text-right">{kilo(totals.output)}</td>
        <td className="py-2 pr-3 text-right">{cachedShare(totals)}</td>
        <td className={`py-2 max-w-[28rem] truncate ${run.error ? "text-red-700" : "text-slate-600"}`} title={result}>
          {result}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td></td>
          <td colSpan={9} className="py-3 pr-3">
            {stages.length === 0 ? (
              <p className="text-slate-500">No stage data recorded for this run (it predates the trace).</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="pb-1 pr-3 font-semibold">Stage</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Wall</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Items</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Calls</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Slowest call</th>
                    <th className="pb-1 pr-3 font-semibold text-right">DB</th>
                    <th className="pb-1 pr-3 font-semibold text-right">In</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Out</th>
                    <th className="pb-1 pr-3 font-semibold text-right">Cached</th>
                    <th className="pb-1 font-semibold">Model · note</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {stages.map((s, i) => {
                    const tok = s.tokens;
                    const cached = tok?.input ? `${Math.round(((tok.cacheRead ?? 0) / tok.input) * 100)}%` : "–";
                    return (
                      <tr key={`${s.stage}-${i}`} className={`border-t border-slate-200/70 ${s.error ? "text-red-700" : ""}`}>
                        <td className="py-1 pr-3 font-medium whitespace-nowrap">
                          {s.stage}
                          <span className="ml-1 text-[10px] uppercase text-slate-400">{s.kind}</span>
                        </td>
                        <td className="py-1 pr-3 text-right whitespace-nowrap">{secs(s.ms)}</td>
                        <td className="py-1 pr-3 text-right">{s.items ?? "–"}</td>
                        <td className="py-1 pr-3 text-right">
                          {s.calls ?? 0}
                          {s.warmups ? <span className="text-slate-400"> +{s.warmups}</span> : null}
                        </td>
                        <td className="py-1 pr-3 text-right whitespace-nowrap">{s.calls ? secs(s.aiMaxMs) : "–"}</td>
                        <td className="py-1 pr-3 text-right whitespace-nowrap">{s.dbMs !== undefined ? secs(s.dbMs) : "–"}</td>
                        <td className="py-1 pr-3 text-right">{kilo(tok?.input)}</td>
                        <td className="py-1 pr-3 text-right">
                          {kilo(tok?.output)}
                          {tok?.thinking ? <span className="text-slate-400"> ({kilo(tok.thinking)} thinking)</span> : null}
                        </td>
                        <td className="py-1 pr-3 text-right">{cached}</td>
                        <td className="py-1 text-slate-600">
                          {s.model ? <span className="font-mono text-[11px]">{s.model}{s.promptVersion ? ` ${s.promptVersion}` : ""}</span> : null}
                          {s.model && (s.note || s.error) ? " · " : ""}
                          {s.error ? <span className="text-red-700">{s.error}</span> : s.note}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {run.error && (
              <p className="mt-2 text-red-700">{run.error}</p>
            )}
            <p className="mt-2 text-[11px] text-slate-400">
              Batch {run.id} · last heartbeat {when(run.heartbeatAt)}
              {run.trace ? ` · server pid ${run.trace.pid}, booted ${when(run.trace.serverBootedAt)}` : ""}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
