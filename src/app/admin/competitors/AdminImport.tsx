"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2, Upload } from "lucide-react";
import type { AdminImportResult, AdminImportSource } from "@/app/api/admin/competitors/import/route";
import { MAX_ZIP_BYTES } from "@/lib/competitors/config";
import { COMPETITORS_COPY } from "@/lib/competitors/copy";
import { AdminScans } from "./AdminScans";

/**
 * Administration → Competitors → Import pages. A PM-OS admin picks an
 * organization and one of its competitors, uploads one zip of a collector
 * bundle (the folder made by hand: manifest.json plus the text files it
 * names) and presses Import. The pages are stored and go through the same
 * pipeline as a scan; the screen then says how many pages were stored and
 * how many were dropped, per source. Customers never see this.
 *
 * The same import as `npm run competitors:scan -- --import <manifest>`.
 */

export interface ImportOrg {
  id: string;
  name: string;
  competitors: { id: string; name: string; host: string }[];
}

const MAX_ZIP_MB = Math.round(MAX_ZIP_BYTES / (1024 * 1024));

/** Every string of the section (admin screens keep their strings in the component). */
const COPY = {
  title: "Import pages",
  intro: `Upload one zip of a collector folder: manifest.json plus the text files it names. The pages are stored for the competitor you pick and go through the same pipeline as a scan. The manifest must be for that competitor's site. Up to ${MAX_ZIP_MB} MB.`,
  organization: "Organization",
  competitor: "Competitor",
  pickCompetitor: "Pick a competitor",
  noOrganizations: "No organization yet.",
  noCompetitors: "This organization has no competitors yet. Add one in its Settings → Competitors first.",
  file: "Zip file",
  button: "Import",
  importing: "Importing…",
  tooLarge: `The zip is larger than ${MAX_ZIP_MB} MB.`,
  failed: "The import did not finish. Check the scans list below before importing again.",
  done: (competitor: string) => `Imported for ${competitor}. The scans are in the list below.`,
  stored: (n: number) => `${n} page${n === 1 ? "" : "s"} stored`,
  dropped: (n: number) => `${n} dropped`,
  scan: (status: string) => `scan ${status}`,
  noPages: "no usable pages, nothing stored",
  notImported: "not imported",
  skipped: (types: string[]) => `Source type${types.length === 1 ? "" : "s"} skipped (not a known type): ${types.join(", ")}`,
  missing: (n: number) => `${n} file${n === 1 ? "" : "s"} named in the manifest ${n === 1 ? "is" : "are"} not in the zip (${n === 1 ? "its page was" : "their pages were"} dropped):`,
};

const INPUT = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400 disabled:opacity-60";
const LABEL = "mb-1 block text-xs font-medium text-slate-500";

function sourceLine(s: AdminImportSource): string {
  const name = COMPETITORS_COPY.profile.sourceTypes[s.type] ?? s.type;
  if (s.status === "not_imported") return `${name}: ${COPY.notImported}`;
  if (s.status === "no_pages") return `${name}: ${COPY.noPages} · ${COPY.dropped(s.dropped)}`;
  return `${name}: ${COPY.stored(s.pages)} · ${COPY.dropped(s.dropped)} · ${COPY.scan(s.status)}`;
}

export function AdminImport({ orgs, currentOrgId, onImported }: { orgs: ImportOrg[]; currentOrgId: string | null; onImported?: () => void }) {
  const [orgId, setOrgId] = useState(orgs.some((o) => o.id === currentOrgId) ? (currentOrgId as string) : (orgs[0]?.id ?? ""));
  const [competitorId, setCompetitorId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  /** Remounts the file input, which is the only way to empty it. */
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminImportResult | null>(null);

  const competitors = orgs.find((o) => o.id === orgId)?.competitors ?? [];
  const ready = Boolean(orgId && competitorId && file) && !busy;

  async function submit() {
    if (!ready || !file) return;
    setError(null);
    setResult(null);
    if (file.size > MAX_ZIP_BYTES) {
      setError(COPY.tooLarge);
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.set("organizationId", orgId);
      body.set("competitorId", competitorId);
      body.set("file", file);
      const res = await fetch("/api/admin/competitors/import", { method: "POST", body });
      const json = (await res.json()) as AdminImportResult & { error?: string };
      if (!res.ok) {
        setError(json.error ?? COPY.failed);
        return;
      }
      setResult(json);
      // The same zip is not imported twice by a second press.
      setFile(null);
      setFileKey((k) => k + 1);
      onImported?.();
    } catch {
      // No answer reached the screen (connection lost, server restarted): the import may have run.
      setError(COPY.failed);
      onImported?.();
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  /** Enter confirms from the two pickers too (a select does not submit its form by itself). Esc does nothing. */
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && e.target instanceof HTMLSelectElement) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="admin-import">
      <h2 className="text-sm font-bold">{COPY.title}</h2>
      <p className="mb-4 mt-0.5 text-xs text-slate-500">{COPY.intro}</p>
      {orgs.length === 0 ? (
        <div className="text-sm text-slate-500">{COPY.noOrganizations}</div>
      ) : (
        <form onSubmit={onSubmit} onKeyDown={onKeyDown}>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block">
              <span className={LABEL}>{COPY.organization}</span>
              <select
                value={orgId}
                disabled={busy}
                onChange={(e) => {
                  setOrgId(e.target.value);
                  setCompetitorId("");
                }}
                className={INPUT}
                data-testid="admin-import-org"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>{COPY.competitor}</span>
              <select value={competitorId} disabled={busy || competitors.length === 0} onChange={(e) => setCompetitorId(e.target.value)} className={INPUT} data-testid="admin-import-competitor">
                <option value="">{COPY.pickCompetitor}</option>
                {competitors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.host})</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>{COPY.file}</span>
              <input
                key={fileKey}
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border file:border-slate-200 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-slate-50 disabled:opacity-60"
                data-testid="admin-import-file"
              />
            </label>
          </div>
          {competitors.length === 0 && <div className="mt-3 text-sm text-slate-500" data-testid="admin-import-no-competitors">{COPY.noCompetitors}</div>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!ready} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60" data-testid="admin-import-submit">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy ? COPY.importing : COPY.button}
            </button>
            {error && <span className="text-sm text-red-600" role="alert" data-testid="admin-import-error">{error}</span>}
          </div>
        </form>
      )}
      {result && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="admin-import-result">
          <div className="font-medium">{COPY.done(result.competitorName)}</div>
          <ul className="mt-1 space-y-0.5">
            {result.sources.map((s, i) => (
              <li key={i} data-testid="admin-import-source">
                {sourceLine(s)}
                {s.error && <span className="text-red-700"> · {s.error}</span>}
              </li>
            ))}
          </ul>
          {result.skipped.length > 0 && <div className="mt-2 text-amber-800" data-testid="admin-import-skipped">{COPY.skipped(result.skipped)}</div>}
          {result.missing.length > 0 && (
            <div className="mt-2 text-amber-800" data-testid="admin-import-missing">
              {COPY.missing(result.missing.length)}
              <ul className="mt-1 max-h-40 overflow-auto rounded border border-amber-200 bg-white px-2 py-1 font-mono text-xs text-slate-700">
                {result.missing.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The import section above the scans list: an import that ended reloads the list, so its scans are there. */
export function AdminImportAndScans({ orgs, currentOrgId }: { orgs: ImportOrg[]; currentOrgId: string | null }) {
  const [imports, setImports] = useState(0);
  return (
    <>
      <AdminImport orgs={orgs} currentOrgId={currentOrgId} onImported={() => setImports((n) => n + 1)} />
      <AdminScans reloadKey={imports} />
    </>
  );
}
