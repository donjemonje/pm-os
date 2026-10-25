"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, Globe, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { frequencyMs, MAX_MAX_PAGES, MIN_MAX_PAGES, SCAN_FREQUENCIES } from "@/lib/competitors/config";
import type { CapabilityRow, CompetitorRow, CompetitorsState, DomainRow } from "@/lib/competitors/store";
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
  ok: "bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
  partial: "bg-[#fff7e0] text-[#8a5a00]",
  failed: "bg-[rgba(239,90,138,.15)] text-[#c23767]",
  running: "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]",
  never: "bg-[#eef1f6] text-[#4a5b74]",
};

const POLL_MS = 3000;

/**
 * Settings → Competitors: own website, competitors (with Scan now and the
 * scan log), suggestions waiting for review, domains, the capability catalog
 * and the scan schedule. Reads are for everyone; catalog and schedule writes
 * need a customer admin (the API enforces the same). Scan now and the log are
 * for every member.
 */
export function CompetitorsSettings({ initialState, canEdit }: { initialState: CompetitorsState; canEdit: boolean }) {
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

  async function call(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<boolean> {
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

  const self = state.competitors.find((c) => c.isSelf) ?? null;
  const others = state.competitors.filter((c) => !c.isSelf);
  const suggested = state.capabilities.filter((k) => k.state === "suggested");
  const active = state.capabilities.filter((k) => k.state === "active");
  const nextScanAt = (c: CompetitorRow) =>
    c.source?.lastScanAt ? new Date(new Date(c.source.lastScanAt).getTime() + frequencyMs(state.config.scanFrequency)).toISOString() : null;

  return (
    <div className="space-y-8">
      {error && <div className="rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">{error}</div>}
      {!canEdit && <div className="text-[12.5px] text-fg-muted">{C.settings.viewOnly}</div>}

      {/* Own website */}
      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="font-medium text-foreground">{C.settings.ownSite}</div>
          <p className="mt-1 text-sm text-muted">{C.settings.ownSiteBlurb}</p>
        </div>
        {self ? (
          <CompetitorLine c={self} busy={busy} scanning={scanning} canEdit={canEdit} nextScanAt={nextScanAt(self)} onScan={scanNow} onLog={setLogFor} onRemove={removeCompetitor} onSave={(id, body) => call("PATCH", `/api/competitors/${id}`, body)} />
        ) : canEdit ? (
          <AddCompetitorForm label={C.settings.addOwnSite} isSelf busy={busy} onAdd={(body) => call("POST", "/api/competitors", body)} />
        ) : (
          <div className="px-5 py-4 text-sm text-muted">{C.settings.noOwnSite}</div>
        )}
      </section>

      {/* Competitors */}
      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="font-medium text-foreground">{C.settings.competitorsTitle}</div>
          <p className="mt-1 text-sm text-muted">{C.settings.competitorsBlurb}</p>
        </div>
        {canEdit && <AddCompetitorForm label={C.settings.addCompetitor} busy={busy} onAdd={(body) => call("POST", "/api/competitors", body)} />}
        {others.length === 0 ? (
          <div className="px-5 py-4 text-sm text-muted">{C.settings.emptyCompetitors}</div>
        ) : (
          others.map((c) => (
            <CompetitorLine key={c.id} c={c} busy={busy} scanning={scanning} canEdit={canEdit} nextScanAt={nextScanAt(c)} onScan={scanNow} onLog={setLogFor} onRemove={removeCompetitor} onSave={(id, body) => call("PATCH", `/api/competitors/${id}`, body)} />
          ))
        )}
      </section>

      {/* Suggestions / proposed catalog */}
      {suggested.length > 0 && (
        <SuggestionsPanel
          suggested={suggested}
          domains={state.domains}
          competitors={state.competitors}
          fromOwnSite={active.length === 0 && suggested.every((k) => k.suggestedById === self?.id)}
          canEdit={canEdit}
          busy={busy}
          onDecide={(id, body) => call("PATCH", `/api/competitors/capabilities/${id}`, body)}
        />
      )}

      {/* Domains */}
      <DomainsPanel domains={state.domains} capabilities={active} canEdit={canEdit} busy={busy}
        onAdd={(body) => call("POST", "/api/competitors/domains", body)}
        onSave={(id, body) => call("PATCH", `/api/competitors/domains/${id}`, body)}
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

function CompetitorLine({ c, busy, scanning, canEdit, nextScanAt, onScan, onLog, onRemove, onSave }: {
  c: CompetitorRow;
  busy: boolean;
  scanning: boolean;
  canEdit: boolean;
  nextScanAt: string | null;
  onScan: (c: CompetitorRow) => Promise<void>;
  onLog: (c: CompetitorRow) => void;
  onRemove: (c: CompetitorRow) => Promise<void>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [website, setWebsite] = useState(c.websiteUrl);
  const [starting, setStarting] = useState(false);
  const status = c.activeScanId ? "running" : c.source?.lastStatus ?? "never";
  const reason = c.source?.lastError ? C.errors[c.source.lastError] ?? c.source.lastError : null;

  async function save() {
    if (await onSave(c.id, { name, website })) setEditing(false);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-white text-fg-muted">
        <Globe size={14} />
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
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-px text-[11px] font-semibold", STATUS_PILL[status] ?? STATUS_PILL.never)}>
              {status === "running" ? C.settings.scanning : status === "never" ? C.settings.neverScanned : C.log.status[status] ?? status}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
            <a href={c.websiteUrl} target="_blank" rel="noreferrer" className="hover:underline">{c.host}</a>
            {c.source?.lastScanAt && <span>· {C.settings.lastScan(timeAgo(c.source.lastScanAt))}</span>}
            {nextScanAt && status !== "running" && <span>· {C.settings.nextScan(timeUntil(nextScanAt))}</span>}
            {reason && status !== "running" && <span className="text-[#c23767]">· {status === "partial" ? C.settings.partial(reason) : C.settings.failed(reason)}</span>}
          </div>
        </div>
      )}
      {!editing && (
        <>
          <span title={scanning ? C.settings.scanRunning : undefined}>
            <button
              onClick={async () => { setStarting(true); await onScan(c); setStarting(false); }}
              disabled={scanning || starting || busy}
              className={SMALL_BTN}
            >
              {status === "running" || starting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {status === "running" ? C.settings.scanning : C.settings.scanNow}
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

function AddCompetitorForm({ label, isSelf, busy, onAdd }: { label: string; isSelf?: boolean; busy: boolean; onAdd: (body: unknown) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !website.trim()) return;
    if (await onAdd({ name, website, isSelf: isSelf === true })) {
      setName(""); setWebsite(""); setOpen(false);
      track("cmp_competitor_added_ui", { isSelf: isSelf === true });
    }
  }
  if (!open) {
    return (
      <div className="border-b border-border px-5 py-3">
        <button type="button" onClick={() => setOpen(true)} className={SMALL_BTN}><Plus size={13} /> {label}</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } }} className="flex items-start gap-2 border-b border-border px-5 py-4">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.settings.namePlaceholder} className={cn(INPUT, "w-48 shrink-0")} disabled={busy} autoFocus aria-label={C.settings.name} />
      <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={C.settings.websitePlaceholder} className={INPUT} disabled={busy} aria-label={C.settings.website} />
      <Button type="button" onClick={() => setOpen(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
      <Button type="submit" variant="primary" disabled={busy || !name.trim() || !website.trim()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {C.settings.save}
      </Button>
    </form>
  );
}

// ————— Suggestions —————

function SuggestionsPanel({ suggested, domains, competitors, fromOwnSite, canEdit, busy, onDecide }: {
  suggested: CapabilityRow[];
  domains: DomainRow[];
  competitors: CompetitorRow[];
  fromOwnSite: boolean;
  canEdit: boolean;
  busy: boolean;
  onDecide: (id: string, body: unknown) => Promise<boolean>;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [domainOf, setDomainOf] = useState<Record<string, string>>({});
  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? "";
  const competitorName = (id: string | null) => competitors.find((c) => c.id === id)?.name ?? "";

  async function acceptAll() {
    for (const k of suggested) {
      await onDecide(k.id, { state: "active", ...(names[k.id] && names[k.id] !== k.name ? { name: names[k.id] } : {}), ...(domainOf[k.id] && domainOf[k.id] !== k.domainId ? { domainId: domainOf[k.id] } : {}) });
    }
  }

  return (
    <section className="rounded-xl border border-primary/40 bg-card shadow-[0_0_0_3px_rgba(36,87,245,.06)]">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="font-medium text-foreground">{fromOwnSite ? C.settings.proposalTitle : C.settings.suggestionsTitle}</div>
          <p className="mt-1 text-sm text-muted">{fromOwnSite ? C.settings.proposalBlurb(suggested.length) : C.settings.suggestionsBlurb}</p>
        </div>
        {canEdit && fromOwnSite && (
          <Button variant="primary" size="sm" onClick={acceptAll} disabled={busy}>
            <Check size={13} /> Accept all
          </Button>
        )}
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
                {!fromOwnSite && k.suggestedById && <span className="text-[12px] text-fg-muted">{C.settings.suggestedBy(competitorName(k.suggestedById))}</span>}
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

// ————— Domains —————

function DomainsPanel({ domains, capabilities, canEdit, busy, onAdd, onSave, onRemove }: {
  domains: DomainRow[];
  capabilities: CapabilityRow[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (body: unknown) => Promise<boolean>;
  onSave: (id: string, body: unknown) => Promise<boolean>;
  onRemove: (d: DomainRow) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (await onAdd({ name, description })) { setName(""); setDescription(""); setAdding(false); }
  }
  async function saveEdit(id: string) {
    if (await onSave(id, { name: editName, description: editDescription })) setEditingId(null);
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="font-medium text-foreground">{C.settings.domainsTitle}</div>
          {canEdit && !adding && <button type="button" onClick={() => setAdding(true)} className={SMALL_BTN}><Plus size={13} /> {C.settings.addDomain}</button>}
        </div>
        <p className="mt-1 text-sm text-muted">{C.settings.domainsBlurb}</p>
      </div>
      {adding && (
        <form onSubmit={add} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAdding(false); } }} className="flex items-start gap-2 border-b border-border px-5 py-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.settings.domainPlaceholder} className={cn(INPUT, "w-56 shrink-0")} disabled={busy} autoFocus />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={C.settings.domainDescriptionPlaceholder} className={INPUT} disabled={busy} />
          <Button type="button" onClick={() => setAdding(false)} disabled={busy}><X size={13} /> {C.settings.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}><Check size={13} /> {C.settings.save}</Button>
        </form>
      )}
      {domains.length === 0 && <div className="px-5 py-4 text-sm text-muted">{C.settings.emptyDomains}</div>}
      {domains.map((d) => {
        const n = capabilities.filter((k) => k.domainId === d.id).length;
        const editing = editingId === d.id;
        return (
          <div key={d.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
            {editing ? (
              <div className="flex min-w-0 flex-1 items-center gap-2"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEdit(d.id); } if (e.key === "Escape") setEditingId(null); }}>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} className={cn(INPUT, "w-56")} disabled={busy} autoFocus />
                <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className={INPUT} disabled={busy} placeholder={C.settings.domainDescriptionPlaceholder} />
                <button onClick={() => setEditingId(null)} className={ICON_BTN} aria-label={C.settings.cancel}><X size={14} /></button>
                <button onClick={() => saveEdit(d.id)} className={cn(ICON_BTN, "text-primary")} aria-label={C.settings.save} disabled={busy || !editName.trim()}><Check size={14} /></button>
              </div>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{d.name} <span className="ml-1 font-mono text-[11px] font-normal text-fg-muted">{C.matrix.capabilitiesCount(n)}</span></div>
                  {d.description && <div className="mt-0.5 text-[12.5px] text-fg-3">{d.description}</div>}
                </div>
                {canEdit && (
                  <>
                    <button onClick={() => { setEditingId(d.id); setEditName(d.name); setEditDescription(d.description); }} className={ICON_BTN} aria-label={C.settings.edit} disabled={busy}><Pencil size={14} /></button>
                    <button onClick={() => void onRemove(d)} className={cn(ICON_BTN, "hover:text-[#c23767]")} aria-label={C.settings.remove} disabled={busy}><Trash2 size={14} /></button>
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
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
            <div className="border-b border-border bg-[rgba(36,87,245,.05)] px-5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.04em] text-fg-muted">{d.name}</div>
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
