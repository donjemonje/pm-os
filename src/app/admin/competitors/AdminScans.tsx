"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { AdminScanRow } from "@/app/api/admin/competitors/scans/route";

/**
 * Scanner health across every organization: one row per run, newest first,
 * expandable into its pages and log lines. Read-only — the same data each
 * org's PMs see in Settings → Competitors → Scan log, for all orgs at once.
 */

const STATUS_CHIP: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-800 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  queued: "bg-slate-50 text-slate-600 border-slate-200",
};

function secs(ms: number | null): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Page = { url: string; status: number; outcome: string; chars: number; ms: number; via: string; error?: string };
type Line = { at: string; level: string; msg: string; url?: string };

export function AdminScans() {
  const [rows, setRows] = useState<AdminScanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/competitors/scans");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setRows(data.scans);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold">Scan runs — all organizations</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Every website scan the scanner ran, newest first: trigger, how it fetched (plain / browser after a bot wall), pages, what changed, AI calls, and the full log. In prod the job's own executions are in Cloud Run → Jobs → pmos-competitors-scanner.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {rows && rows.length === 0 && <div className="text-sm text-slate-500">No scans yet in any organization.</div>}
      {rows && rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Organization</th>
                <th className="px-3 py-2">Competitor</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Fetch</th>
                <th className="px-3 py-2 text-right">Pages</th>
                <th className="px-3 py-2 text-right">Changed</th>
                <th className="px-3 py-2 text-right">Statuses</th>
                <th className="px-3 py-2 text-right">Facts</th>
                <th className="px-3 py-2 text-right">Sugg.</th>
                <th className="px-3 py-2 text-right">AI</th>
                <th className="px-3 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.id;
                const pages = (Array.isArray(r.pages) ? r.pages : []) as Page[];
                const log = (Array.isArray(r.log) ? r.log : []) as Line[];
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.id)} className="cursor-pointer border-t border-slate-200 hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-400">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                      <td className="whitespace-nowrap px-3 py-2">{when(r.startedAt)}</td>
                      <td className="px-3 py-2 font-medium">{r.orgName}</td>
                      <td className="px-3 py-2">
                        {r.competitorName}
                        {r.isSelf && <span className="ml-1.5 rounded-full border border-slate-200 px-1.5 py-px text-[10px] text-slate-500">own site</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full border px-2 py-px text-[11px] font-medium ${STATUS_CHIP[r.status] ?? STATUS_CHIP.queued}`}>{r.status}</span>
                        {r.error && <span className="ml-2 text-red-600" title={r.error}>{r.errorKind}</span>}
                      </td>
                      <td className="px-3 py-2">{r.trigger}</td>
                      <td className="px-3 py-2">{r.fetchMode ?? "–"}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.pagesFetched}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.pagesChanged}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.statusesChanged}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.factsChanged}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.suggestions}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.aiCalls}</td>
                      <td className="px-3 py-2 text-right font-mono">{secs(r.durationMs)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={14} className="px-4 py-3">
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{r.url}</div>
                          {r.error && <div className="mb-2 text-xs text-red-700">{r.error}</div>}
                          <div className="grid gap-3 lg:grid-cols-2">
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-slate-500">Pages · {pages.length}</div>
                              <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white">
                                {pages.map((p, i) => (
                                  <div key={i} className="flex items-center gap-2 border-b border-slate-100 px-2 py-1 last:border-b-0">
                                    <span className={`w-[70px] shrink-0 font-mono text-[11px] ${p.outcome === "failed" ? "text-red-600" : p.outcome === "unchanged" ? "text-slate-400" : "text-emerald-700"}`}>{p.outcome}</span>
                                    <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-slate-700 hover:underline" title={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a>
                                    <span className="shrink-0 font-mono text-[10px] text-slate-400">{p.status || "–"} · {p.chars} ch · {p.ms} ms</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-slate-500">Log · {log.length}</div>
                              <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                                {log.map((l, i) => (
                                  <div key={i} className={l.level === "error" ? "text-red-700" : l.level === "warn" ? "text-amber-800" : "text-slate-700"}>
                                    <span className="text-slate-400">{new Date(l.at).toLocaleTimeString("en-GB")}</span> {l.msg}
                                    {l.url && <a href={l.url} target="_blank" rel="noreferrer" className="ml-1 text-slate-400 hover:underline">{l.url.replace(/^https?:\/\/[^/]+/, "")}</a>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
