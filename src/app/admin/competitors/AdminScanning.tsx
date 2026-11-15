"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AdminSourceRow } from "@/app/api/admin/competitors/settings/route";
import type { ScannerKeyRow } from "@/lib/competitors/local";

/**
 * Administration → Competitors → Scanning (Website Scanning PRD 2026-11-04).
 * The switches that are PM-OS's, never a customer's: the remote lane ON/OFF
 * (default OFF for now), the local stations' machine keys (created once,
 * rotated by the poller, revoked here), and every source's scan frequency in
 * days. No retention setting: a change replaces a page's text (PRD).
 */

interface Payload {
  settings: { remoteScanEnabled: boolean; analysisDisabled: boolean };
  keys: ScannerKeyRow[];
  sources: AdminSourceRow[];
  testKnobs: boolean;
}

const INPUT = "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400 disabled:opacity-60";
const BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
}

export function AdminScanning() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [label, setLabel] = useState("Daniel's Mac");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/competitors/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function patch(body: unknown) {
    const json = await call("PATCH", "/api/admin/competitors/settings", body);
    if (json) setData(json as unknown as Payload);
  }

  async function createKey() {
    const json = await call("POST", "/api/admin/competitors/keys", { label });
    if (json) {
      setNewSecret(String(json.secret));
      await load();
    }
  }

  async function revokeKey(id: string) {
    const json = await call("DELETE", `/api/admin/competitors/keys?id=${encodeURIComponent(id)}`);
    if (json) await load();
  }

  if (!data) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
        {error ? <span className="text-red-600">{error}</span> : <span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading scanning settings…</span>}
      </section>
    );
  }

  return (
    <>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      {/* Lanes */}
      <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-scanning-lanes">
        <h2 className="text-sm font-bold">Scanning</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          Global, every organization. The remote lane is the scanner job in GCP, identified as PM-OS. While it is off every scan goes to a local station (a PM's Mac, reading the site with its own browser identity). Customers never see lanes: their row says a scan is pending, in progress, or what it found.
        </p>
        <div className="flex flex-wrap items-end gap-8">
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={data.settings.remoteScanEnabled} disabled={busy} onChange={(e) => void patch({ remoteScanEnabled: e.target.checked })} className="h-4 w-4" data-testid="admin-remote-toggle" />
            <span>
              <span className="font-medium">Remote scan</span>
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-px text-[11px] font-semibold text-slate-600">{data.settings.remoteScanEnabled ? "ON" : "OFF"}</span>
              <span className="block text-xs text-slate-500">Default OFF for now (Daniel, 2026-11-04). When off, every scan is parked for the local station.</span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={data.settings.analysisDisabled} disabled={busy} onChange={(e) => void patch({ analysisDisabled: e.target.checked })} className="h-4 w-4" data-testid="admin-analysis-toggle" />
            <span>
              <span className="font-medium">Disable analysis</span>
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-px text-[11px] font-semibold text-slate-600">{data.settings.analysisDisabled ? "ON" : "OFF"}</span>
              <span className="block text-xs text-slate-500">Default OFF. When on, a scan ends after its pages are saved: PMOS AI is not called and nothing changes in the matrix or the feed.</span>
            </span>
          </label>
          {data.testKnobs && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-[11px] font-semibold text-amber-800" title="COMPETITORS_TEST_KNOBS=on — the clock and the scheduler tick can be set from the tests. Never in production.">Test knobs on</span>}
        </div>
      </section>

      {/* Stations */}
      <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-scanning-stations">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold">Local stations</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Machine keys of the machines that run the local lane (server-to-server: no expiry, no re-login). Created once here, copied to the station, rotated by the poller every 30 days on its own. Revoking is the only manual act. One key serves every organization.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={`${INPUT} w-44`} placeholder="Station name" disabled={busy} aria-label="Station name" />
            <button onClick={() => void createKey()} disabled={busy || !label.trim()} className={BTN} data-testid="admin-create-key"><Plus size={13} /> New station key</button>
          </div>
        </div>
        {newSecret && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="admin-new-key">
            <div className="mb-1 font-medium text-emerald-900">Copy this key now — it is shown once.</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{newSecret}</code>
              <button onClick={() => { void navigator.clipboard?.writeText(newSecret).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} className={BTN}>{copied ? <Check size={13} /> : <Copy size={13} />} Copy</button>
              <button onClick={() => setNewSecret(null)} className={BTN}>Done</button>
            </div>
            <div className="mt-2 text-xs text-emerald-900">On the station: <code className="rounded bg-white px-1 py-px font-mono">sh scripts/pmos-local-scan/install.sh &lt;env&gt; &lt;app url&gt; &lt;key&gt;</code> (scripts/pmos-local-scan/README.md).</div>
          </div>
        )}
        {data.keys.length === 0 ? (
          <div className="text-sm text-slate-500">No station yet. Without one, a scan that needs the local lane fails with &quot;local scanning is not set up&quot; instead of waiting forever.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Station</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Last check-in</th><th className="px-3 py-2">Last rotation</th><th className="px-3 py-2">State</th><th className="px-3 py-2" /></tr></thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id} className="border-t border-slate-200" data-testid="admin-key-row">
                    <td className="px-3 py-2 font-medium"><span className="inline-flex items-center gap-1.5"><KeyRound size={12} className="text-slate-400" />{k.label}</span></td>
                    <td className="px-3 py-2">{when(k.createdAt)}</td>
                    <td className="px-3 py-2">{when(k.lastUsedAt)}</td>
                    <td className="px-3 py-2">{when(k.rotatedAt)}</td>
                    <td className="px-3 py-2">{k.revokedAt ? <span className="text-red-700">revoked {when(k.revokedAt)}</span> : <span className="text-emerald-700">active</span>}</td>
                    <td className="px-3 py-2 text-right">{!k.revokedAt && <button onClick={() => void revokeKey(k.id)} disabled={busy} className={`${BTN} text-red-700`} title="Revoke — the station stops at its next check-in"><Trash2 size={12} /> Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Sources */}
      <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-scanning-sources">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold">Scan frequency per source</h2>
            <p className="mt-0.5 text-xs text-slate-500">Every website source, all organizations. Default every 2 days; the hourly tick starts a scan when the last one is older than this.</p>
          </div>
          <button onClick={() => void load()} disabled={busy} className={BTN}><RefreshCw size={13} /> Refresh</button>
        </div>
        {data.sources.length === 0 ? (
          <div className="text-sm text-slate-500">No competitors yet in any organization.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Organization</th><th className="px-3 py-2">Competitor</th><th className="px-3 py-2">Site</th><th className="px-3 py-2">Every (days)</th><th className="px-3 py-2">Last scan</th><th className="px-3 py-2">State</th></tr></thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.id} className="border-t border-slate-200" data-testid="admin-source-row">
                    <td className="px-3 py-2">{s.orgName}</td>
                    <td className="px-3 py-2 font-medium">{s.competitorName}</td>
                    <td className="px-3 py-2 text-slate-500">{s.url.replace(/^https?:\/\//, "")}</td>
                    <td className="px-3 py-2">
                      <select value={s.scanEveryDays} disabled={busy} onChange={(e) => void patch({ sourceId: s.id, scanEveryDays: Number(e.target.value) })} className={`${INPUT} w-20`} aria-label={`Scan ${s.competitorName} every N days`}>
                        {[1, 2, 3, 5, 7, 14, 30].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">{when(s.lastScanAt)}</td>
                    <td className="px-3 py-2">{s.lastStatus === "running" ? <span className="text-slate-600">the station is reading{s.pendingSince ? ` (waited since ${when(s.pendingSince)})` : ""}</span> : s.pendingSince ? <span className="text-slate-600">pending for the station since {when(s.pendingSince)}</span> : s.lastStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
