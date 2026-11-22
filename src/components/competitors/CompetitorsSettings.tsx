"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, FileText, Globe, GripVertical, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { ColorSwatch } from "@/components/settings/ColorSwatch";
import { aiTextSameAsCovers, aiTextToSave, capabilityChanges, definitionSameAsCovers, domainTextsToSave, type CapabilityDraft } from "@/lib/competitors/domain-texts";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { ADDRESS_KINDS, isAnalysisActive, MAX_CAPABILITY_AI_DEFINITION, MAX_CAPABILITY_DESCRIPTION, MAX_DOMAIN_DESCRIPTION, MAX_DOMAIN_DONE_BY, MAX_DOMAIN_SUMMARY, OWN_STATUS_VALUES, type AddressKind } from "@/lib/competitors/config";
import type { AddressRow, AddressSearchRow, CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow, OwnSiteRow, RemovedCapabilityRow, RemovedRow } from "@/lib/competitors/store";
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
 * Settings → Competitors: your company first (the organization's own website,
 * its other addresses, its product lines), then competitors (with Scan now and the scan log),
 * domains (with the definition text PMOS AI reads), the capability catalog
 * with the org's own status per row, and what the team removed. Every section opens and closes; only Your company and Competitors
 * start open (Daniel 2026-11-12: the page was crowded). Reads are for
 * everyone; catalog writes need a customer admin (the API enforces the same).
 * Scan now and the log are for every member.
 */
type SectionKey = "own" | "competitors" | "domains" | "capabilities";

/** A section's title row: click to open or close. The count says what is inside while it is closed. */
function SectionToggle({ section, title, count, open, onToggle, heading = false }: { section: SectionKey; title: string; count?: number; open: boolean; onToggle: () => void; heading?: boolean }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} data-testid={`cmp-section-${section}`}
      className={cn("-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-foreground hover:text-primary", heading ? "font-title text-[15px] font-semibold" : "font-medium")}>
      <ChevronRight size={15} className={cn("shrink-0 text-fg-muted transition-transform", open && "rotate-90")} />
      <span>{title}</span>
      {count !== undefined && <span className="rounded-full bg-[#eef1f6] px-1.5 py-px font-mono text-[10.5px] font-normal text-fg-muted">{count}</span>}
    </button>
  );
}

export function CompetitorsSettings({ initialState, canEdit }: { initialState: CompetitorsState; canEdit: boolean }) {
  const { confirm } = useConfirm();
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<CompetitorRow | null>(null);
  /** The domain being removed while it still holds capabilities: the PM is asked once where they go. */
  const [movingOut, setMovingOut] = useState<{ domain: DomainRow; count: number } | null>(null);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({ own: true, competitors: true, domains: false, capabilities: false });
  const [addingCompetitor, setAddingCompetitor] = useState(false);
  const isOpen = (k: SectionKey) => openSections[k];
  const toggle = (k: SectionKey) => setOpenSections((o) => ({ ...o, [k]: !o[k] }));
  const openSection = (k: SectionKey) => setOpenSections((o) => ({ ...o, [k]: true }));
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
  const searching = state.searching;
  const ownScanning = state.ownScanning;
  useEffect(() => {
    if (!scanning && !analyzing && !searching && !ownScanning) return;
    const tick = async () => {
      await refresh();
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [scanning, analyzing, searching, ownScanning, refresh]);

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

  // ——— A company's other addresses (help center, developer docs, release notes) ———
  const addAddress = (companyId: string, body: { address: string; kind: AddressKind }) => call("POST", `/api/competitors/${companyId}/sources`, body);
  async function removeAddress(companyId: string, a: AddressRow) {
    if (!(await confirm({ title: C.settings.addresses.removeTitle(a.host), message: C.settings.addresses.removeBody, confirmLabel: C.settings.addresses.removeConfirm, tone: "danger" }))) return;
    await call("DELETE", `/api/competitors/${companyId}/sources/${a.id}`);
  }

  const competitors = state.competitors;
  /** The organization's setup is not done: its catalog is built by the setup run, not typed in. */
  const settingUp = state.setup !== "done";
  const active = state.capabilities.filter((k) => k.state === "active");
  // A suggested domain is approved or declined in the matrix (dashed group); the catalog panels show the domains in the table.
  const activeDomains = state.domains.filter((d) => d.state === "active");
  const nextScanAt = (c: CompetitorRow) =>
    c.source?.lastScanAt ? new Date(new Date(c.source.lastScanAt).getTime() + c.source.scanEveryDays * 86_400_000).toISOString() : null;

  return (
    <div className="space-y-8">
      {error && <div className="rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">{error}</div>}
      {note && <div className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0f7a47]"><Check size={12} strokeWidth={2.5} />{note}</div>}
      {!canEdit && <div className="text-[12.5px] text-fg-muted">{C.settings.viewOnly}</div>}
      {/* Competitors needs its initial setup before it works: said plainly while the organization's setup is not done. */}
      {settingUp && (
        <div className="rounded-inner border border-border bg-card px-4 py-3" data-testid="cmp-being-set-up">
          <div className="text-[13.5px] font-semibold text-foreground">{C.setup.title}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3">{C.setup.body}</div>
        </div>
      )}

      {/* Your company */}
      <OwnCompanyPanel own={state.own} orgName={state.orgName} productLines={state.productLines.length} canEdit={canEdit} busy={busy}
        open={isOpen("own")} onToggle={() => toggle("own")}
        onAdd={(website) => call("POST", "/api/competitors/own-site", { website })}
        onChange={async (website) => {
          if (!(await confirm({ title: C.settings.own.changeTitle, message: C.settings.own.changeBody, confirmLabel: C.settings.own.changeConfirm }))) return false;
          return call("PATCH", "/api/competitors/own-site", { website });
        }}
        onScan={() => call("POST", "/api/competitors/own-site/scan")}
        onAddAddress={addAddress} onRemoveAddress={removeAddress} />

      {/* Competitors */}
      <section className="rounded-xl border border-border bg-card" data-testid="cmp-competitors">
        <div className={cn("px-5 py-4", isOpen("competitors") && "border-b border-border")}>
          <div className="flex items-start justify-between gap-4">
            <SectionToggle section="competitors" title={C.settings.competitorsTitle} count={competitors.length} open={isOpen("competitors")} onToggle={() => toggle("competitors")} />
            {canEdit && !addingCompetitor && (
              <button type="button" onClick={() => { openSection("competitors"); setAddingCompetitor(true); }} className={SMALL_BTN}><Plus size={13} /> {C.settings.addCompetitor}</button>
            )}
          </div>
          {isOpen("competitors") && <p className="mt-1 text-sm text-muted">{C.settings.competitorsBlurb}</p>}
        </div>
        {isOpen("competitors") && (
          <>
            {canEdit && addingCompetitor && <AddCompetitorForm busy={busy} onAdd={(body) => call("POST", "/api/competitors", body)} onClose={() => setAddingCompetitor(false)} />}
            {competitors.length === 0 ? (
              <div className="px-5 py-4 text-sm text-muted">{C.settings.emptyCompetitors}</div>
            ) : (
              competitors.map((c) => (
                <CompetitorLine key={c.id} c={c} busy={busy} scanning={scanning} canEdit={canEdit} nextScanAt={nextScanAt(c)}
                  onScan={scanNow} onLog={setLogFor} onRemove={removeCompetitor} onSave={(id, body) => call("PATCH", `/api/competitors/${id}`, body)}
                  onAddAddress={addAddress} onRemoveAddress={removeAddress} />
              ))
            )}
          </>
        )}
      </section>

      {/* Domains */}
      <DomainsPanel domains={activeDomains} capabilities={active} cells={state.cells} competitors={state.competitors} canEdit={canEdit} busy={busy} settingUp={settingUp}
        open={isOpen("domains")} onToggle={() => toggle("domains")} onOpen={() => openSection("domains")}
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
      <CapabilitiesPanel capabilities={active} domains={activeDomains} productLines={state.productLines} canEdit={canEdit} busy={busy} settingUp={settingUp}
        open={isOpen("capabilities")} onToggle={() => toggle("capabilities")} onOpen={() => openSection("capabilities")}
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

function CompetitorLine({ c, busy, scanning, canEdit, nextScanAt, onScan, onLog, onRemove, onSave, onAddAddress, onRemoveAddress }: {
  onAddAddress: (companyId: string, body: { address: string; kind: AddressKind }) => Promise<boolean>;
  onRemoveAddress: (companyId: string, a: AddressRow) => Promise<void>;
  c: CompetitorRow;
  busy: boolean;
  scanning: boolean;
  canEdit: boolean;
  nextScanAt: string | null;
  /** Today's manual scans reached the org's per-site limit (PM-OS admins never are). */
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
            : analysis.step === "reading" && analysis.pagesTotal > 0
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
    <div className="border-b border-border px-5 py-3 last:border-b-0" data-testid="cmp-competitor" data-name={c.name}>
    <div className="flex items-center gap-3">
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
          <span title={c.running || c.pending ? C.settings.scanRunning : undefined}>
            <button
              onClick={async () => { setStarting(true); await onScan(c); setStarting(false); }}
              disabled={Boolean(c.running || c.pending) || starting || busy}
              className={SMALL_BTN}
            >
              {c.running || starting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {c.running ? C.settings.scanning : C.settings.scanNow}
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
    <AddressList addresses={c.addresses} search={c.addressSearch} canEdit={canEdit} busy={busy} onAdd={(body) => onAddAddress(c.id, body)} onRemove={(a) => onRemoveAddress(c.id, a)} />
    </div>
  );
}

// ————— Your company —————

/**
 * The first section: the organization's own material. Its website (add it, change it, where its scan stands, how
 * many pages are stored, Scan now), its other addresses exactly as a competitor's (found the same way), and a link
 * to Settings → Product Lines with their count — they are read together with the site. Adding the site here does
 * what the scanner CLI `--own-site` does. The own site is never shown as a competitor.
 *
 * Documents (PDFs) have no place here yet: whether they are uploaded or read from a drive is not decided.
 */
function OwnCompanyPanel({ own, orgName, productLines, canEdit, busy, open, onToggle, onAdd, onChange, onScan, onAddAddress, onRemoveAddress }: {
  own: OwnSiteRow | null;
  orgName: string;
  /** How many product lines the organization has (Settings → Product Lines). */
  productLines: number;
  canEdit: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onAdd: (website: string) => Promise<boolean>;
  onChange: (website: string) => Promise<boolean>;
  onScan: () => Promise<boolean>;
  onAddAddress: (companyId: string, body: { address: string; kind: AddressKind }) => Promise<boolean>;
  onRemoveAddress: (companyId: string, a: AddressRow) => Promise<void>;
}) {
  const O = C.settings.own;
  const [website, setWebsite] = useState("");
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const pendingLate = own?.pending ? Date.now() - new Date(own.pending.since).getTime() > PENDING_LATE_MS : false;
  const status = !own ? "never" : own.running ? "running" : own.pending ? (pendingLate ? "pendingLate" : "pending") : own.badge ?? (own.lastScanAt ? "incomplete" : "never");
  const pillText = !own ? "" : own.running ? C.settings.scanInProgress(own.running.pagesSoFar) : own.pending ? C.settings.scanPendingSince(timeAgo(own.pending.since)) : status === "never" ? C.settings.neverScanned : C.settings.badges[status] ?? status;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!website.trim()) return;
    if (await onAdd(website)) setWebsite("");
  }
  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (!website.trim()) return;
    if (await onChange(website)) setEditing(false);
  }
  return (
    <section className="rounded-xl border border-border bg-card" data-testid="cmp-own">
      <div className={cn("px-5 py-4", open && "border-b border-border")}>
        <SectionToggle section="own" title={O.title} open={open} onToggle={onToggle} />
        {open && <p className="mt-1 text-sm text-muted">{O.blurb}</p>}
      </div>
      {open && (
        <div className="px-5 py-3">
          {!own ? (
            <>
              <div className="text-sm text-muted" data-testid="cmp-own-empty">{O.empty}</div>
              {canEdit && (
                <form onSubmit={add} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setWebsite(""); } }} className="mt-3 flex items-end gap-2" data-testid="cmp-own-add">
                  <label className="block min-w-[280px] flex-1">
                    <span className={FIELD_LABEL}>{O.website}</span>
                    <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={O.websitePlaceholder} className={INPUT} disabled={busy} />
                  </label>
                  <Button type="submit" variant="primary" disabled={busy || !website.trim()}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {O.addSite}
                  </Button>
                </form>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3" data-testid="cmp-own-site">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-white text-fg-muted"><Globe size={14} /></span>
                {editing ? (
                  <form onSubmit={change} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }} className="flex min-w-0 flex-1 items-end gap-2" data-testid="cmp-own-change">
                    <label className="block min-w-0 flex-1">
                      <span className={FIELD_LABEL}>{O.website}</span>
                      <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={O.websitePlaceholder} className={INPUT} disabled={busy} autoFocus />
                    </label>
                    <Button type="button" onClick={() => setEditing(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
                    <Button type="submit" variant="primary" disabled={busy || !website.trim()}><Check size={13} /> {C.settings.save}</Button>
                  </form>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{own.name || orgName}</span>
                      <span className={cn("inline-flex shrink-0 rounded-full px-2 py-px text-[11px] font-semibold", STATUS_PILL[status] ?? STATUS_PILL.never)} title={C.settings.badgeHint[status === "pendingLate" ? "pending" : status]} data-testid="cmp-own-status">{pillText}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
                      <a href={own.websiteUrl} target="_blank" rel="noreferrer" className="hover:underline">{own.host}</a>
                      <span data-testid="cmp-own-pages">· {O.pages(own.pages)}</span>
                      {own.lastScanAt && <span>· {C.settings.lastScan(timeAgo(own.lastScanAt))}</span>}
                      {own.nextScanAt && !own.running && !own.pending && <span>· {C.settings.nextScan(timeUntil(own.nextScanAt))}</span>}
                    </div>
                    {status === "unreachable" && own.lastError && <div className="mt-1 text-[12px] text-[#c23767]">{own.lastError}</div>}
                  </div>
                )}
                {!editing && (
                  <>
                    <span title={own.running || own.pending ? C.settings.scanRunning : undefined}>
                      <button onClick={async () => { setStarting(true); await onScan(); setStarting(false); }} disabled={Boolean(own.running || own.pending) || starting || busy} className={SMALL_BTN} data-testid="cmp-own-scan">
                        {own.running || starting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {own.running ? C.settings.scanning : C.settings.scanNow}
                      </button>
                    </span>
                    {canEdit && (
                      <button onClick={() => { setWebsite(own.websiteUrl); setEditing(true); }} className={ICON_BTN} aria-label={O.changeSite} title={O.changeSite} disabled={busy}><Pencil size={14} /></button>
                    )}
                  </>
                )}
              </div>
              <AddressList addresses={own.addresses} search={own.addressSearch} canEdit={canEdit} busy={busy} onAdd={(body) => onAddAddress(own.id, body)} onRemove={(a) => onRemoveAddress(own.id, a)} />
            </>
          )}
          <div className="mt-3 border-t border-border pt-3 text-[12.5px] text-fg-muted" data-testid="cmp-own-product-lines">
            {O.productLines(productLines)}{" "}
            <Link href="/settings/ideas/product-lines" className="font-medium text-primary hover:underline">{O.productLinesLink}</Link>
          </div>
        </div>
      )}
    </section>
  );
}

// ————— A company's other addresses —————

/**
 * Under a company's website line: its other addresses — help center, developer docs, release notes — that PM-OS
 * found or a PM added (lib/competitors/addresses.ts). Each says what it is, where it is, how many pages are stored
 * from it and where its scan stands, and can be removed (with a confirm). "Add address" takes an address and what
 * it is: Enter confirms, Esc cancels. While PM-OS is looking, the list says so; when it found nothing, it says that.
 */
function AddressList({ addresses, search, canEdit, busy, onAdd, onRemove }: {
  addresses: AddressRow[];
  search: AddressSearchRow;
  canEdit: boolean;
  busy: boolean;
  onAdd: (body: { address: string; kind: AddressKind }) => Promise<boolean>;
  onRemove: (a: AddressRow) => Promise<void>;
}) {
  const A = C.settings.addresses;
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState<AddressKind>("helpcenter");
  function close() {
    setAdding(false);
    setAddress("");
    setKind("helpcenter");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim()) return;
    if (await onAdd({ address, kind })) close();
  }
  return (
    <div className="ml-11 mt-2" data-testid="cmp-addresses">
      {addresses.map((a) => (
        <div key={a.id} className="flex items-center gap-2 py-1 text-[12.5px]" data-testid="cmp-address" data-kind={a.kind} data-host={a.host}>
          <span className="shrink-0 rounded-full bg-[#eef1f6] px-2 py-px text-[11px] font-semibold text-[#4a5b74]" title={a.foundVia ? A.foundBy[a.foundVia] : undefined}>{A.kinds[a.kind] ?? a.kind}</span>
          <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-foreground hover:underline">{a.host}</a>
          <span className="shrink-0 text-fg-muted">· {A.pages(a.pages)}</span>
          <span className={cn("shrink-0", a.running ? "text-[#2a5fd0]" : "text-fg-muted")} data-testid="cmp-address-scan">
            · {a.running ? A.scanInProgress(a.running.pagesSoFar) : a.pending ? A.scanPending : a.lastScanAt ? `${A.lastScan(timeAgo(a.lastScanAt))}${a.badge && a.badge !== "full" ? ` (${(C.settings.badges[a.badge] ?? a.badge).toLowerCase()})` : ""}` : A.neverScanned}
          </span>
          {canEdit && (
            <button type="button" onClick={() => void onRemove(a)} className={cn(ICON_BTN, "ml-auto p-1 hover:text-[#c23767]")} aria-label={A.removeLabel(a.host)} title={a.running ? A.scanRunning : undefined} disabled={busy || Boolean(a.running)} data-testid="cmp-address-remove">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      {search.running ? (
        <div className="flex items-center gap-1.5 py-1 text-[12px] text-fg-muted" data-testid="cmp-address-search"><Loader2 size={12} className="animate-spin" />{A.searching}</div>
      ) : search.status === "done" && addresses.length === 0 ? (
        <div className="py-1 text-[12px] text-fg-muted" data-testid="cmp-address-search">{A.noneFound}</div>
      ) : null}
      {canEdit && !adding && (
        <button type="button" onClick={() => setAdding(true)} className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline" disabled={busy} data-testid="cmp-address-add">
          <Plus size={12} /> {A.add}
        </button>
      )}
      {canEdit && adding && (
        <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }} className="mt-2 flex flex-wrap items-end gap-2" data-testid="cmp-address-form">
          <label className="block min-w-[260px] flex-1">
            <span className={FIELD_LABEL}>{A.address}</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={A.addressPlaceholder} className={INPUT} disabled={busy} autoFocus />
          </label>
          <label className="block w-44">
            <span className={FIELD_LABEL}>{A.kind}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as AddressKind)} className={SELECT} disabled={busy}>
              {ADDRESS_KINDS.map((k) => <option key={k} value={k}>{A.kinds[k]}</option>)}
            </select>
          </label>
          <Button type="button" onClick={close} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !address.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {C.settings.save}
          </Button>
        </form>
      )}
    </div>
  );
}

/** The add form of the Competitors section; its "Add competitor" button sits in the section's title row, like the other sections. */
function AddCompetitorForm({ busy, onAdd, onClose }: { busy: boolean; onAdd: (body: unknown) => Promise<boolean>; onClose: () => void }) {
  const [website, setWebsite] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!website.trim()) return;
    if (await onAdd({ website })) {
      setWebsite("");
      onClose();
      track("cmp_competitor_added_ui", {});
    }
  }
  return (
    <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }} className="flex items-start gap-2 border-b border-border px-5 py-4">
      <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={C.settings.websitePlaceholder} className={INPUT} disabled={busy} autoFocus aria-label={C.settings.website} />
      <Button type="button" onClick={onClose} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
      <Button type="submit" variant="primary" disabled={busy || !website.trim()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {C.settings.save}
      </Button>
    </form>
  );
}

// ————— Domains (the product-lines pattern: color, name, counts, definition text, drag order) —————

const FIELD_LABEL = "mb-1 block text-[12px] font-medium text-fg-3";
const EDITOR_BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-[13px] font-medium hover:border-primary";
const EDITOR_PRIMARY = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-50";

function DomainsPanel({ domains, capabilities, cells, competitors, canEdit, busy, settingUp, open, onToggle, onOpen, onAdd, onSave, onRename, onReorder, onRemove }: {
  /** The organization's setup is not done: nothing is added by hand, and the empty list says why. */
  settingUp: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
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
  // Who does the work (the info card's "Show more"), and "Same as what it covers" for the PMOS AI definition.
  const [doneBy, setDoneBy] = useState("");
  const [same, setSame] = useState(false);
  const [editDoneBy, setEditDoneBy] = useState("");
  const [editSame, setEditSame] = useState(false);
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
    if (await onAdd({ name, ...domainTextsToSave({ covers: summary, definition: description, same }), doneBy })) { setName(""); setSummary(""); setDescription(""); setDoneBy(""); setSame(false); setAdding(false); }
  }
  async function saveEdit(id: string) {
    const d = domains.find((x) => x.id === id);
    const body = { name: editName, ...domainTextsToSave({ covers: editSummary, definition: editDescription, same: editSame }), doneBy: editDoneBy };
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
    // Enter saves from a single-line field, Cmd/Ctrl+Enter from anywhere (a textarea keeps Enter for a new line); Esc cancels.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target instanceof HTMLInputElement && e.target.type === "text"))) { e.preventDefault(); onSubmit(); }
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

  /**
   * The three things a user edits on a domain, each its own section: 1. the name; 2. the info section people read in
   * the table — what it covers, who does the work; 3. the PMOS AI definition, with "Same as what it covers" so the two
   * texts need not be kept in step by hand. Every field has a visible label and a hint.
   */
  const HINT = "mb-1 block text-[11.5px] text-fg-muted";
  const domainFields = (f: { name: string; setName: (v: string) => void; summary: string; setSummary: (v: string) => void; doneBy: string; setDoneBy: (v: string) => void; description: string; setDescription: (v: string) => void; same: boolean; setSame: (v: boolean) => void; focusName: boolean }) => (
    <>
      <label className="block">
        <span className={FIELD_LABEL}>{C.settings.domainName}</span>
        <span className={HINT}>{C.settings.domainNameHint}</span>
        <input type="text" value={f.name} onChange={(e) => f.setName(e.target.value)} placeholder={C.settings.domainPlaceholder} autoFocus={f.focusName} className={INPUT} maxLength={80} disabled={busy} data-testid="cmp-domain-name" />
      </label>
      <fieldset className="m-0 flex flex-col gap-2 border-0 border-t border-border p-0 pt-2">
        <legend className="sr-only">{C.settings.domainInfoSection}</legend>
        <div>
          <div className="text-[12.5px] font-semibold text-foreground">{C.settings.domainInfoSection}</div>
          <div className="text-[11.5px] text-fg-muted">{C.settings.domainInfoHint}</div>
        </div>
        <label className="block">
          <span className={FIELD_LABEL}>{C.settings.domainSummary}</span>
          {summaryEditor(f.summary, f.setSummary)}
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>{C.settings.domainDoneBy}</span>
          <textarea value={f.doneBy} onChange={(e) => f.setDoneBy(e.target.value)} rows={2} maxLength={MAX_DOMAIN_DONE_BY} placeholder={C.settings.domainDoneByPlaceholder} className={cn(INPUT, "resize-y leading-relaxed")} disabled={busy} data-testid="cmp-domain-done-by" />
        </label>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 border-t border-border p-0 pt-2">
        <legend className="sr-only">{C.settings.domainDescription}</legend>
        <div>
          <div className="text-[12.5px] font-semibold text-foreground">{C.settings.domainDescription}</div>
          <div className="text-[11.5px] text-fg-muted">{C.settings.domainDescriptionHint}</div>
        </div>
        <label className="inline-flex w-fit items-center gap-2 text-[12.5px] text-fg-2">
          <input type="checkbox" checked={f.same} onChange={(e) => f.setSame(e.target.checked)} disabled={busy} data-testid="cmp-domain-same" />
          {C.settings.domainSameAsCovers}
        </label>
        {!f.same && (
          <label className="block">
            <span className="sr-only">{C.settings.domainDescription}</span>
            {descriptionEditor(f.description, f.setDescription)}
          </label>
        )}
      </fieldset>
    </>
  );

  return (
    <section className="rounded-xl border border-border bg-card" data-testid="cmp-domains">
      <div className={cn("px-5 py-4", open && "border-b border-border")}>
        <div className="flex items-start justify-between gap-4">
          <SectionToggle section="domains" title={C.settings.domainsTitle} count={domains.length} open={open} onToggle={onToggle} />
          {canEdit && !settingUp && !(adding && open) && (
            <button onClick={() => { onOpen(); setAdding(true); }} className={SMALL_BTN}><Plus size={13} /> {C.settings.addDomain}</button>
          )}
        </div>
        {open && <p className="mt-1 text-sm text-muted">{C.settings.domainsBlurb} {canEdit && C.settings.domainsDrag}</p>}
      </div>
      {open && (
      <div className="px-5 py-4">

      {canEdit && !settingUp && adding && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-white px-5 py-4" onKeyDown={editorKeys(() => void add(), () => setAdding(false))}>
          {domainFields({ name, setName, summary, setSummary, doneBy, setDoneBy, description, setDescription, same, setSame, focusName: true })}
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setAdding(false)} className={EDITOR_BTN}><X size={13} /> {C.settings.cancel}</button>
            <button onClick={() => void add()} disabled={busy || !name.trim()} className={EDITOR_PRIMARY}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {C.settings.addDomain}
            </button>
          </div>
        </div>
      )}

      {domains.length === 0 && (settingUp || !adding) && <div className="rounded-xl border border-border bg-white px-5 py-4 text-sm text-muted">{settingUp ? C.setup.catalogNote : C.settings.emptyDomains}</div>}

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
                  {domainFields({ name: editName, setName: setEditName, summary: editSummary, setSummary: setEditSummary, doneBy: editDoneBy, setDoneBy: setEditDoneBy, description: editDescription, setDescription: setEditDescription, same: editSame, setSame: setEditSame, focusName: true })}
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
                          <button onClick={() => { setEditingId(d.id); setEditName(d.name); setEditSummary(d.summary); setEditDescription(d.description); setEditDoneBy(d.doneBy); setEditSame(definitionSameAsCovers(d.summary, d.description)); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={13} /></button>
                          <button onClick={() => void onRemove(d)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={13} /></button>
                        </>
                      )}
                    </span>
                  </div>
                  <div className={FIELD_LABEL}>{C.settings.domainSummary}</div>
                  <p className={cn("m-0 mb-2 text-[13px] leading-snug", d.summary ? "text-foreground" : "italic text-fg-faint")} data-testid="cmp-domain-covers">{d.summary || C.settings.domainSummaryEmpty}</p>
                  {d.doneBy && (
                    <>
                      <div className={FIELD_LABEL}>{C.settings.domainDoneBy}</div>
                      <p className="m-0 mb-2 text-[13px] leading-snug text-fg-2" data-testid="cmp-domain-card-done-by">{d.doneBy}</p>
                    </>
                  )}
                  {/* Never the same words twice: when the PMOS AI definition is the same text as "What it covers", the card says so instead of repeating it. */}
                  {definitionSameAsCovers(d.summary, d.description) ? (
                    <div className="text-[12px] text-fg-muted" data-testid="cmp-domain-same-note">{C.settings.domainSameNote}</div>
                  ) : (
                    <>
                      <div className={FIELD_LABEL}>{C.settings.domainDescription}</div>
                      {d.description ? (
                        <UmMarkdown content={d.description} className="text-[13px] text-fg-2" />
                      ) : (
                        <div className="text-[12.5px] italic text-fg-faint">{C.settings.domainDescriptionPlaceholder.split(".")[0]}.</div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      </div>
      )}
    </section>
  );
}

// ————— Capabilities —————

function CapabilitiesPanel({ capabilities, domains, productLines, canEdit, busy, settingUp, open, onToggle, onOpen, onAdd, onSave, onRemove }: {
  /** The organization's setup is not done: nothing is added by hand, and the empty list says why. */
  settingUp: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  capabilities: CapabilityRow[];
  domains: DomainRow[];
  productLines: string[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (body: unknown) => Promise<boolean>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
  onRemove: (k: CapabilityRow) => Promise<void>;
}) {
  const draftOf = (k: CapabilityRow): CapabilityDraft => ({ name: k.name, domainId: k.domainId, description: k.description, aiDefinition: k.aiDefinition, same: aiTextSameAsCovers(k.description, k.aiDefinition), productLines: [...k.productLines] });
  const emptyDraft = (): CapabilityDraft => ({ name: "", domainId: domains[0]?.id ?? "", description: "", aiDefinition: "", same: true, productLines: [] });
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<CapabilityDraft>(emptyDraft);
  // The open rows and their edits. A row is one short line until it is clicked; then it opens downward. More than one
  // may be open. A row's draft starts from the row when it opens and is dropped when it closes.
  const [drafts, setDrafts] = useState<Record<string, CapabilityDraft>>({});

  useEffect(() => {
    if (!newDraft.domainId && domains[0]) setNewDraft((d) => ({ ...d, domainId: domains[0].id }));
  }, [domains, newDraft.domainId]);

  const closeRow = (id: string) => setDrafts((cur) => { const next = { ...cur }; delete next[id]; return next; });
  const toggleRow = (k: CapabilityRow) => setDrafts((cur) => { const next = { ...cur }; if (next[k.id]) delete next[k.id]; else next[k.id] = draftOf(k); return next; });
  const setDraft = (id: string, patch: Partial<CapabilityDraft>) => setDrafts((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id], ...patch } } : cur));

  async function add() {
    if (!newDraft.name.trim() || !newDraft.domainId) return;
    const body = { name: newDraft.name, domainId: newDraft.domainId, description: newDraft.description, aiDefinition: aiTextToSave({ covers: newDraft.description, aiText: newDraft.aiDefinition, same: newDraft.same }), productLines: newDraft.productLines };
    if (await onAdd(body)) { setNewDraft(emptyDraft()); setAdding(false); }
  }
  async function save(k: CapabilityRow) {
    const d = drafts[k.id];
    if (!d || !d.name.trim()) return;
    const changes = capabilityChanges(k, d);
    if (Object.keys(changes).length === 0 || (await onSave(k.id, changes))) closeRow(k.id);
  }
  /** Enter saves from a single-line field of the form, Cmd/Ctrl+Enter from anywhere in it (a textarea keeps Enter for a new line); Esc cancels. */
  const formKeys = (onSubmit: () => void, onCancel: () => void) => (e: React.KeyboardEvent) => {
    const field = e.target instanceof HTMLElement && e.target.dataset.capField !== undefined;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (field && e.target instanceof HTMLInputElement))) { e.preventDefault(); onSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  const HINT = "mb-1 block text-[11.5px] text-fg-muted";
  /**
   * The five things a user changes on a capability, each under a visible label: 1. the name; 2. the domain; 3. what
   * it covers; 4. the text PMOS AI uses ("Same as what it covers" keeps the two in step); 5. its product lines, as
   * one dropdown with a tick per line. The add form and an open row share it.
   */
  const fields = (d: CapabilityDraft, set: (patch: Partial<CapabilityDraft>) => void, focusName: boolean) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        <label className="block w-72">
          <span className={FIELD_LABEL}>{C.settings.capabilityName}</span>
          <input type="text" data-cap-field value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={C.settings.capabilityPlaceholder} className={INPUT} disabled={busy} autoFocus={focusName} data-testid="cmp-capability-name" />
        </label>
        <label className="block w-64">
          <span className={FIELD_LABEL}>{C.settings.capabilityDomain}</span>
          <select value={d.domainId} onChange={(e) => set({ domainId: e.target.value })} className={SELECT} disabled={busy} data-testid="cmp-capability-domain">
            {domains.map((dd) => <option key={dd.id} value={dd.id}>{dd.name}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={FIELD_LABEL}>{C.settings.capabilityDescription}</span>
        <span className={HINT}>{C.settings.capabilityDescriptionHint}</span>
        <textarea data-cap-field value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder={C.settings.capabilityDescriptionPlaceholder} className={cn(INPUT, "resize-y leading-relaxed")} rows={3} maxLength={MAX_CAPABILITY_DESCRIPTION} disabled={busy} data-testid="cmp-capability-covers" />
      </label>
      <div>
        <span className={FIELD_LABEL}>{C.settings.capabilityAiText}</span>
        <span className={HINT}>{C.settings.capabilityAiTextHint}</span>
        <label className="inline-flex w-fit items-center gap-2 text-[12.5px] text-fg-2">
          <input type="checkbox" checked={d.same} onChange={(e) => set({ same: e.target.checked })} disabled={busy} data-testid="cmp-capability-same" />
          {C.settings.capabilitySameAsCovers}
        </label>
        {!d.same && (
          <textarea data-cap-field aria-label={C.settings.capabilityAiText} value={d.aiDefinition} onChange={(e) => set({ aiDefinition: e.target.value })} placeholder={C.settings.capabilityAiTextPlaceholder} className={cn(INPUT, "mt-1.5 resize-y leading-relaxed")} rows={4} maxLength={MAX_CAPABILITY_AI_DEFINITION} disabled={busy} data-testid="cmp-capability-ai-text" />
        )}
      </div>
      <div>
        <span className={FIELD_LABEL}>{C.settings.productLines}</span>
        {productLines.length === 0 ? (
          <span className="text-[12px] text-fg-muted">{C.settings.noProductLinesHint}</span>
        ) : (
          <FilterPopover label={C.settings.productLines} options={productLines} selected={d.productLines} onToggle={(line) => set({ productLines: d.productLines.includes(line) ? d.productLines.filter((l) => l !== line) : [...d.productLines, line] })} />
        )}
      </div>
    </div>
  );

  return (
    <section className="rounded-xl border border-border bg-card" data-testid="cmp-capabilities">
      <div className={cn("px-5 py-4", open && "border-b border-border")}>
        <div className="flex items-start justify-between gap-4">
          <SectionToggle section="capabilities" title={C.settings.capabilitiesTitle} count={capabilities.length} open={open} onToggle={onToggle} />
          {canEdit && !settingUp && !(adding && open) && domains.length > 0 && <button type="button" onClick={() => { onOpen(); setAdding(true); }} className={SMALL_BTN}><Plus size={13} /> {C.settings.addCapability}</button>}
        </div>
        {open && <p className="mt-1 text-sm text-muted">{C.settings.capabilitiesBlurb}</p>}
      </div>
      {open && adding && !settingUp && (
        <div onKeyDown={formKeys(() => void add(), () => setAdding(false))} className="flex flex-col gap-3 border-b border-border px-5 py-4" data-testid="cmp-capability-add-form">
          {fields(newDraft, (patch) => setNewDraft((d) => ({ ...d, ...patch })), true)}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" onClick={() => setAdding(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
            <Button type="button" variant="primary" onClick={() => void add()} disabled={busy || !newDraft.name.trim() || !newDraft.domainId}><Check size={13} /> {C.settings.save}</Button>
          </div>
        </div>
      )}
      {open && capabilities.length === 0 && <div className="px-5 py-4 text-sm text-muted">{settingUp ? C.setup.catalogNote : C.settings.emptyCapabilities}</div>}
      {open && domains.map((d) => {
        const rows = capabilities.filter((k) => k.domainId === d.id);
        if (rows.length === 0) return null;
        return (
          <div key={d.id}>
            <div className="flex items-center gap-2 border-b border-border bg-[rgba(36,87,245,.05)] px-5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.04em] text-fg-muted">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: swatchColor(d.color, PRODUCT_CHIP_DEFAULT) }} />
              {d.name}
            </div>
            {rows.map((k) => {
              const draft = drafts[k.id];
              const isOpen = draft !== undefined;
              return (
                <div key={k.id} className="border-b border-border" data-testid="cmp-capability">
                  {/* The short row: the name and its domain on one line, cut with "…" when long (the full text on hover). A click opens it downward. */}
                  <div className="flex items-center gap-2 px-5 py-2">
                    <button type="button" onClick={() => toggleRow(k)} aria-expanded={isOpen} aria-label={C.settings.capabilityOpen(k.name)} className="flex min-w-0 flex-1 items-center gap-2 text-left" data-testid="cmp-capability-row">
                      <ChevronRight size={14} className={cn("shrink-0 text-fg-muted transition-transform", isOpen && "rotate-90")} />
                      <span className="min-w-0 truncate text-[13.5px] font-medium" title={k.name}>{k.name}</span>
                      {k.origin === "ai" && <span className="shrink-0 rounded-full bg-[#eef1f6] px-1.5 py-px font-mono text-[10px] text-fg-muted">PMOS AI</span>}
                      <span className="ml-auto max-w-[260px] shrink-0 truncate text-[12px] text-fg-muted" title={d.name}>{d.name}</span>
                    </button>
                    {canEdit && <button onClick={() => void onRemove(k)} className={cn(ICON_BTN, "shrink-0 hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={14} /></button>}
                  </div>
                  {isOpen && canEdit && (
                    <div onKeyDown={formKeys(() => void save(k), () => closeRow(k.id))} className="flex flex-col gap-3 bg-[rgba(255,255,255,.6)] px-5 pb-4 pl-[42px] pt-1" data-testid="cmp-capability-form">
                      {fields(draft, (patch) => setDraft(k.id, patch), false)}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1" title={C.settings.ourStatus}>
                          <span className="mr-1 text-[12px] font-medium text-fg-3">{C.settings.ourStatus}</span>
                          {OWN_STATUS_VALUES.map((v) => (
                            <button key={v} type="button" onClick={() => k.ourStatus !== v && void onSave(k.id, { ourStatus: v })} disabled={busy} aria-pressed={k.ourStatus === v}
                              className={cn("rounded-full border px-2 py-px font-mono text-[10px] font-semibold", k.ourStatus === v
                                ? v === "found" ? "border-transparent bg-[rgba(23,178,106,.16)] text-[#0f7a47]" : "border-transparent bg-[#fff7e0] text-[#8a5a00]"
                                : "border-border bg-white text-fg-faint hover:border-primary/55")}>
                              {C.values[v]}
                            </button>
                          ))}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          <Button type="button" onClick={() => closeRow(k.id)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
                          <Button type="button" variant="primary" onClick={() => void save(k)} disabled={busy || !draft.name.trim()}><Check size={13} /> {C.settings.save}</Button>
                        </span>
                      </div>
                    </div>
                  )}
                  {isOpen && !canEdit && (
                    <div className="flex flex-col gap-2 px-5 pb-3 pl-[42px] text-[12.5px] text-fg-2" data-testid="cmp-capability-details">
                      <div><span className={FIELD_LABEL}>{C.settings.capabilityDescription}</span>{k.description || <span className="italic text-fg-faint">{C.settings.capabilityNoCovers}</span>}</div>
                      {/* Never the same words twice: PMOS AI's own text shows only when it differs from what it covers. */}
                      {aiTextSameAsCovers(k.description, k.aiDefinition) ? (
                        <div className="text-[12px] text-fg-muted">{C.settings.capabilitySameNote}</div>
                      ) : (
                        <div><span className={FIELD_LABEL}>{C.settings.capabilityAiText}</span>{k.aiDefinition}</div>
                      )}
                      <div><span className={FIELD_LABEL}>{C.settings.productLines}</span>{k.productLines.length ? k.productLines.join(" · ") : <span className="italic text-fg-faint">{C.settings.capabilityNoProductLines}</span>}</div>
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
