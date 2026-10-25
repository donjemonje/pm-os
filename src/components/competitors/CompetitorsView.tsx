"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronDown, ChevronRight, Download, ExternalLink, Pencil, Search, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { Ring } from "@/components/ui/Ring";
import { initialsOf } from "@/components/ui/Avatar";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { STATUS_VALUES, type StatusValue } from "@/lib/competitors/config";
import type { CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow, FactRow } from "@/lib/competitors/store";
import { shortDate, timeAgo } from "@/lib/competitors/time";
import { cn } from "@/lib/utils";

type Tab = "parity" | "feed" | "profiles" | "cards" | "roadmap";

const TABS: { key: Tab; label: string }[] = [
  { key: "parity", label: C.tabs.parity },
  { key: "feed", label: C.tabs.feed },
  { key: "profiles", label: C.tabs.profiles },
  { key: "cards", label: C.tabs.cards },
  { key: "roadmap", label: C.tabs.roadmap },
];

const STATUS_OPTIONS = STATUS_VALUES.map((v) => C.values[v]);
const IMPACTS = ["High", "Medium", "Low"];
const POLL_MS = 3000;
/** A cell counts as "new change" when it changed within this window before the competitor's last scan. */
const NEW_CHANGE_WINDOW_MS = 2 * 3600_000;

function chipClass(active: boolean): string {
  return active
    ? "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-primary px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_-6px_var(--app-accent)]"
    : "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-[var(--app-glass)] px-3 text-[12.5px] font-semibold text-[#3f506b] shadow-sm hover:border-primary/55 hover:bg-white";
}

function toggleIn(setter: React.Dispatch<React.SetStateAction<string[]>>) {
  return (o: string) => setter((prev) => (prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]));
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-[250px]">
      <span className="sr-only">{placeholder.replace("…", "")}</span>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-control border border-border bg-[var(--app-glass)] pl-9 pr-3 text-[13px] shadow-sm outline-none placeholder:text-fg-faint focus:border-primary focus:bg-white focus:shadow-[0_0_0_2px_var(--app-accent-soft)]"
      />
    </label>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass rounded-card px-10 py-16 text-center">
      <div className="font-title mb-1 text-[16px] font-bold">{title}</div>
      <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{body}</div>
    </div>
  );
}

function StatCard({ label, tone, toneFg, value, sub }: { label: string; tone: string; toneFg: string; value: number | null; sub: string }) {
  return (
    <div className="relative flex min-w-[132px] flex-[0.55] flex-col gap-0.5 overflow-hidden rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: tone }} />
      <span className="flex items-baseline gap-2">
        <span className={cn("font-title text-2xl font-bold leading-none", value == null && "text-fg-faint")}>{value ?? "—"}</span>
        <span className="font-mono text-[10px] font-medium tracking-[0.04em]" style={{ color: toneFg }}>{label}</span>
      </span>
      <span className="mt-1 text-[11.5px] text-fg-muted">{sub}</span>
    </div>
  );
}

function OkMark({ size = 22, solid }: { size?: number; solid?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-full", solid ? "bg-[#17b26a] text-white" : "bg-[rgba(23,178,106,.16)] text-[#0f7a47]")}
      style={{ width: size, height: size }}
    >
      <Check size={Math.round(size * 0.55)} strokeWidth={3} />
    </span>
  );
}

function Logo({ c, size = 28, dark }: { c: CompetitorRow; size?: number; dark?: boolean }) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] border text-[11px] font-bold", dark ? "border-[#0b1430] bg-[#0b1430] text-[#f3f1fb]" : "border-border bg-white text-fg-2")}
      style={{ width: size, height: size }}
      title={c.name}
    >
      {c.logoUrl ? <img src={c.logoUrl} alt="" className="h-[70%] w-[70%] object-contain" /> : initialsOf(c.name)}
    </span>
  );
}

/** The value a cell displays — a correction wins; a low-confidence scan shows as "partial?". */
function CellValue({ cell, size = 22 }: { cell: CellRow | undefined; size?: number }) {
  if (!cell) return <span className="text-[12px] text-fg-faint">—</span>;
  const v = cell.value;
  if (v === "has") return <OkMark size={size} />;
  if (v === "partial") {
    return (
      <span className="inline-block rounded-full bg-[rgba(59,124,246,.15)] px-2 py-px text-[11px] font-semibold text-[#2a5fd0]" title={cell.lowConfidence ? C.matrix.lowConfidence : undefined}>
        {C.values.partial}{cell.lowConfidence ? "?" : ""}
      </span>
    );
  }
  if (v === "missing") return <span className="font-semibold text-[#5b6c85]">—</span>;
  return <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-[#9aa8be]" title={C.matrix.unknownTip} aria-label={C.values.unknown} />;
}

/**
 * The Competitors page: the C2 full-screen matrix fed by real data — the
 * org's own column first, one column per competitor, rows grouped by domain,
 * a summary strip, filters, cell evidence with a correction, lean profiles.
 * Feed and battle cards stay empty until their stories.
 */
export function CompetitorsView({ initialState }: { initialState: CompetitorsState }) {
  const [state, setState] = useState(initialState);
  const own = state.orgName.trim() || "Your organization";
  const [tab, setTab] = useState<Tab>("parity");
  const [selectedCompetitor, setSelectedCompetitor] = useState<string | null>(null);
  const [openCell, setOpenCell] = useState<{ competitorId: string; capabilityId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Parity matrix filters
  const [capQuery, setCapQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<string[]>([]);
  const [productFilter, setProductFilter] = useState<string[]>([]);
  const [competitorFilter, setCompetitorFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [newChanges, setNewChanges] = useState(false);

  // News feed filters (story 4 fills them)
  const [signalQuery, setSignalQuery] = useState("");
  const [feedCompetitor, setFeedCompetitor] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [impactFilter, setImpactFilter] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/competitors");
    const data = await res.json();
    if (res.ok) setState(data.state);
  }, []);

  // While a scan runs, learn when it ends; results land in one go.
  useEffect(() => {
    if (!state.scanning) return;
    const tick = async () => {
      await refresh();
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [state.scanning, refresh]);

  // ——— Derived data ———
  const self = state.competitors.find((c) => c.isSelf) ?? null;
  const competitors = state.competitors.filter((c) => !c.isSelf);
  const activeCaps = useMemo(() => state.capabilities.filter((k) => k.state === "active"), [state.capabilities]);
  const cellMap = useMemo(() => {
    const m = new Map<string, CellRow>();
    for (const c of state.cells) m.set(`${c.competitorId}|${c.capabilityId}`, c);
    return m;
  }, [state.cells]);
  const cellOf = (competitorId: string | null | undefined, capabilityId: string) => (competitorId ? cellMap.get(`${competitorId}|${capabilityId}`) : undefined);
  const lastScanOf = new Map(state.competitors.map((c) => [c.id, c.source?.lastScanAt ? new Date(c.source.lastScanAt).getTime() : null]));
  const isNewChange = (cell: CellRow | undefined) => {
    if (!cell?.changedAt) return false;
    const last = lastScanOf.get(cell.competitorId);
    if (!last) return false;
    return new Date(cell.changedAt).getTime() >= last - NEW_CHANGE_WINDOW_MS;
  };
  /** Gap = own missing/unknown while any competitor has it; only-us = own has while no competitor has/partial. */
  const rowKind = (k: CapabilityRow): "gap" | "partial" | "only" | "level" | "none" => {
    const ownCell = cellOf(self?.id, k.id);
    const theirs = competitors.map((c) => cellOf(c.id, k.id)?.value ?? "unknown");
    const anyHas = theirs.some((v) => v === "has");
    const anyHasOrPartial = theirs.some((v) => v === "has" || v === "partial");
    const ownV = ownCell?.value ?? "unknown";
    if (competitors.length === 0) return "none";
    if (ownV === "has" && !anyHasOrPartial) return "only";
    if ((ownV === "missing" || ownV === "unknown") && anyHas) return "gap";
    if (ownV === "partial" && anyHas) return "partial";
    return "level";
  };

  const summary = useMemo(() => {
    const total = activeCaps.length;
    let full = 0, partial = 0, gaps = 0, only = 0;
    for (const k of activeCaps) {
      const kind = rowKind(k);
      const ownV = cellOf(self?.id, k.id)?.value ?? "unknown";
      if (ownV === "has") full++;
      else if (ownV === "partial") partial++;
      if (kind === "gap") gaps++;
      if (kind === "only") only++;
    }
    const measured = self != null && competitors.length > 0 && total > 0 && state.cells.length > 0;
    return { total, full, partial, gaps, only, measured, parity: measured ? Math.round(((full + partial * 0.5) / total) * 100) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCaps, state.cells, self, competitors.length]);

  const shownCompetitors = competitors.filter((c) => competitorFilter.length === 0 || competitorFilter.includes(c.name));
  const q = capQuery.trim().toLowerCase();
  const matchesStatus = (k: CapabilityRow) => {
    if (statusFilter.length === 0) return true;
    const wanted = STATUS_VALUES[STATUS_OPTIONS.indexOf(statusFilter[0])];
    return shownCompetitors.some((c) => (cellOf(c.id, k.id)?.value ?? "unknown") === wanted);
  };
  const visibleCaps = activeCaps.filter((k) => {
    if (q && !k.name.toLowerCase().includes(q) && !k.description.toLowerCase().includes(q)) return false;
    if (domainFilter.length && !domainFilter.includes(state.domains.find((d) => d.id === k.domainId)?.name ?? "")) return false;
    if (productFilter.length && !k.productLines.some((p) => productFilter.includes(p))) return false;
    if (gapsOnly && rowKind(k) !== "gap" && rowKind(k) !== "partial") return false;
    if (newChanges && !shownCompetitors.some((c) => isNewChange(cellOf(c.id, k.id))) && !isNewChange(cellOf(self?.id, k.id))) return false;
    return matchesStatus(k);
  });
  const domainsWithRows = state.domains.filter((d) => visibleCaps.some((k) => k.domainId === d.id));

  useEffect(() => {
    if (tab !== "parity") return;
    const t = setTimeout(() => {
      track("cmp_matrix_viewed", {
        competitors: competitors.length,
        capabilities: activeCaps.length,
        filters: [domainFilter.length && "domain", productFilter.length && "productLine", competitorFilter.length && "competitor", statusFilter.length && "status"].filter(Boolean).join(","),
        gapsOnly,
        newChanges,
      });
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, domainFilter, productFilter, competitorFilter, statusFilter, gapsOnly, newChanges]);

  // ——— Corrections ———
  async function patch(url: string, body: unknown): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? C.cell.saveFailed);
      if (data.state) setState(data.state);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : C.cell.saveFailed);
      return false;
    }
  }

  function openProfile(competitorId: string, from: "tab" | "cell") {
    setSelectedCompetitor(competitorId);
    setTab("profiles");
    setOpenCell(null);
    const facts = state.facts.filter((f) => f.competitorId === competitorId);
    track("cmp_profile_viewed", { competitorId, factsShown: facts.length, factsMissing: 7 - new Set(facts.map((f) => f.kind)).size, from });
  }

  const sourcesCount = state.competitors.filter((c) => c.source).length;
  const headerScan = state.scanning ? C.header.scanning : state.lastScanAt ? C.header.scanned(timeAgo(state.lastScanAt)) : C.header.neverScanned;

  return (
    <div className="app-canvas font-title min-h-full">
      <div className="mx-auto w-full max-w-[1680px] px-7 pb-24 pt-6">
        {/* Header + tabs */}
        <header className="mb-4 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-3.5">
            <h1 className="font-title m-0 text-[26px] font-bold leading-none tracking-[-0.02em]">{C.pageTitle}</h1>
            <span className="ml-1.5 text-[11px] text-fg-faint">
              {C.header.counts(competitors.length, sourcesCount)} · {headerScan}
            </span>
          </div>
          <div role="tablist" aria-label="Competitor views" className="flex flex-wrap gap-1.5 border-b border-border pb-3">
            {TABS.map(({ key, label }) => {
              const on = tab === key;
              const badge = key === "roadmap" && summary.measured ? summary.gaps + summary.partial : 0;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(key)}
                  className={`font-title inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border px-4 text-[13px] font-semibold transition-[background,box-shadow] ${
                    on
                      ? "border-transparent bg-primary text-white shadow-[0_6px_18px_-6px_rgba(36,87,245,.8)]"
                      : "border-border bg-[var(--app-glass)] text-fg-3 shadow-sm hover:border-primary/55 hover:bg-white"
                  }`}
                >
                  {label}
                  {badge > 0 && (
                    <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold", on ? "bg-white/25 text-white" : "bg-[#eef1f6] text-fg-3")}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        </header>

        {error && <div className="mb-4 rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">{error}</div>}

        {tab === "parity" && (
          <section aria-label={C.tabs.parity} className="flex flex-col">
            {/* Summary strip */}
            <div className="glass-weak mb-4 flex flex-wrap items-stretch gap-3 rounded-card p-3">
              <div className="flex min-w-[280px] items-center gap-3.5 py-1.5 pl-1.5 pr-3.5">
                {summary.parity == null ? (
                  <span className="relative inline-flex" aria-label="Parity not measured yet" role="img">
                    <Ring value={0} label={false} />
                    <span className="font-title absolute inset-0 flex items-center justify-center text-[19px] font-bold leading-none text-fg-faint">—</span>
                  </span>
                ) : (
                  <Ring value={summary.parity} color={summary.parity >= 80 ? "#17b26a" : "var(--app-accent)"} />
                )}
                <div>
                  <div className="font-title text-[15px] font-bold">{C.strip.parityTitle}</div>
                  <div className="mt-0.5 text-[12.5px] text-fg-3">
                    {summary.parity == null ? C.strip.parityNone : C.strip.paritySub(summary.full, summary.partial, summary.total)}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-fg-faint">{C.strip.counts(state.domains.length, activeCaps.length, competitors.length)}</div>
                </div>
              </div>
              <StatCard label={C.strip.gaps} tone="#f0b43c" toneFg="#8a5a00" value={summary.measured ? summary.gaps : null} sub={summary.measured ? C.strip.gapsSub(summary.gaps) : C.strip.gapsNone} />
              <StatCard label={C.strip.partial} tone="#3b7cf6" toneFg="#2a5fd0" value={summary.measured ? summary.partial : null} sub={C.strip.partialSub} />
              <StatCard label={C.strip.only(own)} tone="#17b26a" toneFg="#0f7a47" value={summary.measured ? summary.only : null} sub={summary.measured ? C.strip.onlySub(summary.only) : C.strip.onlyNone} />
            </div>

            {/* Filters */}
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <SearchBox value={capQuery} onChange={setCapQuery} placeholder={C.filters.searchCapabilities} />
              <FilterPopover label={C.filters.domain} options={state.domains.map((d) => d.name)} selected={domainFilter} onToggle={toggleIn(setDomainFilter)} emptyText={C.filters.noDomains} />
              <FilterPopover label={C.filters.productLine} options={state.productLines} selected={productFilter} onToggle={toggleIn(setProductFilter)} emptyText={C.filters.noProductLines} />
              <FilterPopover label={C.filters.competitor} accent="customer" options={competitors.map((c) => c.name)} selected={competitorFilter} onToggle={toggleIn(setCompetitorFilter)} emptyText={C.filters.noCompetitors} />
              <FilterPopover single label={C.filters.status} accent="status" options={STATUS_OPTIONS} selected={statusFilter} onToggle={(o) => setStatusFilter((prev) => (prev.includes(o) ? [] : [o]))} />
              <span className="mx-1 h-5 w-px bg-border" />
              <button aria-pressed={gapsOnly} onClick={() => setGapsOnly((v) => !v)} className={chipClass(gapsOnly)}>
                {C.filters.gapsOnly}{gapsOnly && <Check size={12} strokeWidth={3} />}
              </button>
              <button aria-pressed={newChanges} onClick={() => setNewChanges((v) => !v)} className={chipClass(newChanges)}>
                {C.filters.newChanges}{newChanges && <Check size={12} strokeWidth={3} />}
              </button>
            </div>

            {/* Matrix */}
            <div className="glass overflow-visible rounded-card">
              <div className="overflow-x-auto rounded-card">
                <table className="w-full border-collapse text-[13px]" style={{ minWidth: 640 + 104 * shownCompetitors.length }}>
                  <thead>
                    <tr>
                      <th scope="col" className="border-b border-border px-4 pb-[30px] pl-[30px] pt-2.5 text-left align-middle text-[12px] font-semibold tracking-[0.06em] text-fg-muted">
                        {C.matrix.capability}
                      </th>
                      <th scope="col" className="w-[104px] border-b border-t-[3px] border-b-border border-t-primary bg-[rgba(36,87,245,.08)] px-2 pb-2.5 text-center align-bottom">
                        <span className="flex flex-col items-center gap-1.5 pt-2.5">
                          {self ? <Logo c={self} dark /> : <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#0b1430] text-[11px] font-bold text-[#f3f1fb]">{initialsOf(own)}</span>}
                          <span className="max-w-[96px] truncate text-[12px] font-bold" title={own}>{own}</span>
                        </span>
                      </th>
                      {shownCompetitors.map((c) => (
                        <th key={c.id} scope="col" className="w-[104px] border-b border-border px-2 pb-2.5 text-center align-bottom">
                          <button onClick={() => openProfile(c.id, "cell")} className="flex w-full flex-col items-center gap-1.5 pt-[13px] hover:opacity-80" title={c.name}>
                            <Logo c={c} />
                            <span className="max-w-[96px] truncate text-[11.5px] font-medium text-fg-3">{c.name}</span>
                          </button>
                        </th>
                      ))}
                      <th scope="col" className="w-[150px] border-b border-border px-4 py-2.5"><span className="sr-only">{C.matrix.coverage}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeCaps.length === 0 || competitors.length === 0 ? (
                      <tr>
                        <td colSpan={3 + shownCompetitors.length} className="px-10 py-14 text-center">
                          <div className="font-title mb-1 text-[15px] font-bold">{activeCaps.length === 0 ? C.matrix.noCatalogTitle : C.matrix.emptyTitle}</div>
                          <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{activeCaps.length === 0 ? C.matrix.noCatalogBody : C.matrix.emptyBody(own)}</div>
                        </td>
                      </tr>
                    ) : visibleCaps.length === 0 ? (
                      <tr>
                        <td colSpan={3 + shownCompetitors.length} className="px-10 py-10 text-center text-[13px] text-fg-3">No capability matches these filters.</td>
                      </tr>
                    ) : (
                      domainsWithRows.map((d) => {
                        const rows = visibleCaps.filter((k) => k.domainId === d.id);
                        const lines = [...new Set(rows.flatMap((k) => k.productLines))];
                        const covered = rows.filter((k) => cellOf(self?.id, k.id)?.value === "has").length;
                        const partial = rows.filter((k) => cellOf(self?.id, k.id)?.value === "partial").length;
                        const gaps = rows.filter((k) => rowKind(k) === "gap").length;
                        return (
                          <DomainGroup key={d.id} domain={d} rows={rows} lines={lines} covered={covered} partial={partial} gaps={gaps} colSpan={3 + shownCompetitors.length}>
                            {rows.map((k) => {
                              const kind = rowKind(k);
                              const ownCell = cellOf(self?.id, k.id);
                              const haveN = shownCompetitors.filter((c) => cellOf(c.id, k.id)?.value === "has").length;
                              return (
                                <tr key={k.id} className={cn("group h-11 border-b border-border last:border-b-0 hover:bg-[rgba(255,255,255,.7)]", kind === "gap" && "bg-[#fff7e0]", kind === "only" && "bg-[rgba(23,178,106,.08)]")}>
                                  <td className={cn("px-4 pl-[30px] font-medium text-[#1f2f47]", (kind === "gap" || kind === "only") && "font-semibold text-foreground")} title={k.description || undefined}>
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                      {k.name}
                                      {kind === "gap" && <span className="inline-flex items-center rounded-full border border-dashed border-[#f0b43c] bg-[#fff7e0] px-1.5 py-px font-mono text-[9.5px] font-semibold text-[#8a5a00]">Gap</span>}
                                      {kind === "only" && <span className="inline-flex items-center rounded-full bg-[rgba(23,178,106,.14)] px-2 py-px font-mono text-[10px] font-semibold text-[#0f7a47]">{C.strip.only(own)}</span>}
                                    </span>
                                  </td>
                                  <td className={cn("text-center", kind === "gap" ? "bg-[rgba(240,180,60,.18)]" : kind === "only" ? "bg-[rgba(23,178,106,.16)]" : "bg-[rgba(36,87,245,.06)]")}>
                                    {self && <Cell cell={ownCell} competitorId={self.id} capability={k} open={openCell} setOpen={setOpenCell} onPatch={patch} onProfile={null} isNew={isNewChange(ownCell)} />}
                                  </td>
                                  {shownCompetitors.map((c) => {
                                    const cell = cellOf(c.id, k.id);
                                    return (
                                      <td key={c.id} className="text-center">
                                        <Cell cell={cell} competitorId={c.id} capability={k} open={openCell} setOpen={setOpenCell} onPatch={patch} onProfile={() => openProfile(c.id, "cell")} isNew={isNewChange(cell)} notScanned={!c.source?.lastScanAt} />
                                      </td>
                                    );
                                  })}
                                  <td className="px-4">
                                    <span className="flex items-center gap-2">
                                      <span className="inline-flex h-1 w-[54px] overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                                        <span className={cn("block h-full", kind === "gap" ? "bg-[#f0b43c]" : "bg-[#5b6c85]")} style={{ width: `${shownCompetitors.length ? Math.round((haveN / shownCompetitors.length) * 100) : 0}%` }} />
                                      </span>
                                      <span className="font-mono text-[11px] font-semibold text-fg-3">{C.matrix.ofN(haveN, shownCompetitors.length)}</span>
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </DomainGroup>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-[18px] px-1 text-[12px] text-fg-3">
              <span className="inline-flex items-center gap-1.5"><OkMark size={16} />{C.matrix.legendHas}</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block rounded-full bg-[rgba(59,124,246,.15)] px-2 py-px text-[11px] font-semibold text-[#2a5fd0]">{C.matrix.legendPartial}</span>
                {C.matrix.legendPartialSub}
              </span>
              <span className="inline-flex items-center gap-1.5"><span className="font-semibold text-[#5b6c85]">—</span>{C.matrix.legendMissing}</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-[#9aa8be]" />{C.matrix.legendUnknown}</span>
              <span className="ml-auto text-fg-muted">{C.matrix.legendHint}</span>
            </div>
          </section>
        )}

        {tab === "feed" && (
          <section aria-label={C.tabs.feed} className="flex flex-col">
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <SearchBox value={signalQuery} onChange={setSignalQuery} placeholder={C.feed.searchSignals} />
              <FilterPopover label={C.filters.competitor} accent="customer" options={competitors.map((c) => c.name)} selected={feedCompetitor} onToggle={toggleIn(setFeedCompetitor)} emptyText={C.filters.noCompetitors} />
              <FilterPopover label={C.feed.source} accent="platform" options={[]} selected={sourceFilter} onToggle={toggleIn(setSourceFilter)} emptyText="No sources yet" />
              <FilterPopover label={C.feed.impact} accent="status" options={IMPACTS} selected={impactFilter} onToggle={toggleIn(setImpactFilter)} />
              <span className="mx-1 h-5 w-px bg-border" />
              <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} className={chipClass(unreadOnly)}>
                {C.feed.unread}{unreadOnly && <Check size={12} strokeWidth={3} />}
              </button>
              <div className="ml-auto">
                <span title={C.feed.noSignalsToMark} className="inline-flex">
                  <Button size="sm" variant="ghost" disabled><CheckCheck size={13} strokeWidth={2.25} />{C.feed.markAllRead}</Button>
                </span>
              </div>
            </div>
            <EmptyPanel title={C.feed.emptyTitle} body={C.feed.emptyBody} />
          </section>
        )}

        {tab === "profiles" && (
          <ProfilesTab
            competitors={competitors}
            self={self}
            selectedId={selectedCompetitor}
            onSelect={(id) => openProfile(id, "tab")}
            domains={state.domains}
            capabilities={activeCaps}
            cellOf={cellOf}
            facts={state.facts}
            onPatchFact={(id, body) => patch(`/api/competitors/facts/${id}`, body)}
          />
        )}

        {tab === "cards" && (
          <section aria-label={C.tabs.cards} className="flex flex-col">
            <div className="mb-3.5 flex items-center gap-2">
              <span className="text-[12.5px] text-fg-3">{C.cards.count(0)}</span>
              <div className="ml-auto">
                <span title={C.cards.noExport} className="inline-flex">
                  <Button size="sm" disabled><Download size={13} />{C.cards.export}</Button>
                </span>
              </div>
            </div>
            <EmptyPanel title={C.cards.emptyTitle} body={C.cards.emptyBody(own)} />
          </section>
        )}

        {tab === "roadmap" && (
          <section aria-label={C.tabs.roadmap} className="flex flex-col gap-4">
            {([
              { title: C.roadmap.gaps, sub: C.roadmap.gapsSub(own), empty: C.roadmap.gapsEmpty, kind: "gap" as const },
              { title: C.roadmap.partial, sub: C.roadmap.partialSub(own), empty: C.roadmap.partialEmpty, kind: "partial" as const },
            ]).map((g) => {
              const rows = summary.measured ? activeCaps.filter((k) => rowKind(k) === g.kind) : [];
              return (
                <div key={g.title} className="glass overflow-hidden rounded-card">
                  <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                    <span className="text-[14px] font-bold">{g.title}</span>
                    <span className="text-[11px] text-fg-muted">{g.sub} · {rows.length}</span>
                  </div>
                  {rows.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[13px] text-fg-3">{g.empty}</div>
                  ) : (
                    rows.map((k) => {
                      const haveN = competitors.filter((c) => cellOf(c.id, k.id)?.value === "has").length;
                      return (
                        <div key={k.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                          <span className="text-[13.5px] font-semibold">{k.name}</span>
                          <span className="text-[12px] text-fg-muted">{C.matrix.ofN(haveN, competitors.length)} competitors · {state.domains.find((d) => d.id === k.domainId)?.name}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}

// ————— Domain group (collapsible header row + its capability rows) —————

function DomainGroup({ domain, rows, lines, covered, partial, gaps, colSpan, children }: {
  domain: DomainRow; rows: CapabilityRow[]; lines: string[]; covered: number; partial: number; gaps: number; colSpan: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <tr>
        <td colSpan={colSpan} className="p-0">
          <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left" style={{ background: "linear-gradient(90deg, rgba(36,87,245,.14), rgba(255,255,255,0) 60%)" }}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary shadow-[0_0_10px_rgba(36,87,245,.6)]" />
            <span className="text-[14px] font-bold">{domain.name}</span>
            <span className="text-[11px] text-fg-muted">{C.matrix.capabilitiesCount(rows.length)}</span>
            {lines.length > 0 && <span className="text-[11px] text-fg-muted">{lines.join(" · ")}</span>}
            <span className="ml-auto flex items-center gap-[18px] text-[12px] text-fg-3">
              <span><b className="font-bold text-foreground">{covered}</b> {C.matrix.covered}</span>
              {partial > 0 && <span className="font-semibold text-[#2a5fd0]">{C.matrix.partialN(partial)}</span>}
              {gaps > 0 && <span className="font-semibold text-[#8a5a00]">{C.matrix.gapN(gaps)}</span>}
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
        </td>
      </tr>
      {open && children}
    </>
  );
}

// ————— One cell with its evidence / correction popover —————

function Cell({ cell, competitorId, capability, open, setOpen, onPatch, onProfile, isNew, notScanned }: {
  cell: CellRow | undefined;
  competitorId: string;
  capability: CapabilityRow;
  open: { competitorId: string; capabilityId: string } | null;
  setOpen: (v: { competitorId: string; capabilityId: string } | null) => void;
  onPatch: (url: string, body: unknown) => Promise<boolean>;
  onProfile: (() => void) | null;
  isNew: boolean;
  notScanned?: boolean;
}) {
  const isOpen = open?.competitorId === competitorId && open.capabilityId === capability.id;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<StatusValue>(cell?.value ?? "unknown");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setEditing(false);
      setNote("");
    } else {
      setValue(cell?.value ?? "unknown");
      track("cmp_cell_opened", { competitorId, capabilityId: capability.id, value: cell?.value ?? "unknown", hasEvidence: Boolean(cell?.quote), overridden: Boolean(cell?.override) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, setOpen]);

  if (notScanned && !cell) {
    return <span className="text-[11px] text-fg-faint">{C.matrix.notScanned}</span>;
  }

  async function save() {
    if (!cell) return;
    setBusy(true);
    const ok = await onPatch(`/api/competitors/statuses/${cell.id}`, { value, note });
    setBusy(false);
    if (ok) setEditing(false);
  }
  async function reset() {
    if (!cell) return;
    setBusy(true);
    await onPatch(`/api/competitors/statuses/${cell.id}`, { reset: true });
    setBusy(false);
  }

  return (
    <span className="relative inline-flex items-center justify-center">
      <button
        onClick={() => setOpen(isOpen ? null : { competitorId, capabilityId: capability.id })}
        className={cn("relative inline-flex h-9 min-w-[40px] items-center justify-center rounded-[8px] px-1.5 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")}
        aria-label={`${capability.name}: ${C.values[cell?.value ?? "unknown"]}`}
        aria-expanded={isOpen}
      >
        <CellValue cell={cell} />
        {cell?.override && <Pencil size={9} className="absolute right-0.5 top-0.5 text-[#8a5a00]" aria-label={C.matrix.edited} />}
        {isNew && !cell?.override && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-label="Changed in the last scan" />}
      </button>
      {isOpen && cell && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={() => setOpen(null)} />
          <div className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[340px] -translate-x-1/2 rounded-inner border border-border bg-white p-3.5 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]" onKeyDown={(e) => { if (e.key === "Enter" && editing && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); void save(); } }}>
            <div className="mb-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold">{capability.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-muted">
                  <span className="inline-flex items-center gap-1.5"><CellValue cell={cell} size={16} /> {C.values[cell.value]}</span>
                  {cell.changedAt && <span>· {C.matrix.changed(shortDate(cell.changedAt))}</span>}
                  {cell.confidence != null && !cell.override && <span>· {Math.round(cell.confidence * 100)}%</span>}
                </div>
              </div>
              <button onClick={() => setOpen(null)} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label="Close"><X size={14} /></button>
            </div>
            {cell.override && (
              <div className="mb-2 rounded-[8px] border border-[#f0b43c] bg-[#fff7e0] px-2.5 py-1.5 text-[12px] text-[#8a5a00]">
                <div className="font-semibold">{C.matrix.editedBy(cell.override.userName ?? "a PM", shortDate(cell.override.at))}</div>
                {cell.override.note && <div className="mt-0.5">{cell.override.note}</div>}
                <div className="mt-0.5 text-fg-muted">Scan found: {C.values[cell.scannedValue]}</div>
              </div>
            )}
            {!editing && (
              <div className="text-[12.5px] text-fg-2">
                <div className="mb-1 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.cell.evidence}</div>
                {cell.quote ? <blockquote className="border-l-2 border-border pl-2.5 italic leading-relaxed">“{cell.quote}”</blockquote> : <div className="text-fg-faint">{C.cell.noEvidence}</div>}
                {cell.sourceUrl && (
                  <a href={cell.sourceUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
                    <ExternalLink size={11} /> {cell.sourceUrl.replace(/^https?:\/\//, "").slice(0, 60)}
                  </a>
                )}
              </div>
            )}
            {editing && (
              <div className="text-[12.5px]">
                <div className="mb-1 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.cell.setTo}</div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {STATUS_VALUES.map((v) => (
                    <button key={v} onClick={() => setValue(v)} className={cn("rounded-full border px-2.5 py-1 text-[12px] font-semibold", value === v ? "border-transparent bg-primary text-white" : "border-border bg-white text-fg-3 hover:border-primary/55")}>{C.values[v]}</button>
                  ))}
                </div>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={C.cell.notePlaceholder} rows={2}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
                  className="w-full rounded-[8px] border border-border px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary" />
              </div>
            )}
            <div className="mt-2.5 flex items-center gap-1.5">
              {editing ? (
                <>
                  <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>{C.cell.cancel}</Button>
                  <Button size="sm" variant="primary" onClick={save} disabled={busy}>{C.cell.save}</Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={() => setEditing(true)}><Pencil size={12} /> {C.cell.correct}</Button>
                  {cell.override && <Button size="sm" variant="ghost" onClick={reset} disabled={busy} title={C.cell.resetTip}><Undo2 size={12} /> {C.cell.reset}</Button>}
                </>
              )}
              {onProfile && !editing && <Button size="sm" variant="ghost" className="ml-auto" onClick={onProfile}>{C.cell.openProfile}</Button>}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// ————— Profiles tab —————

function ProfilesTab({ competitors, self, selectedId, onSelect, domains, capabilities, cellOf, facts, onPatchFact }: {
  competitors: CompetitorRow[];
  self: CompetitorRow | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  domains: DomainRow[];
  capabilities: CapabilityRow[];
  cellOf: (competitorId: string | null | undefined, capabilityId: string) => CellRow | undefined;
  facts: FactRow[];
  onPatchFact: (id: string, body: unknown) => Promise<boolean>;
}) {
  const selected = competitors.find((c) => c.id === selectedId) ?? competitors[0] ?? null;
  const [editingFact, setEditingFact] = useState<string | null>(null);
  const [factValue, setFactValue] = useState("");

  useEffect(() => {
    if (!selectedId && competitors[0]) onSelect(competitors[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, competitors.length]);

  if (competitors.length === 0) return <EmptyPanel title={C.profile.emptyTitle} body={C.profile.emptyBody} />;
  if (!selected) return null;
  const myFacts = facts.filter((f) => f.competitorId === selected.id);
  const kinds = Object.keys(C.profile.kinds);
  const ahead = capabilities.filter((k) => cellOf(selected.id, k.id)?.value === "has" && cellOf(self?.id, k.id)?.value !== "has").length;
  const behind = capabilities.filter((k) => cellOf(self?.id, k.id)?.value === "has" && cellOf(selected.id, k.id)?.value !== "has").length;

  return (
    <section aria-label={C.tabs.profiles} className="flex gap-4">
      <div className="w-[220px] shrink-0">
        <div className="glass overflow-hidden rounded-card">
          {competitors.map((c) => (
            <button key={c.id} onClick={() => onSelect(c.id)} className={cn("flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-white/70", c.id === selected.id && "bg-white")}>
              <Logo c={c} size={24} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="glass rounded-card p-5">
          <div className="flex items-start gap-4">
            <Logo c={selected} size={44} />
            <div className="min-w-0 flex-1">
              <div className="font-title text-[20px] font-bold">{selected.name}</div>
              <a href={selected.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-primary hover:underline"><ExternalLink size={11} /> {selected.host}</a>
              <div className="mt-1 text-[11.5px] text-fg-muted">
                {selected.source?.lastScanAt ? C.profile.lastScan(timeAgo(selected.source.lastScanAt), 0).replace(" · 0 pages", "") : C.profile.neverScanned}
                {selected.source?.lastStatus === "failed" && selected.source.lastError && <span className="text-[#c23767]"> · {C.settings.failed(C.errors[selected.source.lastError] ?? selected.source.lastError)}</span>}
              </div>
              {myFacts.find((f) => f.kind === "tagline") && <div className="mt-2 text-[13.5px] italic text-fg-2">“{myFacts.find((f) => f.kind === "tagline")!.value}”</div>}
            </div>
            {capabilities.length > 0 && (
              <div className="shrink-0 text-right text-[12px] text-fg-3">
                <div><b className="text-[#c23767]">{ahead}</b> ahead of you</div>
                <div><b className="text-[#0f7a47]">{behind}</b> behind you</div>
              </div>
            )}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] md:grid-cols-3">
            {kinds.filter((k) => k !== "tagline").map((kind) => {
              const rows = myFacts.filter((f) => f.kind === kind);
              return (
                <div key={kind}>
                  <div className="mb-1 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.profile.kinds[kind]}</div>
                  {rows.length === 0 ? (
                    <div className="text-fg-faint">{C.profile.noValue}</div>
                  ) : (
                    <ul className="space-y-0.5">
                      {rows.map((f) => (
                        <li key={f.id} className="group flex items-center gap-1.5">
                          {editingFact === f.id ? (
                            <input autoFocus value={factValue} onChange={(e) => setFactValue(e.target.value)}
                              onKeyDown={async (e) => {
                                if (e.key === "Escape") setEditingFact(null);
                                if (e.key === "Enter") { e.preventDefault(); if (await onPatchFact(f.id, { value: factValue })) setEditingFact(null); }
                              }}
                              className="w-full rounded-[6px] border border-border px-1.5 py-0.5 text-[12.5px] outline-none focus:border-primary" />
                          ) : (
                            <>
                              <span className={cn("min-w-0 truncate", f.override && "text-[#8a5a00]")} title={f.override ? C.matrix.editedBy(f.override.userName ?? "a PM", shortDate(f.override.at)) : f.value}>{f.value}</span>
                              {f.sourceUrl && <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="shrink-0 text-fg-faint hover:text-primary" title={f.sourceUrl}><ExternalLink size={10} /></a>}
                              <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:inline-flex">
                                <button onClick={() => { setEditingFact(f.id); setFactValue(f.value); }} className="rounded p-0.5 text-fg-muted hover:text-foreground" aria-label={C.cell.correct}><Pencil size={10} /></button>
                                {f.override && <button onClick={() => void onPatchFact(f.id, { reset: true })} className="rounded p-0.5 text-fg-muted hover:text-foreground" aria-label={C.cell.reset}><Undo2 size={10} /></button>}
                                <button onClick={() => void onPatchFact(f.id, { dismiss: true })} className="rounded p-0.5 text-fg-muted hover:text-[#c23767]" aria-label={C.profile.remove}><X size={10} /></button>
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass overflow-hidden rounded-card">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <span className="text-[14px] font-bold">{C.profile.capabilities}</span>
            <span className="text-[11px] text-fg-muted">{C.strip.counts(domains.length, capabilities.length, 1).replace(" · 1 competitors", "")}</span>
          </div>
          {capabilities.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-fg-3">{C.matrix.noCatalogTitle}</div>}
          {domains.map((d) => {
            const rows = capabilities.filter((k) => k.domainId === d.id);
            if (rows.length === 0) return null;
            return (
              <div key={d.id}>
                <div className="border-b border-border bg-[rgba(36,87,245,.05)] px-4 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.04em] text-fg-muted">{d.name}</div>
                {rows.map((k) => {
                  const cell = cellOf(selected.id, k.id);
                  const ownCell = cellOf(self?.id, k.id);
                  return (
                    <div key={k.id} className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                      <span className="w-6 shrink-0 pt-0.5 text-center"><CellValue cell={cell} size={18} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                          {k.name}
                          {ownCell && cell && ownCell.value !== cell.value && (
                            <span className={cn("rounded-full px-2 py-px font-mono text-[10px] font-semibold", cell.value === "has" && ownCell.value !== "has" ? "bg-[#fff7e0] text-[#8a5a00]" : "bg-[rgba(23,178,106,.14)] text-[#0f7a47]")}>
                              you: {C.values[ownCell.value]}
                            </span>
                          )}
                          {cell?.changedAt && <span className="font-mono text-[10px] font-normal text-fg-muted">{C.matrix.changed(shortDate(cell.changedAt))}</span>}
                        </div>
                        {cell?.quote && <div className="mt-0.5 text-[12.5px] italic text-fg-3">“{cell.quote}”{cell.sourceUrl && <> <a href={cell.sourceUrl} target="_blank" rel="noreferrer" className="not-italic text-primary hover:underline">source</a></>}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
