"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, Globe, GripVertical, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { ColorSwatch } from "@/components/settings/ColorSwatch";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { frequencyMs, MAX_DOMAIN_DESCRIPTION, MAX_MAX_PAGES, MIN_MAX_PAGES, OWN_STATUS_VALUES, SCAN_FREQUENCIES } from "@/lib/competitors/config";
import type { CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow } from "@/lib/competitors/store";
import { PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { mentionsName } from "@/lib/competitors/mentions";
import { scanSummaryLine } from "@/lib/competitors/summary";
import { timeAgo, timeUntil } from "@/lib/competitors/time";
import { track } from "@/lib/analytics/track";
import { cn } from "@/lib/utils";
import { ScanLogDrawer } from "./ScanLogDrawer";

const INPUT =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)] disabled:opacity-60";
const SELECT = INPUT + " pr-8";
const SMALL_BTN =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-white px-3 text-[12px] font-medium hover:border-primary disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BTN = "rounded-md p-1.5 text-fg-muted hover:bg-background hover:text-foreground disabled:opacity-40";

const STATUS_PILL: Record<string, string> = {
  full: "bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
  incomplete: "bg-[#fff7e0] text-[#8a5a00]",
  blocked: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  unreachable: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  running: "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]",
  never: "bg-[#eef1f6] text-[#4a5b74]",
};

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
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/competitors");
    const data = await res.json();
    if (res.ok) setState(data.state);
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
  useEffect(() => {
    if (!scanning) return;
    const tick = async () => {
      await refresh();
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [scanning, refresh]);

  async function scanNow(c: CompetitorRow) {
    setError(null);
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
  const nextScanAt = (c: CompetitorRow) =>
    c.source?.lastScanAt ? new Date(new Date(c.source.lastScanAt).getTime() + frequencyMs(state.config.scanFrequency)).toISOString() : null;

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
          domains={state.domains}
          competitors={state.competitors}
          canEdit={canEdit}
          busy={busy}
          onDecide={(id, body) => call("PATCH", `/api/competitors/capabilities/${id}`, body)}
        />
      )}

      {/* Domains */}
      <DomainsPanel domains={state.domains} capabilities={active} cells={state.cells} competitors={state.competitors} canEdit={canEdit} busy={busy}
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
          const n = active.filter((k) => k.domainId === d.id).length;
          if (!(await confirm({ title: C.settings.removeDomainTitle(d.name), message: C.settings.removeDomainBody(n), confirmLabel: C.settings.remove, tone: "danger" }))) return;
          await call("DELETE", `/api/competitors/domains/${d.id}`);
        }}
      />

      {/* Capabilities */}
      <CapabilitiesPanel capabilities={active} domains={state.domains} productLines={state.productLines} canEdit={canEdit} busy={busy}
        onAdd={(body) => call("POST", "/api/competitors/capabilities", body)}
        onSave={(id, body) => call("PATCH", `/api/competitors/capabilities/${id}`, body)}
        onRemove={async (k) => {
          if (!(await confirm({ title: C.settings.removeCapabilityTitle(k.name), message: C.settings.removeCapabilityBody, confirmLabel: C.settings.remove, tone: "danger" }))) return;
          await call("DELETE", `/api/competitors/capabilities/${k.id}`);
        }}
      />

      {/* Schedule */}
      <SchedulePanel config={state.config} canEdit={canEdit} busy={busy} onSave={(body) => call("PATCH", "/api/competitors/settings", body)} />

      {logFor && <ScanLogDrawer competitorId={logFor.id} competitorName={logFor.name} onClose={() => setLogFor(null)} />}
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
  const status = c.activeScanId ? "running" : c.lastScan?.badge ?? (c.source?.lastScanAt ? "incomplete" : "never");
  const summary = c.activeScanId ? "" : scanSummaryLine(c, nextScanAt);

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
          <input value={website} onChange={(e) => setWebsite(e.target.value)} className={INPUT} disabled={busy} />
          <button onClick={() => setEditing(false)} className={ICON_BTN} aria-label={C.settings.cancel} disabled={busy}><X size={14} /></button>
          <button onClick={save} className={cn(ICON_BTN, "text-primary")} aria-label={C.settings.save} disabled={busy || !name.trim()}><Check size={14} /></button>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{c.name}</span>
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-px text-[11px] font-semibold", STATUS_PILL[status] ?? STATUS_PILL.never)} title={C.settings.badgeHint[status]}>
              {status === "running" ? C.settings.scanning : status === "never" ? C.settings.neverScanned : C.settings.badges[status] ?? status}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
            <a href={c.websiteUrl} target="_blank" rel="noreferrer" className="hover:underline">{c.host}</a>
            {c.source?.lastScanAt && <span>· {C.settings.lastScan(timeAgo(c.source.lastScanAt))}</span>}
            {nextScanAt && status !== "running" && <span>· {C.settings.nextScan(timeUntil(nextScanAt))}</span>}
          </div>
          {summary && <div className={cn("mt-1 text-[12px]", status === "blocked" || status === "unreachable" ? "text-[#c23767]" : "text-fg-3")}>{summary}</div>}
        </div>
      )}
      {!editing && (
        <>
          <span title={scanning ? C.settings.scanRunning : rescanLimited ? C.settings.rescanLimited : undefined}>
            <button
              onClick={async () => { setStarting(true); await onScan(c); setStarting(false); }}
              disabled={scanning || starting || busy || rescanLimited}
              className={SMALL_BTN}
            >
              {status === "running" || starting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {status === "running" ? C.settings.scanning : rescanLimited ? C.settings.rescanLimitedShort : C.settings.scanNow}
            </button>
          </span>
          <button onClick={() => onLog(c)} className={SMALL_BTN} title={C.settings.viewLog}>
            <FileText size={12} /> {C.settings.viewLog}
          </button>
          {canEdit && (
            <>
              <button onClick={() => { setName(c.name); setWebsite(c.websiteUrl); setEditing(true); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={14} /></button>
              <button onClick={() => void onRemove(c)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy || status === "running"}><Trash2 size={14} /></button>
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
                  “{quote[0]}”{quote[1] && <> — <a href={`https${quote[1]}`} target="_blank" rel="noreferrer" className="not-italic hover:underline">source</a></>}
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
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** Competitors that have a capability of this domain in full while the org doesn't. */
  function competitorsAhead(d: DomainRow): number {
    const caps = capabilities.filter((k) => k.domainId === d.id && k.ourStatus !== "has");
    const ahead = new Set<string>();
    for (const k of caps) for (const c of cells) if (c.capabilityId === k.id && c.value === "has") ahead.add(c.competitorId);
    return [...ahead].filter((id) => competitors.some((c) => c.id === id)).length;
  }

  async function add() {
    if (!name.trim()) return;
    if (await onAdd({ name, description })) { setName(""); setDescription(""); setAdding(false); }
  }
  async function saveEdit(id: string) {
    const d = domains.find((x) => x.id === id);
    const body = { name: editName, description: editDescription };
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
                          <button onClick={() => { setEditingId(d.id); setEditName(d.name); setEditDescription(d.description); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={13} /></button>
                          <button onClick={() => void onRemove(d)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={13} /></button>
                        </>
                      )}
                    </span>
                  </div>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  useEffect(() => {
    if (!domainId && domains[0]) setDomainId(domains[0].id);
  }, [domains, domainId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !domainId) return;
    if (await onAdd({ name, domainId, description })) { setName(""); setDescription(""); setAdding(false); }
  }
  async function saveEdit(id: string) {
    if (await onSave(id, { name: editName, description: editDescription })) setEditingId(null);
  }
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
        <form onSubmit={add} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAdding(false); } }} className="flex items-start gap-2 border-b border-border px-5 py-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.settings.capabilityPlaceholder} className={cn(INPUT, "w-64 shrink-0")} disabled={busy} autoFocus />
          <select value={domainId} onChange={(e) => setDomainId(e.target.value)} className={cn(SELECT, "w-52 shrink-0")} disabled={busy} aria-label="Domain">
            {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={C.settings.capabilityDescriptionPlaceholder} className={INPUT} disabled={busy} />
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
                    <div className="flex min-w-0 flex-1 items-center gap-2"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEdit(k.id); } if (e.key === "Escape") setEditingId(null); }}>
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} className={cn(INPUT, "w-64")} disabled={busy} autoFocus />
                      <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className={INPUT} disabled={busy} placeholder={C.settings.capabilityDescriptionPlaceholder} />
                      <button onClick={() => setEditingId(null)} className={ICON_BTN} aria-label={C.settings.cancel}><X size={14} /></button>
                      <button onClick={() => saveEdit(k.id)} className={cn(ICON_BTN, "text-primary")} aria-label={C.settings.save} disabled={busy || !editName.trim()}><Check size={14} /></button>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium">{k.name}</span>
                        {k.origin === "ai" && <span className="rounded-full bg-[#eef1f6] px-1.5 py-px font-mono text-[10px] text-fg-muted">PMOS AI</span>}
                        <span className="ml-1 inline-flex items-center gap-1" title={C.settings.ourStatus}>
                          {OWN_STATUS_VALUES.map((v) => (
                            <button key={v} type="button" onClick={() => k.ourStatus !== v && void onSave(k.id, { ourStatus: v })} disabled={busy} aria-pressed={k.ourStatus === v}
                              className={cn("rounded-full border px-2 py-px font-mono text-[10px] font-semibold", k.ourStatus === v
                                ? v === "has" ? "border-transparent bg-[rgba(23,178,106,.16)] text-[#0f7a47]" : v === "partial" ? "border-transparent bg-[rgba(59,124,246,.15)] text-[#2a5fd0]" : "border-transparent bg-[#fff7e0] text-[#8a5a00]"
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
                      <button onClick={() => { setEditingId(k.id); setEditName(k.name); setEditDescription(k.description); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={14} /></button>
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
  const [pages, setPages] = useState(String(config.maxPagesPerScan));
  const [saved, setSaved] = useState(false);
  useEffect(() => setPages(String(config.maxPagesPerScan)), [config.maxPagesPerScan]);

  async function savePages() {
    const n = Number(pages);
    if (!Number.isFinite(n)) return;
    if (await onSave({ maxPagesPerScan: n })) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="font-medium text-foreground">{C.settings.scheduleTitle}</div>
        <p className="mt-1 text-sm text-muted">{C.settings.scheduleBlurb}</p>
      </div>
      <div className="flex flex-wrap items-end gap-6 px-5 py-4">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-fg-3">{C.settings.frequency}</span>
          <select value={config.scanFrequency} onChange={(e) => void onSave({ scanFrequency: e.target.value })} className={cn(SELECT, "w-44")} disabled={!canEdit || busy}>
            {SCAN_FREQUENCIES.map((f) => <option key={f} value={f}>{C.settings.frequencies[f]}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-fg-3">{C.settings.manualRescans}</span>
          <select value={config.manualRescansPerDay} onChange={(e) => void onSave({ manualRescansPerDay: Number(e.target.value) })} className={cn(SELECT, "w-44")} disabled={!canEdit || busy} title={C.settings.manualRescansHint}>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} per day</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-fg-3">{C.settings.maxPages}</span>
          <div className="flex items-center gap-2">
            <input type="number" min={MIN_MAX_PAGES} max={MAX_MAX_PAGES} value={pages} onChange={(e) => setPages(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void savePages(); } }}
              onBlur={() => { if (Number(pages) !== config.maxPagesPerScan) void savePages(); }}
              className={cn(INPUT, "w-28")} disabled={!canEdit || busy} />
            {saved && <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[#0f7a47]"><Check size={12} strokeWidth={2.5} /> {C.settings.saved}</span>}
          </div>
        </label>
        <p className="basis-full text-[12px] text-fg-muted">{C.settings.maxPagesHint}</p>
      </div>
    </section>
  );
}
