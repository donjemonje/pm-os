"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { AdminPlanRun, AdminPlanSection } from "@/app/api/admin/competitors/plan/route";
import { COMPETITORS_COPY } from "@/lib/competitors/copy";
import type { ImportOrg } from "./AdminImport";
import { RunUsage } from "./RunUsage";

/**
 * Administration → Competitors → Reading plan (PM-OS admin only, read-only). Pick an organization and one of its
 * competitors: its reading plan — the sections of its site, the label PMOS AI gave each one (the label decides
 * what the analysis reads), their size — and its latest analysis runs: what was read, what the token budget left
 * unread, how many times the run went back for gaps. Nothing is edited here; customers never see this.
 */

/** Every string of the section (admin screens keep their strings in the component). */
const COPY = {
  title: "Reading plan and analysis runs",
  intro: "Read-only. An organization's own site is listed first, labeled; it is read like a competitor's. The analysis cuts a competitor's stored pages into sections and PMOS AI labels each section once; the label decides what is read. Product, pricing and compare sections are read whole. Help, release notes and API docs are read by their index pages; their deeper pages are read only when a run goes back for a gap. News is read only when the organization reads weak pages. Noise is never read.",
  organization: "Organization",
  competitor: "Competitor",
  pickCompetitor: "Pick a competitor",
  ownSite: " — own site",
  noOrganizations: "No organization yet.",
  noCompetitors: "This organization has no competitors yet.",
  pick: "Pick a competitor to see its reading plan and its analysis runs.",
  loading: "Loading the reading plan…",
  failed: "Could not load the reading plan. Try again.",
  refresh: "Refresh",
  plan: "Reading plan",
  noPlan: "No reading plan yet. The competitor's first analysis run makes it.",
  planTotals: (sections: number, pages: number, tokens: number) => `${sections} section${sections === 1 ? "" : "s"} · ${pages.toLocaleString("en-US")} page${pages === 1 ? "" : "s"} · about ${tokens.toLocaleString("en-US")} tokens to read all of it`,
  runs: "Latest analysis runs",
  noRuns: "No analysis run yet.",
  byCode: "code",
  byAi: "PMOS AI",
  budgetReached: "budget reached",
  tokens: (input: number, output: number, cached: number) => `${input.toLocaleString("en-US")} input + ${output.toLocaleString("en-US")} output${cached > 0 ? ` (${cached.toLocaleString("en-US")} cached)` : ""}`,
  tokensPerStep: "Tokens per step and model",
  models: "Models",
  noBudget: "–",
  labels: { product: "product", pricing: "pricing", compare: "compare", help: "help", release_notes: "release notes", api_docs: "API docs", news: "news", noise: "noise" } as Record<string, string>,
  read: { product: "read whole", pricing: "read whole", compare: "read whole, own claims only", help: "index pages; deeper pages on a gap", release_notes: "index pages; deeper pages on a gap", api_docs: "index pages; deeper pages on a gap", news: "only with weak pages on", noise: "never read" } as Record<string, string>,
};

const INPUT = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400 disabled:opacity-60";
const LABEL = "mb-1 block text-xs font-medium text-slate-500";
const BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50";
const TH = "px-3 py-2";
const TD = "px-3 py-2 align-top";

const LABEL_CHIP: Record<string, string> = {
  product: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pricing: "bg-emerald-50 text-emerald-700 border-emerald-200",
  compare: "bg-emerald-50 text-emerald-700 border-emerald-200",
  help: "bg-blue-50 text-blue-700 border-blue-200",
  release_notes: "bg-blue-50 text-blue-700 border-blue-200",
  api_docs: "bg-blue-50 text-blue-700 border-blue-200",
  news: "bg-amber-50 text-amber-800 border-amber-200",
  noise: "bg-slate-50 text-slate-500 border-slate-200",
};

const STATUS_CHIP: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  waiting: "bg-amber-50 text-amber-800 border-amber-200",
  queued: "bg-slate-50 text-slate-600 border-slate-200",
  cancelled: "bg-slate-50 text-slate-400 border-slate-200",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
}

type State = { status: "idle" } | { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; sections: AdminPlanSection[]; runs: AdminPlanRun[] };

export function AdminReadingPlan({ orgs, currentOrgId }: { orgs: ImportOrg[]; currentOrgId: string | null }) {
  const [orgId, setOrgId] = useState(() => (orgs.some((o) => o.id === currentOrgId) ? currentOrgId! : orgs[0]?.id ?? ""));
  const [competitorId, setCompetitorId] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const competitors = orgs.find((o) => o.id === orgId)?.competitors ?? [];

  const load = useCallback(async (id: string) => {
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/competitors/plan?competitorId=${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok || !Array.isArray(json.sections) || !Array.isArray(json.runs)) throw new Error(json.error ?? COPY.failed);
      setState({ status: "ready", sections: json.sections, runs: json.runs });
    } catch (e) {
      setState({ status: "failed", error: e instanceof Error && e.message ? e.message : COPY.failed });
    }
  }, []);

  useEffect(() => {
    void load(competitorId);
  }, [competitorId, load]);

  const shown = state.status === "ready" ? state.sections.filter((s) => s.pages > 0) : [];
  const totals = { pages: shown.reduce((n, s) => n + s.pages, 0), tokens: shown.reduce((n, s) => n + s.tokens, 0) };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-reading-plan">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold">{COPY.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{COPY.intro}</p>
        </div>
        <button onClick={() => void load(competitorId)} disabled={!competitorId || state.status === "loading"} className={`${BTN} shrink-0`}><RefreshCw size={13} /> {COPY.refresh}</button>
      </div>
      {orgs.length === 0 ? (
        <div className="text-sm text-slate-500">{COPY.noOrganizations}</div>
      ) : (
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>{COPY.organization}</span>
            <select
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setCompetitorId("");
              }}
              className={INPUT}
              data-testid="admin-plan-org"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>{COPY.competitor}</span>
            <select value={competitorId} disabled={competitors.length === 0} onChange={(e) => setCompetitorId(e.target.value)} className={INPUT} data-testid="admin-plan-competitor">
              <option value="">{COPY.pickCompetitor}</option>
              {competitors.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.host}){c.isOwn ? COPY.ownSite : ""}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {orgs.length > 0 && competitors.length === 0 && <div className="mt-3 text-sm text-slate-500">{COPY.noCompetitors}</div>}
      {orgs.length > 0 && competitors.length > 0 && state.status === "idle" && <div className="mt-3 text-sm text-slate-500">{COPY.pick}</div>}
      {state.status === "loading" && <div className="mt-3 inline-flex items-center gap-2 text-sm text-slate-500" role="status"><Loader2 size={13} className="animate-spin" /> {COPY.loading}</div>}
      {state.status === "failed" && <div className="mt-3 text-sm text-red-600" role="alert" data-testid="admin-plan-error">{state.error}</div>}

      {state.status === "ready" && (
        <>
          <h3 className="mb-1 mt-5 text-xs font-bold uppercase tracking-wide text-slate-500">{COPY.plan}</h3>
          {state.sections.length === 0 ? (
            <div className="text-sm text-slate-500" data-testid="admin-plan-empty">{COPY.noPlan}</div>
          ) : (
            <>
              <div className="mb-2 text-xs text-slate-500">{COPY.planTotals(shown.length, totals.pages, totals.tokens)}</div>
              <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <tr><th className={TH}>Section</th><th className={TH}>Label</th><th className={TH}>What is read</th><th className={`${TH} text-right`}>Pages</th><th className={`${TH} text-right`}>Estimated tokens</th><th className={TH}>Labeled</th></tr>
                  </thead>
                  <tbody>
                    {state.sections.map((s) => (
                      <tr key={s.id} className={`border-t border-slate-200 ${s.pages === 0 ? "text-slate-400" : ""}`} data-testid="admin-plan-section">
                        <td className={`${TD} font-mono`}>
                          {s.prefix}
                          {s.sourceType !== "website" && <span className="ml-2 font-sans text-slate-500">{COMPETITORS_COPY.profile.sourceTypes[s.sourceType] ?? s.sourceType}</span>}
                        </td>
                        <td className={TD}><span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${LABEL_CHIP[s.label] ?? LABEL_CHIP.noise}`}>{COPY.labels[s.label] ?? s.label}</span></td>
                        <td className={`${TD} text-slate-500`}>{COPY.read[s.label] ?? "–"}</td>
                        <td className={`${TD} text-right tabular-nums`}>{s.pages.toLocaleString("en-US")}</td>
                        <td className={`${TD} text-right tabular-nums`}>{s.tokens.toLocaleString("en-US")}</td>
                        <td className={TD}>{when(s.labeledAt)} <span className="text-slate-400">· {s.labeledBy === "code" ? COPY.byCode : COPY.byAi}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 className="mb-1 mt-5 text-xs font-bold uppercase tracking-wide text-slate-500">{COPY.runs}</h3>
          {state.runs.length === 0 ? (
            <div className="text-sm text-slate-500" data-testid="admin-plan-no-runs">{COPY.noRuns}</div>
          ) : (
            <div className="overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className={TH}>Status</th><th className={TH}>Step</th><th className={`${TH} text-right`}>Pages read / left unread</th><th className={`${TH} text-right`}>Tokens used of the budget</th><th className={`${TH} text-right`}>Go-back rounds</th><th className={TH}>Started</th><th className={TH}>Finished</th><th className={TH}>Error</th></tr>
                </thead>
                <tbody>
                  {state.runs.map((r) => (
                    <Fragment key={r.id}>
                    <tr className="border-t border-slate-200" data-testid="admin-plan-run">
                      <td className={TD}><span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${STATUS_CHIP[r.status] ?? STATUS_CHIP.queued}`}>{r.status}</span> <span className="text-slate-400">{r.trigger}</span></td>
                      <td className={TD}>{r.step.replace("_", " ")}</td>
                      <td className={`${TD} text-right tabular-nums`}>{r.pagesRead.toLocaleString("en-US")} / {r.pagesUnread.toLocaleString("en-US")}</td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {r.tokensUsed.toLocaleString("en-US")} of {r.budget ? r.budget.toLocaleString("en-US") : COPY.noBudget}
                        {r.budgetReached && <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-[11px] font-semibold text-amber-800">{COPY.budgetReached}</span>}
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{r.goBackRounds}{r.goBackPages ? <span className="text-slate-400"> · {r.goBackPages} page{r.goBackPages === 1 ? "" : "s"}</span> : null}</td>
                      <td className={TD}>{when(r.startedAt)}</td>
                      <td className={TD}>{when(r.finishedAt)}</td>
                      <td className={`${TD} max-w-[280px] text-red-700`}>{r.error ?? ""}</td>
                    </tr>
                    <tr data-testid="admin-plan-run-tokens">
                      <td className="px-3 pb-2" colSpan={8}>
                        <details>
                          <summary className="cursor-pointer text-slate-500">{COPY.tokensPerStep}: {COPY.tokens(r.inputTokens, r.outputTokens, r.cachedTokens)}</summary>
                          <div className="mt-1.5">
                            {r.model && <div className="mb-1 text-slate-500">{COPY.models}: <span className="font-mono">{r.model}</span></div>}
                            <RunUsage usage={r.usage} calls={r.calls} />
                          </div>
                        </details>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
