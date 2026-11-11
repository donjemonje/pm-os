"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, Globe, GripVertical, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { ColorSwatch } from "@/components/settings/ColorSwatch";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { isAnalysisActive, MAX_CAPABILITY_DESCRIPTION, MAX_DOMAIN_DESCRIPTION, MAX_DOMAIN_SUMMARY, MAX_OWN_PRODUCT, OWN_STATUS_VALUES } from "@/lib/competitors/config";
import { ownProductLabel } from "@/lib/competitors/ownProduct";
import type { CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow, RemovedCapabilityRow, RemovedRow } from "@/lib/competitors/store";
import { PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { mentionsName } from "@/lib/competitors/mentions";
import { scanSummaryLine } from "@/lib/competitors/summary";
import { shortDate, timeAgo, timeUntil } from "@/lib/competitors/time";
import { track } from "@/lib/analytics/track";
import { cn } from "@/lib/utils";
import { ScanLogDrawer } from "./ScanLogDrawer";
import { MoveDomainDialog } from "./MoveDomainDialog";

const INPUT =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)] disabled:opacity-60";
const SELECT = INPUT + " pr-8";
const SMALL_BTN =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-white px-3 text-[12px] font-medium hover:border-primary disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BTN = "rounded-md p-1.5 text-fg-muted hover:bg-background hover:text-foreground disabled:opacity-40";

const STATUS_PILL: Record<string, string> = {
  full: "bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
  incomplete: "bg-[#fff7e0] text-[#8a5a00]",
  blocked: "bg-[#fff7e0] text-[#8a5a00]",
  unreachable: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  stale: "bg-[#fff7e0] text-[#8a5a00]",
  running: "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]",
  pending: "bg-[#eef1f6] text-[#4a5b74]",
  pendingLate: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  never: "bg-[#eef1f6] text-[#4a5b74]",
};
const PENDING_LATE_MS = 24 * 3600_000;

const POLL_MS = 3000;

/**
 * Settings → Competitors: competitors (with Scan now and the scan log),
 * suggestions waiting for review, domains (with the definition text PMOS AI
 * reads), the capability catalog with the org's own status per row, and the
 * scan schedule. The organization itself is never scanned. Reads are for everyone; catalog and schedule writes
 * need a customer admin (the API enforces the same). Scan now and the log are
 * for every member.
 */
export function CompetitorsSettings({ initialState, canEdit, isPmosAdmin = false }: { initialState: CompetitorsState; canEdit: boolean; isPmosAdmin?: boolean }) {
  const { confirm } = useConfirm();
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<CompetitorRow | null>(null);
  /** The domain being removed while it still holds capabilities: the PM is asked once where they go. */
  const [movingOut, setMovingOut] = useState<{ domain: DomainRow; count: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    // One failed refresh (a dev restart, a 502) must not end the polling that tells the user the scan finished.
    try {
      const res = await fetch("/api/competitors");
      const data = await res.json();
      if (res.ok) setState(data.state);
    } catch {
      // try again on the next tick
    }
  }, []);

  const [note, setNote] = useState<string | null>(null);
  const lastResponse = useRef<Record<string, unknown> | null>(null);

  async function call(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? C.errors.generic);
      lastResponse.current = data;
      if (data.state) setState(data.state);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : C.errors.generic);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ——— Scan now + polling until the scan leaves queued/running ———
  const scanning = state.scanning;
  const analyzing = state.analyzing;
  useEffect(() => {
    if (!scanning && !analyzing) return;
    const tick = async () => {
      await refresh();
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [scanning, analyzing, refresh]);

  async function scanNow(c: CompetitorRow) {
    setError(null);
    try {
      const res = await fetch("/api/competitors/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitorId: c.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? C.errors.scanFailed);
        return;
      }
    } catch {
      setError(C.errors.scanFailed);
      return;
    }
    await refresh();
  }

  // ——— Competitors ———
  async function removeCompetitor(c: CompetitorRow) {
    if (!(await confirm({ title: C.settings.removeTitle(c.name), message: C.settings.removeBody, confirmLabel: C.settings.removeConfirm, tone: "danger" }))) return;
    await call("DELETE", `/api/competitors/${c.id}`);
  }

  const competitors = state.competitors;
  const suggested = state.capabilities.filter((k) => k.state === "suggested");
  const active = state.capabilities.filter((k) => k.state === "active");
  // Suggested domains are decided in the matrix (dashed group); the catalog panels show accepted ones.
  const activeDomains = state.domains.filter((d) => d.state === "active");
  const nextScanAt = (c: CompetitorRow) =>
    c.source?.lastScanAt ? new Date(new Date(c.source.lastScanAt).getTime() + c.source.scanEveryDays * 86_400_000).toISOString() : null;

  return (
    <div className="space-y-8">
      {error && <div className="rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">{error}</div>}
      {note && <div className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0f7a47]"><Check size={12} strokeWidth={2.5} />{note}</div>}
      {!canEdit && <div className="text-[12.5px] text-fg-muted">{C.settings.viewOnly}</div>}

      {/* Competitors */}
      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="font-medium text-foreground">{C.settings.competitorsTitle}</div>
          <p className="mt-1 text-sm text-muted">{C.settings.competitorsBlurb}</p>
        </div>
        {canEdit && <AddCompetitorForm busy={busy} onAdd={(body) => call("POST", "/api/competitors", body)} />}
        {competitors.length === 0 ? (
          <div className="px-5 py-4 text-sm text-muted">{C.settings.emptyCompetitors}</div>
        ) : (
          competitors.map((c) => (
            <CompetitorLine key={c.id} c={c} busy={busy} scanning={scanning} canEdit={canEdit} nextScanAt={nextScanAt(c)}
              rescanLimited={state.rescanLimitEnforced && !isPmosAdmin && c.manualScansToday >= state.config.manualRescansPerDay}
              onScan={scanNow} onLog={setLogFor} onRemove={removeCompetitor} onSave={(id, body) => call("PATCH", `/api/competitors/${id}`, body)} />
          ))
        )}
      </section>

      {/* Suggestions / proposed catalog */}
      {suggested.length > 0 && (
        <SuggestionsPanel
          suggested={suggested}
          domains={state.domains.filter((d) => d.state !== "dismissed")}
          competitors={state.competitors}
          canEdit={canEdit}
          busy={busy}
          onDecide={(id, body) => call("PATCH", `/api/competitors/capabilities/${id}`, body)}
        />
      )}

      {/* Domains */}
      <DomainsPanel domains={activeDomains} capabilities={active} cells={state.cells} competitors={state.competitors} canEdit={canEdit} busy={busy}
        onAdd={(body) => call("POST", "/api/competitors/domains", body)}
        onSave={(id, body) => call("PATCH", `/api/competitors/domains/${id}`, body)}
        onRename={async (d, body) => {
          // Domain names cross-reference each other in the definition texts: say what the rename touches.
          const newName = String((body as { name?: string }).name ?? "").trim();
          const mentions = state.domains.filter((o) => o.id !== d.id && mentionsName(o.description, d.name)).length
            + state.capabilities.filter((k) => mentionsName(k.description, d.name)).length;
          if (!(await confirm({ title: C.settings.renameDomainTitle(d.name, newName), message: C.settings.renameDomainBody(mentions), confirmLabel: C.settings.renameDomainConfirm }))) return false;
          setNote(null);
          const ok = await call("PATCH", `/api/competitors/domains/${d.id}`, body);
          if (ok) {
            const n = Number(lastResponse.current?.renamedReferences ?? 0);
            setNote(C.settings.renamedDomain(n));
            setTimeout(() => setNote(null), 4000);
          }
          return ok;
        }}
        onReorder={(order) => call("PUT", "/api/competitors/domains", { order })}
        onRemove={async (d) => {
          // Capabilities in the table and suggestions waiting in the domain both outlive it.
          const n = state.capabilities.filter((k) => k.domainId === d.id && (k.state === "active" || k.state === "suggested")).length;
          if (n > 0) {
            if (activeDomains.length < 2) {
              setError(C.settings.removeDomainLast);
              return;
            }
            setError(null);
            setMovingOut({ domain: d, count: n });
            return;
          }
          if (!(await confirm({ title: C.settings.removeDomainTitle(d.name), message: C.settings.removeDomainBody, confirmLabel: C.settings.remove, tone: "danger" }))) return;
          await call("DELETE", `/api/competitors/domains/${d.id}`);
        }}
      />

      {/* Capabilities */}
      <CapabilitiesPanel capabilities={active} domains={activeDomains} productLines={state.productLines} canEdit={canEdit} busy={busy}
        onAdd={(body) => call("POST", "/api/competitors/capabilities", body)}
        onSave={(id, body) => call("PATCH", `/api/competitors/capabilities/${id}`, body)}
        onRemove={async (k) => {
          if (!(await confirm({ title: C.settings.removeCapabilityTitle(k.name), message: C.settings.removeCapabilityBody, confirmLabel: C.settings.remove, tone: "danger" }))) return;
          await call("DELETE", `/api/competitors/capabilities/${k.id}`);
        }}
      />

      {/* Removed by the team: scans never add these back; restorable */}
      {canEdit && (state.removed.domains.length > 0 || state.removed.capabilities.length > 0) && (
        <RemovedPanel removed={state.removed} domains={activeDomains} busy={busy}
          onRestore={async (url, body) => {
            setNote(null);
            const ok = await call("PATCH", url, body);
            if (ok) {
              setNote(C.settings.restored);
              setTimeout(() => setNote(null), 4000);
            }
          }}
        />
      )}

      {/* Schedule */}
      <SchedulePanel config={state.config} canEdit={canEdit} busy={busy} onSave={(body) => call("PATCH", "/api/competitors/settings", body)} />

      {/* Notifications */}
      <NotificationsPanel members={state.members} selected={state.config.notifyUserIds} canEdit={canEdit} busy={busy} onSave={(ids) => call("PATCH", "/api/competitors/settings", { notifyUserIds: ids })} />

      {logFor && <ScanLogDrawer competitorId={logFor.id} competitorName={logFor.name} onClose={() => setLogFor(null)} />}
      {movingOut && (
        <MoveDomainDialog domain={movingOut.domain} count={movingOut.count} targets={activeDomains.filter((d) => d.id !== movingOut.domain.id)} busy={busy}
          onCancel={() => setMovingOut(null)}
          onConfirm={async (moveTo) => {
            const id = movingOut.domain.id;
            setMovingOut(null);
            await call("DELETE", `/api/competitors/domains/${id}?moveTo=${encodeURIComponent(moveTo)}`);
          }}
        />
      )}
    </div>
  );
}

// ————— Removed —————

function RemovedPanel({ removed, domains, busy, onRestore }: {
  removed: { domains: RemovedRow[]; capabilities: RemovedCapabilityRow[] };
  /** The domains in the table — where a capability can return to. */
  domains: DomainRow[];
  busy: boolean;
  onRestore: (url: string, body: unknown) => Promise<void>;
}) {
  return (
    <section className="rounded-xl border border-border bg-card" data-testid="cmp-removed">
      <div className="border-b border-border px-5 py-4">
        <div className="font-medium text-foreground">{C.settings.removedTitle}</div>
        <p className="mt-1 text-sm text-muted">{C.settings.removedBlurb}</p>
      </div>
      {removed.domains.length > 0 && (
        <div>
          <div className="px-5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{C.settings.removedDomains}</div>
          {removed.domains.map((d) => (
            <div key={d.id} className="flex items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0" data-testid="cmp-removed-domain" data-name={d.name}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground" title={d.name}>{d.name}</div>
                <div className="text-[12px] text-fg-muted">{C.settings.removedBy(d.removedByName, shortDate(d.removedAt))}</div>
              </div>
              <button className={SMALL_BTN} disabled={busy} data-testid="cmp-restore" onClick={() => onRestore(`/api/competitors/domains/${d.id}`, { state: "active" })}>
                <RotateCcw size={12} />{C.settings.restore}
              </button>
            </div>
          ))}
        </div>
      )}
      {removed.capabilities.length > 0 && (
        <div>
          <div className="px-5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{C.settings.removedCapabilities}</div>
          {removed.capabilities.map((k) => <RemovedCapabilityLine key={k.id} k={k} domains={domains} busy={busy} onRestore={onRestore} />)}
        </div>
      )}
    </section>
  );
}

function RemovedCapabilityLine({ k, domains, busy, onRestore }: {
  k: RemovedCapabilityRow;
  domains: DomainRow[];
  busy: boolean;
  onRestore: (url: string, body: unknown) => Promise<void>;
}) {
  // Its own domain is in the table: it returns there. Otherwise the PM picks where it returns to.
  const [domainId, setDomainId] = useState("");
  const needsDomain = !k.domainActive;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0" data-testid="cmp-removed-capability" data-name={k.name}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" title={k.name}>{k.name}</div>
        <div className="text-[12px] text-fg-muted">
          {k.domainName ? `${k.domainName} · ` : ""}{C.settings.removedBy(k.removedByName, shortDate(k.removedAt))}
        </div>
        {needsDomain && <div className="mt-0.5 text-[12px] text-[#8a5a00]">{C.settings.restoreDomainHint(k.domainName)}</div>}
      </div>
      {needsDomain && (
        <label className="flex items-center gap-2 text-[12px] text-fg-muted">
          {C.settings.restoreInto}
          <select className={cn(SELECT, "h-8 w-44 py-1 text-[12.5px]")} value={domainId} disabled={busy} data-testid="cmp-restore-domain" onChange={(e) => setDomainId(e.target.value)}>
            <option value="" disabled>{C.settings.removeDomainMovePlaceholder}</option>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      <button className={SMALL_BTN} disabled={busy || (needsDomain && !domainId)} data-testid="cmp-restore"
        onClick={() => onRestore(`/api/competitors/capabilities/${k.id}`, needsDomain ? { state: "active", domainId } : { state: "active" })}>
        <RotateCcw size={12} />{C.settings.restore}
      </button>
    </div>
  );
}

// ————— Competitor row —————

function CompetitorLine({ c, busy, scanning, canEdit, nextScanAt, rescanLimited, onScan, onLog, onRemove, onSave }: {
  c: CompetitorRow;
  busy: boolean;
  scanning: boolean;
  canEdit: boolean;
  nextScanAt: string | null;
  /** Today's manual scans reached the org's per-site limit (PM-OS admins never are). */
  rescanLimited: boolean;
  onScan: (c: CompetitorRow) => Promise<void>;
  onLog: (c: CompetitorRow) => void;
  onRemove: (c: CompetitorRow) => Promise<void>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [website, setWebsite] = useState(c.websiteUrl);
  const [starting, setStarting] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  // Customers see one thing, a scan: pending, in progress, or the last result. Never how it ran.
  const pendingLate = c.pending ? Date.now() - new Date(c.pending.since).getTime() > PENDING_LATE_MS : false;
  const status = c.running ? "running" : c.pending ? (pendingLate ? "pendingLate" : "pending") : c.lastScan?.badge ?? (c.source?.lastScanAt ? "incomplete" : "never");
  // After the pages are stored the analysis reads them: its own step, shown in the same place.
  const analysis = !c.running && !c.pending && c.analysis && isAnalysisActive(c.analysis.status) ? c.analysis : null;
  const analysisFailed = !c.running && !c.pending && c.analysis?.status === "failed" ? c.analysis : null;
  const pillText = c.running
    ? C.settings.scanInProgress(c.running.pagesSoFar)
    : c.pending
      ? C.settings.scanPendingSince(timeAgo(c.pending.since))
      : analysis
        ? analysis.status === "queued"
          ? C.settings.analysisQueued
          : analysis.status === "waiting"
            ? C.settings.analysisWaiting(analysis.resumeAt ? timeUntil(analysis.resumeAt) : "")
            : analysis.step === "research" && analysis.pagesTotal > 0
              ? C.settings.analyzingPages(analysis.pagesDone, analysis.pagesTotal)
              : C.settings.analysisStep[analysis.step] ?? C.matrix.analyzing
      : status === "never"
        ? C.settings.neverScanned
        : C.settings.badges[status] ?? status;
  const summary = c.running || c.pending ? "" : scanSummaryLine(c, nextScanAt);

  async function save() {
    if (await onSave(c.id, { name, website })) setEditing(false);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-white text-fg-muted">
        {c.logoUrl && !logoBroken ? <img src={c.logoUrl} alt="" onError={() => setLogoBroken(true)} className="h-[70%] w-[70%] object-contain" /> : <Globe size={14} />}
      </span>
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-2"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void save(); }
            if (e.key === "Escape") setEditing(false);
          }}>
          <input value={name} onChange={(e) => setName(e.target.value)} className={cn(INPUT, "w-48")} disabled={busy} autoFocus />
          <input value={website} onChange={(e) => setWebsite(e.target.value)} className={INPUT} disabled={busy} aria-label={C.settings.website} />
          <button onClick={() => setEditing(false)} className={ICON_BTN} aria-label={C.settings.cancel} disabled={busy}><X size={14} /></button>
          <button onClick={save} className={cn(ICON_BTN, "text-primary")} aria-label={C.settings.save} disabled={busy || !name.trim()}><Check size={14} /></button>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{c.name}</span>
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-px text-[11px] font-semibold", analysis ? STATUS_PILL.running : STATUS_PILL[status] ?? STATUS_PILL.never)} title={analysis ? undefined : C.settings.badgeHint[status === "pendingLate" ? "pending" : status]} data-testid="cmp-scan-status">
              {pillText}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
            <a href={c.websiteUrl} target="_blank" rel="noreferrer" className="hover:underline">{c.host}</a>
            {c.source?.lastScanAt && <span>· {C.settings.lastScan(timeAgo(c.source.lastScanAt))}</span>}
            {nextScanAt && !c.running && !c.pending && <span>· {C.settings.nextScan(timeUntil(nextScanAt))}</span>}
          </div>
          {summary && <div className={cn("mt-1 text-[12px]", status === "unreachable" ? "text-[#c23767]" : "text-fg-3")}>{summary}</div>}
          {analysisFailed && <div className="mt-1 text-[12px] text-[#8a5a00]" data-testid="cmp-analysis-failed">{analysisFailed.error ? C.settings.analysisFailed(analysisFailed.error) : C.settings.analysisFailedNoReason}</div>}
        </div>
      )}
      {!editing && (
        <>
          <span title={c.running || c.pending ? C.settings.scanRunning : rescanLimited ? C.settings.rescanLimited : undefined}>
            <button
              onClick={async () => { setStarting(true); await onScan(c); setStarting(false); }}
              disabled={Boolean(c.running || c.pending) || starting || busy || rescanLimited}
              className={SMALL_BTN}
            >
              {c.running || starting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {c.running ? C.settings.scanning : rescanLimited ? C.settings.rescanLimitedShort : C.settings.scanNow}
            </button>
          </span>
          <button onClick={() => onLog(c)} className={SMALL_BTN} title={C.settings.viewLog}>
            <FileText size={12} /> {C.settings.viewLog}
          </button>
          {canEdit && (
            <>
              <button onClick={() => { setName(c.name); setWebsite(c.websiteUrl); setEditing(true); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={14} /></button>
              <button onClick={() => void onRemove(c)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy || Boolean(c.running)}><Trash2 size={14} /></button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function AddCompetitorForm({ busy, onAdd }: { busy: boolean; onAdd: (body: unknown) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [website, setWebsite] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!website.trim()) return;
    if (await onAdd({ website })) {
      setWebsite("");
      setOpen(false);
      track("cmp_competitor_added_ui", {});
    }
  }
  if (!open) {
    return (
      <div className="border-b border-border px-5 py-3">
        <button type="button" onClick={() => setOpen(true)} className={SMALL_BTN}><Plus size={13} /> {C.settings.addCompetitor}</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } }} className="flex items-start gap-2 border-b border-border px-5 py-4">
      <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={C.settings.websitePlaceholder} className={INPUT} disabled={busy} autoFocus aria-label={C.settings.website} />
      <Button type="button" onClick={() => setOpen(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
      <Button type="submit" variant="primary" disabled={busy || !website.trim()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {C.settings.save}
      </Button>
    </form>
  );
}

// ————— Suggestions —————

function SuggestionsPanel({ suggested, domains, competitors, canEdit, busy, onDecide }: {
  suggested: CapabilityRow[];
  domains: DomainRow[];
  competitors: CompetitorRow[];
  canEdit: boolean;
  busy: boolean;
  onDecide: (id: string, body: unknown) => Promise<boolean>;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [domainOf, setDomainOf] = useState<Record<string, string>>({});
  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? "";
  const competitorName = (id: string | null) => competitors.find((c) => c.id === id)?.name ?? "";

  return (
    <section className="rounded-xl border border-primary/40 bg-card shadow-[0_0_0_3px_rgba(36,87,245,.06)]">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="font-medium text-foreground">{C.settings.suggestionsTitle}</div>
          <p className="mt-1 text-sm text-muted">{C.settings.suggestionsBlurb}</p>
        </div>
      </div>
      {suggested.map((k) => {
        const quote = k.suggestedQuote?.split(" — https") ?? [];
        return (
          <div key={k.id} className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {canEdit ? (
                  <input value={names[k.id] ?? k.name} onChange={(e) => setNames((p) => ({ ...p, [k.id]: e.target.value }))} className={cn(INPUT, "w-72")} disabled={busy} aria-label="Capability name" />
                ) : (
                  <span className="text-[14px] font-medium">{k.name}</span>
                )}
                {canEdit ? (
                  <select value={domainOf[k.id] ?? k.domainId} onChange={(e) => setDomainOf((p) => ({ ...p, [k.id]: e.target.value }))} className={cn(SELECT, "w-56")} disabled={busy} aria-label="Domain">
                    {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                ) : (
                  <span className="text-[12px] text-fg-muted">{domainName(k.domainId)}</span>
                )}
                {k.suggestedById && <span className="text-[12px] text-fg-muted">{C.settings.suggestedBy(competitorName(k.suggestedById))}</span>}
              </div>
              {k.description && <div className="mt-1 text-[12.5px] text-fg-3">{k.description}</div>}
              {quote[0] && (
                <div className="mt-1 text-[12px] italic text-fg-muted">
                  “{quote[0]}”{quote[1] && <> — <a href={`https${quote[1]}`} target="_blank" rel="noreferrer" className="not-italic text-primary hover:underline">{C.matrix.learnMore} ↗</a></>}
                </div>
              )}
            </div>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button onClick={() => onDecide(k.id, { state: "dismissed" })} className={SMALL_BTN} disabled={busy}>{C.settings.dismiss}</button>
                <button
                  onClick={() => onDecide(k.id, { state: "active", ...(names[k.id] && names[k.id] !== k.name ? { name: names[k.id] } : {}), ...(domainOf[k.id] && domainOf[k.id] !== k.domainId ? { domainId: domainOf[k.id] } : {}) })}
                  className={cn(SMALL_BTN, "border-transparent bg-primary text-white hover:bg-primary-hover")}
                  disabled={busy}
                >
                  <Check size={12} /> {C.settings.accept}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

// ————— Domains (the product-lines pattern: color, name, counts, definition text, drag order) —————

const FIELD_LABEL = "mb-1 block text-[12px] font-medium text-fg-3";
const EDITOR_BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-[13px] font-medium hover:border-primary";
const EDITOR_PRIMARY = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-50";

function DomainsPanel({ domains, capabilities, cells, competitors, canEdit, busy, onAdd, onSave, onRename, onReorder, onRemove }: {
  domains: DomainRow[];
  capabilities: CapabilityRow[];
  cells: CellRow[];
  competitors: CompetitorRow[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (body: unknown) => Promise<boolean>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
  /** A save that changes the name: confirms, then cascades into the descriptions. */
  onRename: (d: DomainRow, body: unknown) => Promise<boolean>;
  onReorder: (order: string[]) => Promise<boolean>;
  onRemove: (d: DomainRow) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** Competitors that have a capability of this domain in full while the org doesn't. */
  function competitorsAhead(d: DomainRow): number {
    const caps = capabilities.filter((k) => k.domainId === d.id && k.ourStatus !== "found");
    const ahead = new Set<string>();
    for (const k of caps) for (const c of cells) if (c.capabilityId === k.id && c.value === "found") ahead.add(c.competitorId);
    return [...ahead].filter((id) => competitors.some((c) => c.id === id)).length;
  }

  async function add() {
    if (!name.trim()) return;
    if (await onAdd({ name, summary, description })) { setName(""); setSummary(""); setDescription(""); setAdding(false); }
  }
  async function saveEdit(id: string) {
    const d = domains.find((x) => x.id === id);
    const body = { name: editName, summary: editSummary, description: editDescription };
    const renamed = d && editName.trim() !== d.name;
    if (await (renamed ? onRename(d, body) : onSave(id, body))) setEditingId(null);
  }
  async function dropOn(targetId: string) {
    const from = domains.findIndex((d) => d.id === dragId);
    const to = domains.findIndex((d) => d.id === targetId);
    setDragId(null);
    setOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...domains];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await onReorder(next.map((d) => d.id));
  }
  const editorKeys = (onSubmit: () => void, onCancel: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  const summaryEditor = (value: string, onChange: (v: string) => void) => (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={MAX_DOMAIN_SUMMARY}
      placeholder={C.settings.domainSummaryPlaceholder} className={cn(INPUT, "resize-y leading-relaxed")} disabled={busy} />
  );
  const descriptionEditor = (value: string, onChange: (v: string) => void) => (
    <div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={10} maxLength={MAX_DOMAIN_DESCRIPTION}
        placeholder={C.settings.domainDescriptionPlaceholder}
        className={cn(INPUT, "resize-y font-mono text-[12.5px] leading-relaxed")} disabled={busy} />
      <div className="mt-1 text-right font-mono text-[10.5px] text-[#9aa8be]">{value.length}/{MAX_DOMAIN_DESCRIPTION}</div>
    </div>
  );

  return (
    <section>
      <div className="mb-1 flex items-end justify-between gap-4">
        <h2 className="font-title m-0 text-[15px] font-semibold">{C.settings.domainsTitle}</h2>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className={SMALL_BTN}><Plus size={13} /> {C.settings.addDomain}</button>
        )}
      </div>
      <p className="mb-4 text-sm text-muted">{C.settings.domainsBlurb} {canEdit && C.settings.domainsDrag}</p>

      {canEdit && adding && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-white px-5 py-4" onKeyDown={editorKeys(() => void add(), () => setAdding(false))}>
          <label className="block">
            <span className={FIELD_LABEL}>{C.settings.domainName}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.settings.domainPlaceholder} autoFocus className={INPUT} maxLength={80} disabled={busy} />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>{C.settings.domainSummary}</span>
            {summaryEditor(summary, setSummary)}
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>{C.settings.domainDescription}</span>
            {descriptionEditor(description, setDescription)}
          </label>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setAdding(false)} className={EDITOR_BTN}><X size={13} /> {C.settings.cancel}</button>
            <button onClick={() => void add()} disabled={busy || !name.trim()} className={EDITOR_PRIMARY}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {C.settings.addDomain}
            </button>
          </div>
        </div>
      )}

      {domains.length === 0 && !adding && <div className="rounded-xl border border-border bg-white px-5 py-4 text-sm text-muted">{C.settings.emptyDomains}</div>}

      <div className="flex flex-col gap-3">
        {domains.map((d) => {
          const n = capabilities.filter((k) => k.domainId === d.id).length;
          const editing = editingId === d.id;
          return (
            <div
              key={d.id}
              onDragOver={(e) => { if (!dragId || dragId === d.id) return; e.preventDefault(); if (overId !== d.id) setOverId(d.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && overId === d.id) setOverId(null); }}
              onDrop={(e) => { e.preventDefault(); void dropOn(d.id); }}
              className={cn(
                "relative rounded-xl border border-border bg-white px-5 py-4 transition-[box-shadow,opacity,border-color]",
                dragId === d.id && "opacity-40",
                dragId && overId === d.id && "border-primary shadow-[0_0_0_2px_var(--app-accent-soft)]",
              )}
            >
              {editing ? (
                <div className="flex flex-col gap-2" onKeyDown={editorKeys(() => void saveEdit(d.id), () => setEditingId(null))}>
                  <label className="block">
                    <span className={FIELD_LABEL}>{C.settings.domainName}</span>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={C.settings.domainPlaceholder} className={INPUT} maxLength={80} disabled={busy} autoFocus />
                  </label>
                  <label className="block">
                    <span className={FIELD_LABEL}>{C.settings.domainSummary}</span>
                    {summaryEditor(editSummary, setEditSummary)}
                  </label>
                  <label className="block">
                    <span className={FIELD_LABEL}>{C.settings.domainDescription}</span>
                    {descriptionEditor(editDescription, setEditDescription)}
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setEditingId(null)} className={EDITOR_BTN}><X size={13} /> {C.settings.cancel}</button>
                    <button onClick={() => void saveEdit(d.id)} disabled={busy || !editName.trim()} className={EDITOR_PRIMARY}>
                      {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy && editName.trim() !== d.name ? C.settings.renamingDomain : C.settings.save}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="-ml-1.5 flex min-w-0 items-center gap-1.5">
                      <ColorSwatch color={d.color} fallback={PRODUCT_CHIP_DEFAULT} name={d.name} canEdit={canEdit && !busy} onPick={(color) => onSave(d.id, { color })} />
                      <span className="font-title text-[14px] font-semibold">{d.name}</span>
                      <span className="ml-1 font-mono text-[11px] text-fg-muted">{C.settings.domainCounts(n, competitorsAhead(d))}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <>
                          <span draggable={!busy} onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDragId(null); setOverId(null); }}
                            title="Drag to reorder" className="flex h-7 w-7 cursor-grab items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-background hover:text-foreground active:cursor-grabbing">
                            <GripVertical size={14} />
                          </span>
                          <span className="mx-0.5 h-4 w-px bg-border" />
                          <button onClick={() => { setEditingId(d.id); setEditName(d.name); setEditSummary(d.summary); setEditDescription(d.description); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={13} /></button>
                          <button onClick={() => void onRemove(d)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={13} /></button>
                        </>
                      )}
                    </span>
                  </div>
                  <p className={cn("m-0 mb-2 text-[13px] leading-snug", d.summary ? "text-foreground" : "italic text-fg-faint")}>{d.summary || C.settings.domainSummaryEmpty}</p>
                  <div className={FIELD_LABEL}>{C.settings.domainDescription}</div>
                  {d.description ? (
                    <UmMarkdown content={d.description} className="text-[13px] text-fg-2" />
                  ) : (
                    <div className="text-[12.5px] italic text-fg-faint">{C.settings.domainDescriptionPlaceholder.split(".")[0]}.</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ————— Capabilities —————

function CapabilitiesPanel({ capabilities, domains, productLines, canEdit, busy, onAdd, onSave, onRemove }: {
  capabilities: CapabilityRow[];
  domains: DomainRow[];
  productLines: string[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (body: unknown) => Promise<boolean>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
  onRemove: (k: CapabilityRow) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [ownProduct, setOwnProduct] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editOwnProduct, setEditOwnProduct] = useState("");

  useEffect(() => {
    if (!domainId && domains[0]) setDomainId(domains[0].id);
  }, [domains, domainId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !domainId) return;
    if (await onAdd({ name, domainId, description, ownProduct })) { setName(""); setDescription(""); setOwnProduct(""); setAdding(false); }
  }
  async function saveEdit(id: string) {
    if (await onSave(id, { name: editName, description: editDescription, ownProduct: editOwnProduct })) setEditingId(null);
  }
  /** Name, domain, own product and description, each under its label; the add form and the row editor share it. */
  const fields = (v: { name: string; domainId?: string; description: string; ownProduct: string }, set: { name: (s: string) => void; domainId?: (s: string) => void; description: (s: string) => void; ownProduct: (s: string) => void }) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <label className="block w-64">
          <span className={FIELD_LABEL}>{C.settings.capabilityName}</span>
          <input value={v.name} onChange={(e) => set.name(e.target.value)} placeholder={C.settings.capabilityPlaceholder} className={INPUT} disabled={busy} autoFocus />
        </label>
        {set.domainId && (
          <label className="block w-52">
            <span className={FIELD_LABEL}>{C.settings.capabilityDomain}</span>
            <select value={v.domainId} onChange={(e) => set.domainId?.(e.target.value)} className={SELECT} disabled={busy}>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        <label className="block w-64">
          <span className={FIELD_LABEL}>{C.settings.ownProduct}</span>
          <input value={v.ownProduct} onChange={(e) => set.ownProduct(e.target.value)} placeholder={C.settings.ownProductPlaceholder} className={INPUT} maxLength={MAX_OWN_PRODUCT} disabled={busy} />
        </label>
      </div>
      <label className="block">
        <span className={FIELD_LABEL}>{C.settings.capabilityDescription}</span>
        <textarea value={v.description} onChange={(e) => set.description(e.target.value)} placeholder={C.settings.capabilityDescriptionPlaceholder} className={cn(INPUT, "resize-y leading-relaxed")} rows={3} maxLength={MAX_CAPABILITY_DESCRIPTION} disabled={busy} />
      </label>
    </div>
  );
  function toggleLine(k: CapabilityRow, line: string) {
    const next = k.productLines.includes(line) ? k.productLines.filter((l) => l !== line) : [...k.productLines, line];
    void onSave(k.id, { productLines: next });
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="font-medium text-foreground">{C.settings.capabilitiesTitle}</div>
          {canEdit && !adding && domains.length > 0 && <button type="button" onClick={() => setAdding(true)} className={SMALL_BTN}><Plus size={13} /> {C.settings.addCapability}</button>}
        </div>
        <p className="mt-1 text-sm text-muted">{C.settings.capabilitiesBlurb}</p>
        {productLines.length === 0 && <p className="mt-1 text-[12px] text-fg-muted">{C.settings.noProductLinesHint}</p>}
      </div>
      {adding && (
        <form onSubmit={add} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAdding(false); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(e); } }} className="flex items-end gap-2 border-b border-border px-5 py-4">
          {fields({ name, domainId, description, ownProduct }, { name: setName, domainId: setDomainId, description: setDescription, ownProduct: setOwnProduct })}
          <Button type="button" onClick={() => setAdding(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !domainId}><Check size={13} /> {C.settings.save}</Button>
        </form>
      )}
      {capabilities.length === 0 && <div className="px-5 py-4 text-sm text-muted">{C.settings.emptyCapabilities}</div>}
      {domains.map((d) => {
        const rows = capabilities.filter((k) => k.domainId === d.id);
        if (rows.length === 0) return null;
        return (
          <div key={d.id}>
            <div className="flex items-center gap-2 border-b border-border bg-[rgba(36,87,245,.05)] px-5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.04em] text-fg-muted">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: swatchColor(d.color, PRODUCT_CHIP_DEFAULT) }} />
              {d.name}
            </div>
            {rows.map((k) => {
              const editing = editingId === k.id;
              return (
                <div key={k.id} className="flex items-start gap-3 border-b border-border px-5 py-3">
                  {editing ? (
                    <div className="flex min-w-0 flex-1 items-end gap-2"
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) { e.preventDefault(); void saveEdit(k.id); } if (e.key === "Escape") setEditingId(null); }}>
                      {fields({ name: editName, description: editDescription, ownProduct: editOwnProduct }, { name: setEditName, description: setEditDescription, ownProduct: setEditOwnProduct })}
                      <button onClick={() => setEditingId(null)} className={ICON_BTN} aria-label={C.settings.cancel}><X size={14} /></button>
                      <button onClick={() => saveEdit(k.id)} className={cn(ICON_BTN, "text-primary")} aria-label={C.settings.save} disabled={busy || !editName.trim()}><Check size={14} /></button>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium">{k.name}</span>
                        {k.origin === "ai" && <span className="rounded-full bg-[#eef1f6] px-1.5 py-px font-mono text-[10px] text-fg-muted">PMOS AI</span>}
                        {k.ownProduct && <span className="max-w-[220px] truncate rounded-full bg-[rgba(36,87,245,.12)] px-1.5 py-px font-mono text-[10px] font-semibold text-[#2a5fd0]" title={`${C.settings.ownProduct}: ${k.ownProduct}`}>{ownProductLabel(k.ownProduct)}</span>}
                        <span className="ml-1 inline-flex items-center gap-1" title={C.settings.ourStatus}>
                          {OWN_STATUS_VALUES.map((v) => (
                            <button key={v} type="button" onClick={() => k.ourStatus !== v && void onSave(k.id, { ourStatus: v })} disabled={busy} aria-pressed={k.ourStatus === v}
                              className={cn("rounded-full border px-2 py-px font-mono text-[10px] font-semibold", k.ourStatus === v
                                ? v === "found" ? "border-transparent bg-[rgba(23,178,106,.16)] text-[#0f7a47]" : "border-transparent bg-[#fff7e0] text-[#8a5a00]"
                                : "border-border bg-white text-fg-faint hover:border-primary/55")}>
                              {C.values[v]}
                            </button>
                          ))}
                        </span>
                      </div>
                      {k.description && <div className="mt-0.5 text-[12.5px] text-fg-3">{k.description}</div>}
                      {productLines.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {productLines.map((line) => {
                            const on = k.productLines.includes(line);
                            return (
                              <button
                                key={line}
                                type="button"
                                onClick={() => canEdit && toggleLine(k, line)}
                                disabled={!canEdit || busy}
                                aria-pressed={on}
                                className={cn(
                                  "rounded-chip px-[7px] py-[2px] font-mono text-[11px] font-semibold leading-[15px]",
                                  on ? "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]" : "bg-[#eef1f6] text-fg-faint",
                                  canEdit && "hover:ring-1 hover:ring-primary/40",
                                )}
                              >
                                {line}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {canEdit && !editing && (
                    <div className="flex shrink-0 items-center gap-1">
                      <select value={k.domainId} onChange={(e) => void onSave(k.id, { domainId: e.target.value })} className="rounded-lg border border-border bg-white px-2 py-1 text-[12px]" disabled={busy} aria-label="Move to domain">
                        {domains.map((dd) => <option key={dd.id} value={dd.id}>{dd.name}</option>)}
                      </select>
                      <button onClick={() => { setEditingId(k.id); setEditName(k.name); setEditDescription(k.description); setEditOwnProduct(k.ownProduct); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={14} /></button>
                      <button onClick={() => void onRemove(k)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

// ————— Schedule —————

function SchedulePanel({ config, canEdit, busy, onSave }: {
  config: CompetitorsState["config"];
  canEdit: boolean;
  busy: boolean;
  onSave: (body: unknown) => Promise<boolean>;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="font-medium text-foreground">{C.settings.scheduleTitle}</div>
        <p className="mt-1 text-sm text-muted">{C.settings.scheduleBlurb}</p>
      </div>
      <div className="flex flex-wrap items-end gap-6 px-5 py-4">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-fg-3">{C.settings.manualRescans}</span>
          <select value={config.manualRescansPerDay} onChange={(e) => void onSave({ manualRescansPerDay: Number(e.target.value) })} className={cn(SELECT, "w-44")} disabled={!canEdit || busy} title={C.settings.manualRescansHint}>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} per day</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

// ————— Notifications —————

/** Who receives the scan notification email: every active user of the organization, ticked or not. */
function NotificationsPanel({ members, selected, canEdit, busy, onSave }: {
  members: CompetitorsState["members"];
  selected: string[];
  canEdit: boolean;
  busy: boolean;
  onSave: (ids: string[]) => Promise<boolean>;
}) {
  const picked = new Set(selected);
  async function toggle(id: string) {
    const next = picked.has(id) ? selected.filter((x) => x !== id) : [...selected, id];
    await onSave(next);
  }
  return (
    <section className="rounded-xl border border-border bg-card" data-testid="cmp-notifications">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="font-medium text-foreground">{C.notify.title}</div>
          <p className="mt-1 text-sm text-muted">{C.notify.blurb}</p>
        </div>
        <span className="shrink-0 text-[12px] text-fg-muted">{C.notify.selected(selected.filter((id) => members.some((m) => m.id === id)).length)}</span>
      </div>
      {members.length === 0 ? (
        <div className="px-5 py-4 text-sm text-muted">{C.notify.empty}</div>
      ) : (
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.id}>
              <label className={cn("flex items-center gap-3 px-5 py-2.5 text-sm", canEdit ? "cursor-pointer hover:bg-background" : "cursor-default")}>
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => void toggle(m.id)} disabled={!canEdit || busy} className="h-4 w-4 accent-[var(--app-accent)]" />
                <span className="font-medium text-foreground">{m.name || m.email}</span>
                {m.name && <span className="text-[12.5px] text-fg-muted">{m.email}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
