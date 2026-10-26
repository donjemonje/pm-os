"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { shortDate, timeAgo } from "@/lib/competitors/time";
import { cn } from "@/lib/utils";

interface ScanRow {
  id: string;
  trigger: string;
  status: string;
  fetchMode: string | null;
  startedAt: string;
  finishedAt: string | null;
  pagesFetched: number;
  pagesChanged: number;
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
  aiCalls: number;
  errorKind: string | null;
  error: string | null;
  badge: string | null;
  outcomes: Record<string, number>;
  robotsDisallowed: string[];
  removedPages: string[];
  piiHits: number;
  pages: { url: string; status: number; outcome: string; category?: string; chars: number; ms: number; via: string; error?: string }[];
  log: { at: string; level: string; msg: string; url?: string }[];
}

const STATUS_CLASS: Record<string, string> = {
  ok: "bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
  full: "bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
  partial: "bg-[#fff7e0] text-[#8a5a00]",
  incomplete: "bg-[#fff7e0] text-[#8a5a00]",
  failed: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  blocked: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  unreachable: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  running: "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]",
  queued: "bg-[#eef1f6] text-[#4a5b74]",
};
const OUTCOME_CLASS: Record<string, string> = {
  new: "text-[#0f7a47]",
  changed: "text-[#2a5fd0]",
  unchanged: "text-fg-faint",
  failed: "text-[#c23767]",
  skipped: "text-fg-faint",
};

/**
 * The scan log of one competitor: every run, newest first, each expandable
 * to its pages and log lines. How we debug and verify the scraping; PMs can
 * read it too.
 */
export function ScanLogDrawer({ competitorId, competitorName, onClose }: { competitorId: string; competitorName: string; onClose: () => void }) {
  const [scans, setScans] = useState<ScanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/competitors/scans?competitorId=${encodeURIComponent(competitorId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? C.errors.generic);
        if (!cancelled) {
          setScans(data.scans);
          setOpen(data.scans[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : C.errors.generic);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [competitorId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(12,25,41,.18)]" onClick={onClose} />
      <div className="fixed bottom-0 right-0 top-0 z-[41] flex w-[720px] max-w-[95vw] flex-col border-l border-border bg-white shadow-[var(--app-shadow-drawer)]">
        <div className="flex items-center gap-3 border-b border-border px-6 pb-4 pt-[18px]">
          <h2 className="font-title text-[16px] font-bold">{C.log.title(competitorName)}</h2>
          <button onClick={onClose} aria-label="Close" className="ml-auto rounded-md p-1 text-fg-muted hover:bg-background">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 text-[13px]">
          {error && <div className="rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">{error}</div>}
          {!error && scans === null && (
            <div className="flex items-center gap-2 text-fg-3">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}
          {scans && scans.length === 0 && <div className="text-fg-3">{C.log.empty}</div>}
          {scans?.map((s) => {
            const isOpen = open === s.id;
            const seconds = s.finishedAt ? Math.round((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000) : null;
            return (
              <div key={s.id} className="mb-3 overflow-hidden rounded-inner border border-border">
                <button
                  onClick={() => setOpen(isOpen ? null : s.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,.7)]"
                >
                  {isOpen ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
                  <span className={cn("inline-flex rounded-full px-2 py-px text-[11px] font-semibold", STATUS_CLASS[s.badge ?? s.status] ?? STATUS_CLASS.queued)} title={s.badge ? C.settings.badgeHint[s.badge] : undefined}>
                    {s.badge ? C.settings.badges[s.badge] : C.log.status[s.status] ?? s.status}
                  </span>
                  <span className="font-semibold">{shortDate(s.startedAt)}</span>
                  <span className="text-fg-muted" title={new Date(s.startedAt).toLocaleString()}>{timeAgo(s.startedAt)}</span>
                  <span className="text-fg-muted">· {C.log.trigger[s.trigger] ?? s.trigger}</span>
                  {s.fetchMode && <span className="text-fg-muted">· {C.log.fetchMode[s.fetchMode] ?? s.fetchMode}</span>}
                  <span className="ml-auto font-mono text-[11px] text-fg-muted">
                    {C.log.summary(s.pagesFetched, s.pagesChanged, s.statusesChanged, s.factsChanged, s.suggestions)}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-border bg-[rgba(255,255,255,.6)] px-4 py-3">
                    <div className="mb-3 flex flex-wrap gap-4 font-mono text-[11px] text-fg-3">
                      {seconds != null && <span>{C.log.duration(seconds)}</span>}
                      <span>{C.log.aiCalls(s.aiCalls)}</span>
                      {s.piiHits > 0 && <span className="text-[#8a5a00]">{C.log.piiHits(s.piiHits)}</span>}
                      {s.error && <span className="text-[#c23767]">{s.error}</span>}
                    </div>
                    {(Object.keys(s.outcomes ?? {}).length > 0 || s.removedPages?.length > 0) && (
                      <div className="mb-3 rounded-[8px] border border-border bg-white px-3 py-2 text-[12px] text-fg-2">
                        {Object.keys(s.outcomes ?? {}).length > 0 && (
                          <div>
                            <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.log.outcomesHeading}: </span>
                            {Object.entries(s.outcomes).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${C.settings.outcomeLabels[k] ?? k}`).join(" · ")}
                            {s.robotsDisallowed?.length > 0 && <span className="text-fg-muted"> — {C.log.robotsPaths}: {s.robotsDisallowed.join(", ")}</span>}
                          </div>
                        )}
                        {s.removedPages?.length > 0 && (
                          <div className="mt-1">
                            <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.log.removedHeading}: </span>
                            {s.removedPages.map((u) => u.replace(/^https?:\/\/[^/]+/, "") || "/").join(", ")}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="mb-1.5 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.log.pagesHeading} · {s.pages.length}</div>
                    <div className="mb-4 max-h-64 overflow-y-auto rounded-[8px] border border-border bg-white">
                      {s.pages.length === 0 && <div className="px-3 py-2 text-fg-faint">—</div>}
                      {s.pages.map((p, i) => (
                        <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                          <span className={cn("w-[72px] shrink-0 font-mono text-[11px] font-semibold", OUTCOME_CLASS[p.outcome] ?? "")}>{C.log.outcome[p.outcome] ?? p.outcome}</span>
                          <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[12px] text-fg-2 hover:underline" title={p.url}>
                            {p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}
                          </a>
                          <span className="shrink-0 font-mono text-[10.5px] text-fg-muted">{p.status || "—"} · {p.chars.toLocaleString()} ch · {p.ms} ms</span>
                          {p.category && <span className="shrink-0 font-mono text-[10.5px] text-fg-muted">{C.settings.outcomeLabels[p.category] ?? p.category}</span>}
                          {p.error && <span className="shrink-0 font-mono text-[10.5px] text-[#c23767]">{p.error}</span>}
                        </div>
                      ))}
                    </div>
                    <div className="mb-1.5 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.log.linesHeading}</div>
                    <div className="max-h-72 overflow-y-auto rounded-[8px] border border-border bg-white px-3 py-2 font-mono text-[11px] leading-relaxed">
                      {s.log.map((l, i) => (
                        <div key={i} className={cn("flex gap-2", l.level === "error" ? "text-[#c23767]" : l.level === "warn" ? "text-[#8a5a00]" : "text-fg-2")}>
                          <span className="shrink-0 text-fg-faint">{new Date(l.at).toLocaleTimeString("en-GB")}</span>
                          <span className="min-w-0 break-words">
                            {l.msg}
                            {l.url && (
                              <>
                                {" "}
                                <a href={l.url} target="_blank" rel="noreferrer" className="text-fg-muted hover:underline">
                                  {l.url.replace(/^https?:\/\/[^/]+/, "")}
                                </a>
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
