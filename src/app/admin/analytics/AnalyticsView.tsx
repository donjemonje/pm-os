"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";

type Top = { key: string; count: number }[];
interface Data {
  days: number;
  since: string;
  totals: {
    ideas: number;
    tickets: number;
    reviewEvents: number;
    usageEvents: number;
    sessions: number;
    activeUsers: number;
    ideasTouched: number;
    approved: number;
  };
  decisions: {
    byAction: Top;
    byUser: Top;
    latest: { id: string; at: string; user: string; action: string; ideaId: string; idea: string; payload: unknown }[];
  };
  behaviour: { byEvent: Top; pages: Top; searches: Top; filters: Top };
  imports: {
    runs: number;
    failed: number;
    medianMs: number | null;
    latest: { id: string; at: string; status: string; error: string | null; ms: number | null; tickets: number | null }[];
  };
  correction: { line: string; ideas: number; corrected: number; approved: number; rate: number }[];
}

const ACTION_LABELS: Record<string, string> = {
  approve: "Approved",
  unapprove: "Unapproved",
  edit: "Edited (text / tags)",
  reassign: "Sources changed",
  rewrite: "Rewritten by PMOS AI (after source change)",
  keep_text: "Kept text (after source change)",
  approve_customer: "Customer suggestion approved",
  dismiss_customer: "Customer suggestion dismissed",
  undismiss_customer: "Customer restored",
  create_from_ticket: "Idea created from a ticket",
  inject: "Synced to Jira (created)",
  update: "Synced to Jira (updated)",
  none: "Sync: nothing to write",
  create: "Jira issue created",
  undo_push: "Sync undone",
};

const EVENT_LABELS: Record<string, string> = {
  page_view: "Page views",
  drawer_open: "Ideas opened",
  source_open: "Tickets / issues opened",
  search: "Searches",
  filter: "Filter changes",
  page_toggle: "Merge ⇄ Final",
  import_start: "Imports started",
  import_done: "Imports finished",
  import_failed: "Imports failed",
  sync_open: "Sync to Jira opened",
  edit_start: "Edits started",
};

/** A compact, human line for a review event's payload. */
function describe(action: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  switch (action) {
    case "reassign": {
      const before = (p.before ?? {}) as { zen?: string[]; jira?: string[] };
      const after = (p.after ?? {}) as { zen?: string[]; jira?: string[] };
      const diff = (a: string[] = [], b: string[] = []) => ({
        added: b.filter((x) => !a.includes(x)),
        removed: a.filter((x) => !b.includes(x)),
      });
      const z = diff(before.zen, after.zen);
      const j = diff(before.jira, after.jira);
      const parts = [
        ...z.added.map((k) => `+ZEN-${k}`),
        ...j.added.map((k) => `+${k}`),
        ...z.removed.map((k) => `−ZEN-${k}`),
        ...j.removed.map((k) => `−${k}`),
      ];
      return parts.join(" ") || "no change";
    }
    case "edit": {
      const before = (p.before ?? {}) as Record<string, unknown>;
      const after = (p.after ?? {}) as Record<string, unknown>;
      const changed: string[] = [];
      if (typeof before.title === "string" && typeof after.title === "string" && before.title !== after.title)
        changed.push(`title: "${before.title}" → "${after.title}"`);
      if (typeof before.details === "string" && typeof after.details === "string" && before.details !== after.details)
        changed.push(`text (${before.details.length} → ${after.details.length} chars)`);
      const pb = arr(before.products), pa = arr(after.products);
      const addL = pa.filter((x) => !pb.includes(x)), remL = pb.filter((x) => !pa.includes(x));
      if (addL.length || remL.length)
        changed.push(`lines ${[...addL.map((x) => "+" + x), ...remL.map((x) => "−" + x)].join(" ")}`);
      const cb = arr(before.addedCustomers), ca = arr(after.addedCustomers);
      const addC = ca.filter((x) => !cb.includes(x)), remC = [...cb.filter((x) => !ca.includes(x)), ...arr(after.removedCustomers)];
      if (addC.length) changed.push(`customers +${addC.join(", +")}`);
      if (remC.length) changed.push(`customers −${remC.join(", −")}`);
      return changed.join(" · ") || "no visible change";
    }
    case "approve_customer":
    case "dismiss_customer":
    case "undismiss_customer":
      return typeof p.name === "string" ? p.name : "";
    case "create_from_ticket":
      return typeof p.ticket === "string" ? `ticket ${p.ticket}` : "";
    case "approve":
    case "unapprove":
      return p.bulk ? "bulk" : "";
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 120) : "";
  }
}

function csvOf(rows: Data["decisions"]["latest"]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    ["at", "user", "action", "idea", "change", "ideaId"].join(","),
    ...rows.map((r) => [r.at, r.user, r.action, r.idea, describe(r.action, r.payload), r.ideaId].map(esc).join(",")),
  ].join("\n");
}

export function AnalyticsView({ organizations }: { organizations: { id: string; name: string; slug: string }[] }) {
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  useEffect(() => {
    if (!orgId) return;
    let stale = false;
    setLoading(true);
    setError("");
    fetch(`/api/admin/analytics?org=${encodeURIComponent(orgId)}&days=${days}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Failed to load");
        return d as Data;
      })
      .then((d) => {
        if (!stale) setData(d);
      })
      .catch((e) => {
        if (!stale) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [orgId, days]);

  const latest = useMemo(
    () => (data ? data.decisions.latest.filter((r) => !actionFilter || r.action === actionFilter) : []),
    [data, actionFilter],
  );

  const card = (label: string, value: string | number, hint?: string) => (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  const list = (title: string, rows: Top, labels?: Record<string, string>) => (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-500">Nothing yet.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-slate-700">{labels?.[r.key] ?? r.key}</span>
              <span className="shrink-0 font-mono text-xs font-semibold text-slate-900">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                days === d ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white hover:border-slate-500"
              }`}
            >
              {d === 365 ? "1 year" : `${d} days`}
            </button>
          ))}
        </div>
        {loading && <Loader2 size={16} className="animate-spin text-slate-500" />}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      {data && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {card("Active users", data.totals.activeUsers, `${data.totals.sessions} sessions`)}
            {card("Ideas", data.totals.ideas, `${data.totals.approved} approved · ${data.totals.tickets} tickets`)}
            {card("Decisions & edits", data.totals.reviewEvents, `${data.totals.ideasTouched} ideas corrected by a PM`)}
            {card(
              "Correction rate",
              data.totals.ideas ? `${Math.round((100 * data.totals.ideasTouched) / data.totals.ideas)}%` : "—",
              "ideas a PM changed before/after approving",
            )}
            {card("Imports", data.imports.runs, `${data.imports.failed} failed · median ${data.imports.medianMs ? `${Math.round(data.imports.medianMs / 1000)}s` : "—"}`)}
            {card("Behaviour events", data.totals.usageEvents, "page views, opens, searches, filters")}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {list("Decisions & edits by kind", data.decisions.byAction, ACTION_LABELS)}
            {list("By user", data.decisions.byUser)}
            {list("Behaviour by event", data.behaviour.byEvent, EVENT_LABELS)}
            {list("Pages", data.behaviour.pages)}
            {list("Searches", data.behaviour.searches)}
            {list("Filters used", data.behaviour.filters)}
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-bold">Correction rate by product line</h3>
            <p className="mb-3 text-xs text-slate-500">
              Ideas in the line, how many a PM changed (text, tags, sources, customers), how many are approved.
              High correction = PMOS AI is weak there: check the product line description and the examples.
            </p>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-4">Product line</th>
                  <th className="py-1 pr-4">Ideas</th>
                  <th className="py-1 pr-4">Corrected</th>
                  <th className="py-1 pr-4">Approved</th>
                  <th className="py-1">Correction rate</th>
                </tr>
              </thead>
              <tbody>
                {data.correction.map((r) => (
                  <tr key={r.line} className="border-t border-slate-100">
                    <td className="py-1.5 pr-4 font-medium">{r.line}</td>
                    <td className="py-1.5 pr-4">{r.ideas}</td>
                    <td className="py-1.5 pr-4">{r.corrected}</td>
                    <td className="py-1.5 pr-4">{r.approved}</td>
                    <td className="py-1.5">
                      <span className={r.rate >= 50 ? "font-semibold text-red-700" : r.rate >= 25 ? "text-amber-700" : "text-slate-700"}>
                        {r.rate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-bold">What they changed</h3>
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                <option value="">All actions</option>
                {data.decisions.byAction.map((a) => (
                  <option key={a.key} value={a.key}>
                    {ACTION_LABELS[a.key] ?? a.key} ({a.count})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([csvOf(latest)], { type: "text/csv" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `pmos-analytics-${orgId}-${days}d.csv`;
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium hover:border-slate-500"
              >
                <Download size={13} /> CSV
              </button>
            </div>
            {latest.length === 0 ? (
              <div className="text-xs text-slate-500">No decisions or edits in this window.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1 pr-4">When</th>
                    <th className="py-1 pr-4">User</th>
                    <th className="py-1 pr-4">Action</th>
                    <th className="py-1 pr-4">Idea</th>
                    <th className="py-1">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100 align-top">
                      <td className="whitespace-nowrap py-1.5 pr-4 font-mono text-xs text-slate-500">
                        {new Date(r.at).toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-4">{r.user}</td>
                      <td className="py-1.5 pr-4">{ACTION_LABELS[r.action] ?? r.action}</td>
                      <td className="max-w-[280px] truncate py-1.5 pr-4" title={r.idea}>
                        {r.idea}
                      </td>
                      <td className="py-1.5 font-mono text-xs text-slate-700">{describe(r.action, r.payload)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-bold">Imports</h3>
            {data.imports.latest.length === 0 ? (
              <div className="text-xs text-slate-500">No imports in this window.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.imports.latest.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs text-slate-500">{new Date(i.at).toLocaleString()}</span>
                    <span className={i.status === "completed" ? "text-emerald-700" : "text-red-700"}>{i.status}</span>
                    {i.tickets != null && <span className="text-slate-700">{i.tickets} tickets</span>}
                    {i.ms != null && <span className="text-slate-500">{Math.round(i.ms / 1000)}s</span>}
                    {i.error && <span className="truncate text-red-700" title={i.error}>{i.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
