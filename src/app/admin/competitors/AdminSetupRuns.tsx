"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { AdminSetupRun, AdminSetupState } from "@/app/api/admin/competitors/setup/route";
import { ORG_SETUP_STATES, type OrgSetupState } from "@/lib/competitors/analysis/setup-rules";
import type { ImportOrg } from "./AdminImport";
import { RunCaps, RunPacing, RunUsage } from "./RunUsage";

/**
 * Administration → Competitors → Setup runs (PM-OS admin only). Pick an organization: its setup state (required →
 * in setup → done; it can be set by hand here — the customer never can), its own site, and its setup runs — status, step, what the run made, tokens, error, started and finished —
 * with the progress of every company (the own site first). Nothing is started here: the setup run is started from
 * the scanner command line. Customers never see this.
 */

/** Every string of the section (admin screens keep their strings in the component). */
const COPY = {
  title: "Setup runs",
  intro: "Setup is a state of the organization: required → in setup → done. Turning Competitors on (Enablements) makes it required; the setup run moves it to in setup and, when it has finished, to done. Until it is done an analysis creates no row and the organization's Competitors pages say \"being set up\". The setup run reads the organization's own site and every competitor, unifies their capabilities into rows, builds the domains from the rows and fills the table. It is started by hand from the scanner command line (--own-site <workspaceId> <url>, then --setup <workspaceId>), and a run that stopped is continued by the same command. The runs below are read-only; the state can be set by hand.",
  organization: "Organization",
  noOrganizations: "No organization yet.",
  loading: "Loading the setup runs…",
  failed: "Could not load the setup runs. Try again.",
  refresh: "Refresh",
  state: { done: "Done", in_setup: "In setup", required: "Required" } as Record<string, string>,
  stateHint: {
    done: "The organization is set up: analysis runs create rows and fill cells, and its pages show the table.",
    in_setup: "A setup run was queued and has not finished. Until it has, analysis runs stop after the clean-up and create no row; the pages say \"being set up\".",
    required: "Competitors is on and the setup run has not been started. Analysis runs stop after the clean-up and create no row; the pages say \"being set up\".",
  } as Record<string, string>,
  stateFromData: "Never set — read from the organization's data: a catalog means done, a setup run that did not finish means in setup, anything else required.",
  setState: "Set the state by hand",
  setStateConfirm: (org: string, to: string) => `Set the setup state of ${org} to "${to}"? The customer sees the change at once: until the state is Done, the Competitors pages say "being set up" and no analysis creates a row.`,
  setStateFailed: "Could not set the state. Try again.",
  ownSite: "Own site",
  noOwnSite: "none — the setup run needs one",
  catalog: (domains: number, capabilities: number) => `${domains} domain${domains === 1 ? "" : "s"} · ${capabilities} capabilit${capabilities === 1 ? "y" : "ies"} (any state)`,
  workspace: "Workspace id",
  noRuns: "No setup run yet.",
  made: (r: AdminSetupRun) => `${r.domains} domain${r.domains === 1 ? "" : "s"} · ${r.rows} capabilit${r.rows === 1 ? "y" : "ies"} · ${r.features} feature${r.features === 1 ? "" : "s"}`,
  budgetReached: "budget reached",
  tokens: (input: number, output: number, cached: number, thinking: number) => `${input.toLocaleString("en-US")} input + ${output.toLocaleString("en-US")} output${thinking > 0 ? `, ${thinking.toLocaleString("en-US")} of them thinking` : ""}${cached > 0 ? ` (${cached.toLocaleString("en-US")} cached)` : ""}`,
  tokensPerStep: "Tokens per step and model — the whole run",
  sharedTokens: "Of those, the calls that belong to no company (unify, domains)",
  companyTokens: "Tokens per step and model",
  models: "Models",
  own: "own site",
  stages: { waiting: "waiting", map: "map", research: "research", merge: "merge", unify: "unify", match: "match", second_look: "second look", apply: "apply", facts: "facts", done: "done" } as Record<string, string>,
};

const INPUT = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400 disabled:opacity-60";
const LABEL = "mb-1 block text-xs font-medium text-slate-500";
const BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50";
const TH = "px-3 py-2";
const TD = "px-3 py-2 align-top";

const STATUS_CHIP: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  waiting: "bg-amber-50 text-amber-800 border-amber-200",
  queued: "bg-slate-50 text-slate-600 border-slate-200",
  cancelled: "bg-slate-50 text-slate-400 border-slate-200",
};
const STATE_CHIP: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  in_setup: "bg-amber-50 text-amber-800 border-amber-200",
  required: "bg-slate-50 text-slate-600 border-slate-200",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
}

type State = { status: "idle" } | { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; data: AdminSetupState };

export function AdminSetupRuns({ orgs, currentOrgId }: { orgs: ImportOrg[]; currentOrgId: string | null }) {
  const [orgId, setOrgId] = useState(() => (orgs.some((o) => o.id === currentOrgId) ? currentOrgId! : orgs[0]?.id ?? ""));
  const [state, setState] = useState<State>({ status: "idle" });

  const load = useCallback(async (id: string) => {
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/admin/competitors/setup?organizationId=${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok || !Array.isArray(json.runs)) throw new Error(json.error ?? COPY.failed);
      setState({ status: "ready", data: json as AdminSetupState });
    } catch (e) {
      setState({ status: "failed", error: e instanceof Error && e.message ? e.message : COPY.failed });
    }
  }, []);

  useEffect(() => {
    void load(orgId);
  }, [orgId, load]);

  const [setting, setSetting] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);
  /** A PM-OS admin sets the organization's setup state by hand — asked once, then written and read back. */
  async function setSetup(to: OrgSetupState) {
    const org = orgs.find((o) => o.id === orgId);
    if (!org || !window.confirm(COPY.setStateConfirm(org.name, COPY.state[to]))) return;
    setSetting(true);
    setSetError(null);
    try {
      const res = await fetch("/api/admin/competitors/setup", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: orgId, state: to }) });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? COPY.setStateFailed);
      await load(orgId);
    } catch (e) {
      setSetError(e instanceof Error && e.message ? e.message : COPY.setStateFailed);
    } finally {
      setSetting(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-setup-runs">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold">{COPY.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{COPY.intro}</p>
        </div>
        <button onClick={() => void load(orgId)} disabled={!orgId || state.status === "loading"} className={`${BTN} shrink-0`}><RefreshCw size={13} /> {COPY.refresh}</button>
      </div>
      {orgs.length === 0 ? (
        <div className="text-sm text-slate-500">{COPY.noOrganizations}</div>
      ) : (
        <label className="block max-w-sm">
          <span className={LABEL}>{COPY.organization}</span>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={INPUT} data-testid="admin-setup-org">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
      )}
      {state.status === "loading" && <div className="mt-3 inline-flex items-center gap-2 text-sm text-slate-500" role="status"><Loader2 size={13} className="animate-spin" /> {COPY.loading}</div>}
      {state.status === "failed" && <div className="mt-3 text-sm text-red-600" role="alert" data-testid="admin-setup-error">{state.error}</div>}

      {state.status === "ready" && (
        <>
          <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">State</dt>
            <dd>
              <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${STATE_CHIP[state.data.state] ?? STATE_CHIP.required}`} data-testid="admin-setup-state">{COPY.state[state.data.state] ?? state.data.state}</span>
              <span className="ml-2 text-xs text-slate-500">{COPY.stateHint[state.data.state] ?? ""}</span>
              {!state.data.stateSet && <div className="mt-1 text-xs text-slate-500" data-testid="admin-setup-state-from-data">{COPY.stateFromData}</div>}
              <label className="mt-2 block max-w-[220px]">
                <span className={LABEL}>{COPY.setState}</span>
                <select value={state.data.state} disabled={setting} onChange={(e) => void setSetup(e.target.value as OrgSetupState)} className={INPUT} data-testid="admin-setup-set-state">
                  {ORG_SETUP_STATES.map((v) => <option key={v} value={v}>{COPY.state[v]}</option>)}
                </select>
              </label>
              {setError && <div className="mt-1 text-xs text-red-600" role="alert">{setError}</div>}
            </dd>
            <dt className="text-slate-500">{COPY.ownSite}</dt>
            <dd className="text-xs">{state.data.ownSite ? <>{state.data.ownSite.name} <span className="font-mono text-slate-500">({state.data.ownSite.host})</span></> : <span className="text-slate-500">{COPY.noOwnSite}</span>}</dd>
            <dt className="text-slate-500">Catalog</dt>
            <dd className="text-xs">{COPY.catalog(state.data.domains, state.data.capabilities)}</dd>
            <dt className="text-slate-500">{COPY.workspace}</dt>
            <dd className="font-mono text-xs">{state.data.workspaceId}</dd>
          </dl>

          {state.data.runs.length === 0 ? (
            <div className="mt-4 text-sm text-slate-500" data-testid="admin-setup-no-runs">{COPY.noRuns}</div>
          ) : (
            state.data.runs.map((r) => (
              <div key={r.id} className="mt-4 rounded-lg border border-slate-200" data-testid="admin-setup-run">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                  <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${STATUS_CHIP[r.status] ?? STATUS_CHIP.queued}`}>{r.status}</span>
                  <span>Step: <b>{r.step.replace("_", " ")}</b></span>
                  <span>{COPY.made(r)}</span>
                  <span className="tabular-nums">{r.calls.toLocaleString("en-US")} PMOS AI calls · {COPY.tokens(r.inputTokens, r.outputTokens, r.cachedTokens, r.thinkingTokens)} tokens</span>
                  <span>Started {when(r.startedAt)}</span>
                  <span>Finished {when(r.finishedAt)}</span>
                  <span className="font-mono text-slate-400">{r.id}</span>
                </div>
                {r.error && <div className="border-b border-slate-200 px-3 py-2 text-xs text-red-700" data-testid="admin-setup-run-error">{r.error}</div>}
                <div className="border-b border-slate-200 px-3 py-2" data-testid="admin-setup-run-caps">
                  <RunCaps caps={r.caps} recorded active={r.status === "queued" || r.status === "running" || r.status === "waiting"} />
                </div>
                <div className="border-b border-slate-200 px-3 py-2 text-xs" data-testid="admin-setup-run-tokens">
                  {r.model && <div className="mb-1 text-slate-500">{COPY.models}: <span className="font-mono">{r.model}</span></div>}
                  <details>
                    <summary className="cursor-pointer text-slate-500">{COPY.tokensPerStep}</summary>
                    <div className="mt-1.5"><RunUsage usage={r.usage} calls={r.calls} /></div>
                    <div className="mt-2"><RunPacing pacing={r.pacing} /></div>
                    {r.sharedUsage.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1 text-slate-500">{COPY.sharedTokens}</div>
                        <RunUsage usage={r.sharedUsage} calls={r.calls} />
                      </div>
                    )}
                  </details>
                </div>
                {r.companies.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-500">The run has not started on a company yet.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <tr><th className={TH}>Company</th><th className={TH}>Where it is</th><th className={`${TH} text-right`}>Pages read / left unread</th><th className={`${TH} text-right`}>PMOS AI calls</th><th className={`${TH} text-right`}>Tokens used of the budget per company</th></tr>
                    </thead>
                    <tbody>
                      {r.companies.map((c) => (
                        <Fragment key={c.competitorId}>
                        <tr className="border-t border-slate-200" data-testid="admin-setup-company">
                          <td className={TD}>{c.name}{c.own && <span className="ml-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-px text-[11px] font-semibold text-slate-600">{COPY.own}</span>}</td>
                          <td className={TD}>{COPY.stages[c.stage] ?? c.stage}</td>
                          <td className={`${TD} text-right tabular-nums`}>{c.pagesRead.toLocaleString("en-US")} / {c.pagesUnread.toLocaleString("en-US")}</td>
                          <td className={`${TD} text-right tabular-nums`}>{c.calls.toLocaleString("en-US")}</td>
                          <td className={`${TD} text-right tabular-nums`}>
                            {c.tokensUsed.toLocaleString("en-US")} of {r.budget ? r.budget.toLocaleString("en-US") : "–"}
                            {c.budgetReached && <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-[11px] font-semibold text-amber-800">{COPY.budgetReached}</span>}
                          </td>
                        </tr>
                        <tr data-testid="admin-setup-company-tokens">
                          <td className="px-3 pb-2" colSpan={5}>
                            {c.caps.length > 0 && <div className="mb-1.5"><RunCaps caps={c.caps} recorded /></div>}
                            <details>
                              <summary className="cursor-pointer text-slate-500">{COPY.companyTokens}: {COPY.tokens(c.inputTokens, c.outputTokens, c.cachedTokens, c.thinkingTokens)}</summary>
                              <div className="mt-1.5"><RunUsage usage={c.usage} calls={c.calls} /></div>
                            </details>
                          </td>
                        </tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}
