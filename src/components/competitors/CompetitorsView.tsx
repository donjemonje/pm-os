"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronDown, ChevronRight, Download, ExternalLink, Info, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { Ring } from "@/components/ui/Ring";
import { ProfilePanel } from "./ProfilePanel";
import { initialsOf } from "@/components/ui/Avatar";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { FACT_KINDS, OWN_STATUS_VALUES, STATUS_VALUES, splitSuggestedQuote, type OwnStatus, type StatusValue } from "@/lib/competitors/config";
import type { FeedItem } from "@/lib/competitors/feed";
import { rankByCloseness } from "@/lib/competitors/closeness";
import type { CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow, FactRow } from "@/lib/competitors/store";
import { shortDate, timeAgo } from "@/lib/competitors/time";
import { PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
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

/** The strip's last card (C2 "Risk" slot): competitors ranked by how much of the org's capability list they cover. */
function ClosestCard({ org, ranked, measured, onOpen }: { org: string; ranked: ReturnType<typeof rankByCloseness<CompetitorRow>>; measured: boolean; onOpen: (competitorId: string) => void }) {
  const tone = (score: number | null) => (score == null ? ["#9aa8be", "#5b6c85"] : score >= 70 ? ["#c23767", "#c23767"] : score >= 50 ? ["#f0b43c", "#8a5a00"] : ["#17b26a", "#0f7a47"]);
  return (
    <div className="flex flex-[1_1_300px] flex-col gap-1.5 rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3" data-testid="cmp-closest-card">
      <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted" title={C.strip.closestSub(org)}>{C.strip.closest}</span>
      {!measured || ranked.length === 0 ? (
        <span className="text-[12px] text-fg-faint">{C.strip.closestNone}</span>
      ) : (
        <ol className="m-0 grid list-none grid-cols-1 gap-x-[18px] gap-y-1 p-0 text-[12px] sm:grid-cols-2">
          {ranked.map(({ competitor: c, closeness }) => {
            const [bar, fg] = tone(closeness.score);
            return (
              <li key={c.id}>
                <button type="button" onClick={() => onOpen(c.id)} className="flex w-full items-center gap-2 rounded-[6px] text-left hover:bg-white" title={`${c.name} · ${C.strip.closestScore(closeness.has, closeness.partial, closeness.total)}`}>
                  <Logo c={c} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[#1f2f47]">{c.name}</span>
                  <span className="inline-flex h-1 w-[54px] shrink-0 overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                    <span className="block h-full" style={{ width: `${closeness.score ?? 0}%`, background: bar }} />
                  </span>
                  <span className="w-[22px] shrink-0 text-right text-[10.5px] font-semibold" style={{ color: fg }}>{closeness.score ?? "—"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
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
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] border text-[11px] font-bold", dark ? "border-[#0b1430] bg-[#0b1430] text-[#f3f1fb]" : "border-border bg-white text-fg-2")}
      style={{ width: size, height: size }}
      title={c.name}
    >
      {c.logoUrl && !broken ? <img src={c.logoUrl} alt="" onError={() => setBroken(true)} className="h-[70%] w-[70%] object-contain" /> : initialsOf(c.name)}
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
export function CompetitorsView({ initialState, canEdit = false }: { initialState: CompetitorsState; canEdit?: boolean }) {
  const [state, setState] = useState(initialState);
  const own = state.orgName.trim() || "Your organization";
  const [tab, setTab] = useState<Tab>("parity");
  const [selectedCompetitor, setSelectedCompetitor] = useState<string | null>(null);
  const [openCell, setOpenCell] = useState<{ competitorId: string; capabilityId: string } | null>(null);
  // Capability whose description row is open under it (click on the name cell).
  const [openDesc, setOpenDesc] = useState<string | null>(null);
  const toggleDesc = useCallback((capabilityId: string) => {
    setOpenDesc((cur) => {
      const next = cur === capabilityId ? null : capabilityId;
      if (next) track("cmp_capability_description_opened", { capabilityId });
      return next;
    });
  }, []);
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

  // ——— Scan (every competitor, one notification) ———
  const [runNote, setRunNote] = useState<string | null>(null);
  const watchedRun = useRef<string | null>(null);
  useEffect(() => {
    if (state.activeRun) {
      watchedRun.current = state.activeRun.id;
      return;
    }
    if (watchedRun.current && state.lastRun?.id === watchedRun.current) {
      watchedRun.current = null;
      const s = state.lastRun.summary;
      const changed = typeof s.competitors === "number" ? s.competitors : 0;
      const recipients = typeof s.recipients === "number" ? s.recipients : 0;
      setRunNote(`${C.run.finished(changed)}${changed > 0 ? ` ${recipients > 0 ? C.run.notified(recipients) : C.run.noRecipients}` : ""}`);
    }
  }, [state.activeRun, state.lastRun]);

  async function scanAll() {
    setError(null);
    setRunNote(null);
    const res = await fetch("/api/competitors/scan/run", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? C.run.failedToStart);
      return;
    }
    if (data.state) setState(data.state);
    track("cmp_run_clicked", { competitors: state.competitors.length });
  }

  // ——— Derived data ———
  const competitors = state.competitors;
  const activeCaps = useMemo(() => state.capabilities.filter((k) => k.state === "active"), [state.capabilities]);
  // Scan suggestions wait in the matrix itself (dashed rows / a dashed domain group) for a PM's ✓ or ×.
  const suggestedCaps = useMemo(() => state.capabilities.filter((k) => k.state === "suggested"), [state.capabilities]);
  const activeDomains = state.domains.filter((d) => d.state === "active");
  const [suggestionsOnly, setSuggestionsOnly] = useState(false);
  const decideCapability = (id: string, decision: "active" | "dismissed") => patch(`/api/competitors/capabilities/${id}`, { state: decision });
  const decideDomain = (id: string, decision: "active" | "dismissed") => patch(`/api/competitors/domains/${id}`, { state: decision });
  const cellMap = useMemo(() => {
    const m = new Map<string, CellRow>();
    for (const c of state.cells) m.set(`${c.competitorId}|${c.capabilityId}`, c);
    return m;
  }, [state.cells]);
  const cellOf = (competitorId: string | null | undefined, capabilityId: string) => (competitorId ? cellMap.get(`${competitorId}|${capabilityId}`) : undefined);
  /** The org's own cell is the capability's ourStatus — set by PMs, never scanned. */
  const ownOf = (k: CapabilityRow): StatusValue => k.ourStatus;
  const lastScanOf = new Map(state.competitors.map((c) => [c.id, c.source?.lastScanAt ? new Date(c.source.lastScanAt).getTime() : null]));
  const isNewChange = (cell: CellRow | undefined) => {
    if (!cell?.changedAt) return false;
    const last = lastScanOf.get(cell.competitorId);
    if (!last) return false;
    return new Date(cell.changedAt).getTime() >= last - NEW_CHANGE_WINDOW_MS;
  };
  /** Gap = own missing while any competitor has it; only-us = own has while no competitor has/partial. */
  const rowKind = (k: CapabilityRow): "gap" | "partial" | "only" | "level" | "none" => {
    const theirs = competitors.map((c) => cellOf(c.id, k.id)?.value ?? "unknown");
    const anyHas = theirs.some((v) => v === "has");
    const anyHasOrPartial = theirs.some((v) => v === "has" || v === "partial");
    const ownV = ownOf(k);
    if (competitors.length === 0) return "none";
    if (ownV === "has" && !anyHasOrPartial) return "only";
    if (ownV === "missing" && anyHas) return "gap";
    if (ownV === "partial" && anyHas) return "partial";
    return "level";
  };

  const summary = useMemo(() => {
    const total = activeCaps.length;
    let full = 0, partial = 0, gaps = 0, only = 0;
    for (const k of activeCaps) {
      const kind = rowKind(k);
      const ownV = ownOf(k);
      if (ownV === "has") full++;
      else if (ownV === "partial") partial++;
      if (kind === "gap") gaps++;
      if (kind === "only") only++;
    }
    const measured = competitors.length > 0 && total > 0 && state.cells.length > 0;
    return { total, full, partial, gaps, only, measured, parity: measured ? Math.round(((full + partial * 0.5) / total) * 100) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCaps, state.cells, competitors.length]);

  const closest = useMemo(
    () => rankByCloseness(competitors, activeCaps.map((k) => k.id), (competitorId, capabilityId) => cellOf(competitorId, capabilityId)?.value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [competitors, activeCaps, state.cells],
  );

  const shownCompetitors = competitors.filter((c) => competitorFilter.length === 0 || competitorFilter.includes(c.name));
  const q = capQuery.trim().toLowerCase();
  const matchesStatus = (k: CapabilityRow) => {
    if (statusFilter.length === 0) return true;
    const wanted = STATUS_VALUES[STATUS_OPTIONS.indexOf(statusFilter[0])];
    return shownCompetitors.some((c) => (cellOf(c.id, k.id)?.value ?? "unknown") === wanted);
  };
  const visibleCaps = suggestionsOnly ? [] : activeCaps.filter((k) => {
    if (q && !k.name.toLowerCase().includes(q) && !k.description.toLowerCase().includes(q)) return false;
    if (domainFilter.length && !domainFilter.includes(state.domains.find((d) => d.id === k.domainId)?.name ?? "")) return false;
    if (productFilter.length && !k.productLines.some((p) => productFilter.includes(p))) return false;
    if (gapsOnly && rowKind(k) !== "gap" && rowKind(k) !== "partial") return false;
    if (newChanges && !shownCompetitors.some((c) => isNewChange(cellOf(c.id, k.id)))) return false;
    return matchesStatus(k);
  });
  // Suggested rows follow the search, domain and competitor filters; status/gap/product-line filters do not apply to them.
  const visibleSuggested = gapsOnly || newChanges || productFilter.length || statusFilter.length ? [] : suggestedCaps.filter((k) => {
    if (q && !k.name.toLowerCase().includes(q)) return false;
    if (domainFilter.length && !domainFilter.includes(state.domains.find((d) => d.id === k.domainId)?.name ?? "")) return false;
    if (competitorFilter.length && !shownCompetitors.some((c) => c.id === k.suggestedById)) return false;
    return true;
  });
  const domainsWithRows = state.domains.filter((d) => d.state !== "dismissed" && (visibleCaps.some((k) => k.domainId === d.id) || visibleSuggested.some((k) => k.domainId === d.id)));
  const competitorName = (id: string | null) => competitors.find((c) => c.id === id)?.name ?? "";

  // ——— News feed: items since the baseline, grouped by day, per-user read marks ———
  const feedSources = [...new Set(state.feed.map((i) => i.sourceType).filter((s): s is string => Boolean(s)))].map((s) => C.profile.sourceTypes[s] ?? s);
  const unreadCount = state.feed.filter((i) => !i.read).length;
  const fq = signalQuery.trim().toLowerCase();
  const visibleFeed = state.feed.filter((i) => {
    if (fq && !i.title.toLowerCase().includes(fq) && !(i.quote ?? "").toLowerCase().includes(fq) && !i.competitorName.toLowerCase().includes(fq)) return false;
    if (feedCompetitor.length && !feedCompetitor.includes(i.competitorName)) return false;
    if (sourceFilter.length && !sourceFilter.includes(i.sourceType ? C.profile.sourceTypes[i.sourceType] ?? i.sourceType : "")) return false;
    if (impactFilter.length && !impactFilter.includes(i.impact)) return false;
    if (unreadOnly && i.read) return false;
    return true;
  });
  const feedGroups = (() => {
    const now = new Date();
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const today = dayKey(now);
    const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
    const weekAgo = now.getTime() - 7 * 86_400_000;
    const groups: { key: string; items: FeedItem[] }[] = [{ key: "today", items: [] }, { key: "yesterday", items: [] }, { key: "week", items: [] }, { key: "earlier", items: [] }];
    for (const i of visibleFeed) {
      const d = new Date(i.at);
      const k = dayKey(d);
      const g = k === today ? 0 : k === yesterday ? 1 : d.getTime() >= weekAgo ? 2 : 3;
      groups[g].items.push(i);
    }
    return groups.filter((g) => g.items.length > 0);
  })();
  const [feedOpen, setFeedOpen] = useState<string | null>(null);
  /** The "For <org>" line — derived from the data, no AI: what the item means against the org's own status. */
  const feedMeaning = (i: FeedItem): string => {
    if (i.kind === "gap" && i.capabilityId) {
      const n = competitors.filter((c) => cellOf(c.id, i.capabilityId!)?.value === "has").length;
      return C.feed.meaning.gap(own, i.competitorName, n, competitors.length);
    }
    if (i.kind === "raised" || i.kind === "lowered") return C.feed.meaning[i.kind](own, i.competitorName, C.values[i.own ?? "unknown"].toLowerCase());
    if (i.kind === "fact") return C.feed.meaning.fact(i.competitorName, C.notify.email.factKinds[i.factKind ?? ""] ?? i.factKind ?? "");
    return C.feed.meaning.suggestion((C.feed.suggestionStates[i.suggestionState ?? ""] ?? "").toLowerCase());
  };
  async function markRead(keys: string[]) {
    if (keys.length === 0) return;
    const res = await fetch("/api/competitors/feed/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    const data = await res.json();
    if (res.ok && data.state) setState(data.state);
  }

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
  /** POST without a body: a create action whose answer is the new state. */
  async function post(url: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? C.cell.saveFailed);
      if (data.state) setState(data.state);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : C.cell.saveFailed);
      return false;
    }
  }

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
    track("cmp_profile_viewed", { competitorId, factsShown: facts.length, factsMissing: FACT_KINDS.length - new Set(facts.map((f) => f.kind)).size, from });
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
            <span className="ml-auto flex items-center gap-3">
              {runNote && <span className="text-[12px] font-medium text-fg-3" data-testid="cmp-run-note">{runNote}</span>}
              {state.activeRun ? (
                <span className="inline-flex h-8 items-center gap-2 rounded-control border border-border bg-[var(--app-glass)] px-3 text-[12.5px] font-semibold text-fg-3" data-testid="cmp-run-progress">
                  <Loader2 size={14} className="animate-spin" />
                  {C.run.running(state.activeRun.done, state.activeRun.total, state.activeRun.current)}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void scanAll()}
                  disabled={state.scanning || competitors.length === 0}
                  title={C.run.buttonTitle}
                  data-testid="cmp-run-button"
                  className="font-title inline-flex h-8 items-center gap-1.5 rounded-control border border-transparent bg-primary px-3.5 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(36,87,245,.8)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={14} />
                  {C.run.button}
                </button>
              )}
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
                  <div className="mt-1 font-mono text-[10.5px] text-fg-faint">{C.strip.counts(activeDomains.length, activeCaps.length, competitors.length)}{suggestedCaps.length > 0 && ` · ${C.matrix.suggestedN(suggestedCaps.length)}`}</div>
                </div>
              </div>
              <StatCard label={C.strip.gaps} tone="#f0b43c" toneFg="#8a5a00" value={summary.measured ? summary.gaps : null} sub={summary.measured ? C.strip.gapsSub(summary.gaps) : C.strip.gapsNone} />
              <StatCard label={C.strip.partial} tone="#3b7cf6" toneFg="#2a5fd0" value={summary.measured ? summary.partial : null} sub={C.strip.partialSub} />
              <StatCard label={C.strip.only(own)} tone="#17b26a" toneFg="#0f7a47" value={summary.measured ? summary.only : null} sub={summary.measured ? C.strip.onlySub(summary.only) : C.strip.onlyNone} />
              <ClosestCard org={own} ranked={closest} measured={summary.measured} onOpen={(id) => openProfile(id, "cell")} />
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
              {suggestedCaps.length > 0 && (
                <button aria-pressed={suggestionsOnly} onClick={() => setSuggestionsOnly((v) => !v)} className={cn(chipClass(suggestionsOnly), !suggestionsOnly && "border-dashed")} data-testid="cmp-suggestions-chip">
                  {C.matrix.suggestionsOnly}
                  <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold", suggestionsOnly ? "bg-white/25 text-white" : "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]")}>{suggestedCaps.length}</span>
                </button>
              )}
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
                          <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#0b1430] text-[11px] font-bold text-[#f3f1fb]">{initialsOf(own)}</span>
                          <span className="max-w-[96px] truncate text-[12px] font-bold" title={own}>{own}</span>
                        </span>
                      </th>
                      {shownCompetitors.map((c) => (
                        <th key={c.id} scope="col" className="w-[104px] border-b border-border px-2 pb-2.5 text-center align-bottom">
                          <button onClick={() => openProfile(c.id, "cell")} className="flex w-full flex-col items-center gap-1.5 pt-[13px] hover:opacity-80" title={c.lastScan?.badge === "blocked" || c.lastScan?.badge === "unreachable" ? `${c.name} — ${C.settings.badges[c.lastScan.badge]}${c.lastGoodScanAt ? `. ${C.settings.showingDataFrom(shortDate(c.lastGoodScanAt))}` : ""}` : c.name}>
                            <Logo c={c} />
                            <span className="max-w-[96px] truncate text-[11.5px] font-medium text-fg-3">{c.name}</span>
                            {(c.lastScan?.badge === "blocked" || c.lastScan?.badge === "unreachable") && (
                              <span className="rounded-full bg-[rgba(239,90,138,.15)] px-1.5 py-px font-mono text-[9px] font-semibold text-[#c23767]">{C.settings.badges[c.lastScan.badge]}{c.lastGoodScanAt ? ` · ${shortDate(c.lastGoodScanAt)}` : ""}</span>
                            )}
                          </button>
                        </th>
                      ))}
                      <th scope="col" className="w-[150px] border-b border-border px-4 py-2.5"><span className="sr-only">{C.matrix.coverage}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activeCaps.length === 0 && suggestedCaps.length === 0) || competitors.length === 0 ? (
                      <tr>
                        <td colSpan={3 + shownCompetitors.length} className="px-10 py-14 text-center">
                          <div className="font-title mb-1 text-[15px] font-bold">{activeCaps.length === 0 ? C.matrix.noCatalogTitle : C.matrix.emptyTitle}</div>
                          <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{activeCaps.length === 0 ? C.matrix.noCatalogBody : C.matrix.emptyBody(own)}</div>
                        </td>
                      </tr>
                    ) : visibleCaps.length === 0 && visibleSuggested.length === 0 ? (
                      <tr>
                        <td colSpan={3 + shownCompetitors.length} className="px-10 py-10 text-center text-[13px] text-fg-3">No capability matches these filters.</td>
                      </tr>
                    ) : (
                      domainsWithRows.map((d) => {
                        const rows = visibleCaps.filter((k) => k.domainId === d.id);
                        const sugRows = visibleSuggested.filter((k) => k.domainId === d.id);
                        const lines = [...new Set(rows.flatMap((k) => k.productLines))];
                        const covered = rows.filter((k) => ownOf(k) === "has").length;
                        const partial = rows.filter((k) => ownOf(k) === "partial").length;
                        const gaps = rows.filter((k) => rowKind(k) === "gap").length;
                        return (
                          <DomainGroup key={d.id} domain={d} rows={rows} lines={lines} covered={covered} partial={partial} gaps={gaps} colSpan={3 + shownCompetitors.length}
                            suggestedBy={d.state === "suggested" ? competitorName(d.suggestedById) : null} suggestedCount={sugRows.length} canEdit={canEdit} onDecide={(decision) => void decideDomain(d.id, decision)}
                            suggestedRows={sugRows.map((k) => (
                              <SuggestedRow key={k.id} capability={k} org={own} seenAt={competitorName(k.suggestedById)} competitors={shownCompetitors} canEdit={canEdit} onDecide={(decision) => void decideCapability(k.id, decision)} descOpen={openDesc === k.id} onToggleDesc={() => toggleDesc(k.id)} />
                            ))}>
                            {rows.map((k) => {
                              const kind = rowKind(k);
                              const haveN = shownCompetitors.filter((c) => cellOf(c.id, k.id)?.value === "has").length;
                              const descOpen = openDesc === k.id;
                              return (
                                <tr key={k.id} className={cn("group h-11 border-b border-border last:border-b-0 hover:bg-[rgba(255,255,255,.7)]", kind === "gap" && "bg-[#fff7e0]", kind === "only" && "bg-[rgba(23,178,106,.08)]")}>
                                  <td className={cn("px-4 pl-[30px] font-medium text-[#1f2f47]", (kind === "gap" || kind === "only") && "font-semibold text-foreground")}>
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                      {k.name}
                                      <DescriptionInfo name={k.name} description={k.description} ownProduct={k.ownProduct} org={own} open={descOpen} onToggle={() => toggleDesc(k.id)} />
                                      {kind === "gap" && <span className="inline-flex items-center rounded-full border border-dashed border-[#f0b43c] bg-[#fff7e0] px-1.5 py-px font-mono text-[9.5px] font-semibold text-[#8a5a00]">Gap</span>}
                                      {kind === "only" && <span className="inline-flex items-center rounded-full bg-[rgba(23,178,106,.14)] px-2 py-px font-mono text-[10px] font-semibold text-[#0f7a47]">{C.strip.only(own)}</span>}
                                    </span>
                                  </td>
                                  <td className={cn("text-center", kind === "gap" ? "bg-[rgba(240,180,60,.18)]" : kind === "only" ? "bg-[rgba(23,178,106,.16)]" : "bg-[rgba(36,87,245,.06)]")}>
                                    <span className="inline-flex max-w-[100px] items-center justify-center gap-1">
                                      <OwnCell capability={k} org={own} open={openCell} setOpen={setOpenCell} onPatch={patch} />
                                    </span>
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
              {suggestedCaps.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-[3px] border border-dashed border-[rgba(36,87,245,.6)] bg-[rgba(36,87,245,.06)]" />{C.matrix.legendSuggested}</span>}
              <span className="ml-auto text-fg-muted">{C.matrix.legendHint}</span>
            </div>
          </section>
        )}

        {tab === "feed" && (
          <section aria-label={C.tabs.feed} className="flex flex-col">
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <SearchBox value={signalQuery} onChange={setSignalQuery} placeholder={C.feed.searchSignals} />
              <FilterPopover label={C.filters.competitor} accent="customer" options={competitors.map((c) => c.name)} selected={feedCompetitor} onToggle={toggleIn(setFeedCompetitor)} emptyText={C.filters.noCompetitors} />
              <FilterPopover label={C.feed.source} accent="platform" options={feedSources} selected={sourceFilter} onToggle={toggleIn(setSourceFilter)} emptyText="No sources yet" />
              <FilterPopover label={C.feed.impact} accent="status" options={IMPACTS} selected={impactFilter} onToggle={toggleIn(setImpactFilter)} />
              <span className="mx-1 h-5 w-px bg-border" />
              <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} className={chipClass(unreadOnly)}>
                {C.feed.unread}{unreadOnly && <Check size={12} strokeWidth={3} />}
                {unreadCount > 0 && <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold", unreadOnly ? "bg-white/25 text-white" : "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]")}>{unreadCount}</span>}
              </button>
              <div className="ml-auto">
                <span title={unreadCount === 0 ? C.feed.noSignalsToMark : undefined} className="inline-flex">
                  <Button size="sm" variant="ghost" disabled={unreadCount === 0} onClick={() => void markRead(state.feed.filter((i) => !i.read).map((i) => i.key))} data-testid="cmp-feed-mark-all"><CheckCheck size={13} strokeWidth={2.25} />{C.feed.markAllRead}</Button>
                </span>
              </div>
            </div>
            {state.config.baselineUntil && <div className="mb-3 text-[12px] text-fg-muted">{C.feed.since(shortDate(state.config.baselineUntil))}</div>}
            {state.feed.length === 0 ? (
              <EmptyPanel title={C.feed.emptyTitle} body={C.feed.emptyBody} />
            ) : visibleFeed.length === 0 ? (
              <div className="glass rounded-card px-10 py-10 text-center text-[13px] text-fg-3">{C.feed.noMatch}</div>
            ) : (
              <div className="flex flex-col gap-3.5" data-testid="cmp-feed">
                {feedGroups.map((g, gi) => {
                  const high = g.items.filter((i) => i.impact === "High").length;
                  const allRead = g.items.every((i) => i.read);
                  const first = new Date(g.items[0].at);
                  const label = g.key === "today" || g.key === "yesterday" ? `${C.feed.groups[g.key]} · ${first.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}` : C.feed.groups[g.key];
                  const accent = gi === 0 && g.key === "today" ? "#2457f5" : "#5b6c85";
                  return (
                    <section key={g.key} className="glass rounded-card">
                      <div className="flex items-center gap-3 border-b border-[rgba(200,212,232,.5)] px-4 py-2.5" style={{ background: `linear-gradient(90deg, ${accent === "#2457f5" ? "rgba(36,87,245,.14)" : "rgba(91,108,133,.14)"}, rgba(255,255,255,0) 60%)` }}>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: accent, boxShadow: `0 0 10px ${accent}99` }} />
                        <span className="text-[14px] font-bold">{label}</span>
                        <span className="text-[11px] text-fg-muted">{C.feed.signals(g.items.length)}</span>
                        <span className="ml-auto flex items-center gap-[18px] text-[12px] text-fg-3">
                          {allRead ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-[#0f7a47]"><Check size={12} strokeWidth={3} />{C.feed.allRead}</span>
                          ) : high > 0 ? (
                            <span className="font-semibold text-[#c23767]">{C.feed.highImpact(high)}</span>
                          ) : null}
                        </span>
                      </div>
                      {g.items.map((item) => {
                        const isOpen = feedOpen === item.key;
                        return (
                          <div key={item.key} className={cn(isOpen && "bg-[rgba(36,87,245,.035)]")}>
                            <FeedRow item={item} org={own} competitor={competitors.find((c) => c.id === item.competitorId) ?? null} open={isOpen}
                              meaning={feedMeaning(item)} onOpen={() => { setFeedOpen(isOpen ? null : item.key); if (!item.read) void markRead([item.key]); }} />
                            {isOpen && (
                              <FeedDetail item={item} org={own} meaning={feedMeaning(item)} canEdit={canEdit}
                                onOpenCell={item.capabilityId && item.kind !== "suggestion" ? () => { setTab("parity"); setOpenCell({ competitorId: item.competitorId, capabilityId: item.capabilityId! }); } : null}
                                onDecide={item.kind === "suggestion" && item.suggestionState === "suggested" && item.capabilityId ? (decision) => { void decideCapability(item.capabilityId!, decision); } : null} />
                            )}
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {tab === "profiles" && (
          <ProfilePanel
            org={own}
            competitors={competitors}
            selectedId={selectedCompetitor}
            onSelect={(id) => openProfile(id, "tab")}
            domains={activeDomains}
            capabilities={activeCaps}
            cellOf={cellOf}
            facts={state.facts}
            onPatchFact={(id, body) => patch(`/api/competitors/facts/${id}`, body)}
            onPatchStatus={(id, body) => patch(`/api/competitors/statuses/${id}`, body)}
            onAddFact={async (competitorId, kind, value) => {
              setError(null);
              const res = await fetch("/api/competitors/facts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ competitorId, kind, value }) });
              const data = await res.json();
              if (!res.ok) { setError(data.error ?? C.errors.generic); return false; }
              if (data.state) setState(data.state);
              return true;
            }}
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

        {tab === "roadmap" && (() => {
          const gapRows = summary.measured ? activeCaps.filter((k) => rowKind(k) === "gap") : [];
          const partialRows = summary.measured ? activeCaps.filter((k) => rowKind(k) === "partial") : [];
          const total = gapRows.length + partialRows.length;
          const sections = [
            { key: "gap", title: C.roadmap.gaps, sub: C.roadmap.gapsSub(own), empty: C.roadmap.gapsEmpty, rows: gapRows, color: "#f0b43c", glow: "rgba(240,180,60,.6)", gradient: "linear-gradient(90deg, rgba(240,180,60,.18), rgba(255,255,255,0) 60%)" },
            { key: "partial", title: C.roadmap.partial, sub: C.roadmap.partialSub(own), empty: C.roadmap.partialEmpty, rows: partialRows, color: "#3b7cf6", glow: "rgba(59,124,246,.6)", gradient: "linear-gradient(90deg, rgba(59,124,246,.16), rgba(255,255,255,0) 60%)" },
          ];
          return (
            <section aria-label={C.tabs.roadmap} className="flex flex-col gap-4">
              <div className="flex items-center gap-2.5 rounded-inner border border-border bg-[rgba(36,87,245,.08)] px-3.5 py-2.5 text-[13px] text-foreground" data-testid="cmp-roadmap-intro">
                <Sparkles size={16} className="shrink-0 text-primary" />
                {total > 0 ? <span><b className="font-semibold">{C.roadmap.intro(total)}</b> {C.roadmap.introSub}</span> : <span>{C.roadmap.introNone}</span>}
              </div>
              {sections.map((g) => {
                const notInJira = g.rows.filter((k) => !k.ideas.some((i) => i.jiraKey)).length;
                return (
                  <div key={g.key} className="glass overflow-hidden rounded-card" data-testid={`cmp-roadmap-${g.key}`}>
                    <div className="flex items-center gap-3 border-b border-[rgba(200,212,232,.5)] px-4 py-2.5" style={{ background: g.gradient }}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: g.color, boxShadow: `0 0 10px ${g.glow}` }} />
                      <span className="text-[14px] font-bold">{g.title}</span>
                      <span className="text-[11px] text-fg-muted">{g.sub} · {g.rows.length}</span>
                      {notInJira > 0 && <span className="ml-auto text-[12px] font-semibold text-[#c98a00]">{C.roadmap.notInJira(notInJira)}</span>}
                    </div>
                    {g.rows.length === 0 ? (
                      <div className="px-4 py-8 text-center text-[13px] text-fg-3">{g.empty}</div>
                    ) : (
                      g.rows.map((k) => (
                        <RoadmapRow key={k.id} capability={k} kind={g.key as "gap" | "partial"} competitors={competitors} cellOf={cellOf} domain={state.domains.find((d) => d.id === k.domainId)?.name ?? ""} onCreateIdea={() => post(`/api/competitors/capabilities/${k.id}/idea`)} />
                      ))
                    )}
                  </div>
                );
              })}
            </section>
          );
        })()}
      </div>
    </div>
  );
}

// ————— Roadmap row (design C2): name, evidence line, Jira / idea pill, Create idea, Evidence · N —————

function RoadmapRow({ capability: k, kind, competitors, cellOf, domain, onCreateIdea }: {
  capability: CapabilityRow;
  kind: "gap" | "partial";
  competitors: CompetitorRow[];
  cellOf: (competitorId: string, capabilityId: string) => CellRow | undefined;
  domain: string;
  onCreateIdea: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const withIt = competitors
    .map((c) => ({ c, cell: cellOf(c.id, k.id) }))
    .filter(({ cell }) => cell && (cell.value === "has" || cell.value === "partial"));
  const full = withIt.filter(({ cell }) => cell?.value === "has").length;
  const names = withIt.map(({ c }) => c.name);
  const headline = kind === "gap" ? C.roadmap.haveIt(withIt.length, competitors.length) : C.roadmap.haveItFull(full, competitors.length);
  const sub = [headline, names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`, domain].filter(Boolean).join(" · ");
  const evidence = withIt.filter(({ cell }) => cell?.quote || cell?.sourceUrl);
  const toggle = () => {
    setOpen((v) => !v);
    if (!open) track("cmp_roadmap_evidence_opened", { capabilityId: k.id, kind, count: evidence.length });
  };
  async function create() {
    setBusy(true);
    await onCreateIdea();
    setBusy(false);
  }
  return (
    <div className="border-b border-[rgba(200,212,232,.5)] last:border-b-0" data-testid="cmp-roadmap-row">
      <div className="flex flex-wrap items-center gap-3.5 px-4 py-2.5">
        <span className="flex min-w-[260px] flex-1 flex-col gap-[3px]">
          <span className="text-[13.5px] font-semibold">{k.name}</span>
          <span className="text-[11.5px] text-fg-muted">{sub}</span>
        </span>
        {k.ideas.length === 0 ? (
          <span className="inline-flex items-center whitespace-nowrap rounded-full border border-dashed border-[#f0b43c] bg-[#fff7e0] px-2 py-px text-[11px] font-semibold text-[#8a5a00]">{C.roadmap.notInJiraTag}</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {k.ideas.map((i) => (
              <a key={i.id} href="/ideas" title={i.title} onClick={() => track("cmp_roadmap_idea_opened", { capabilityId: k.id, ideaId: i.id, via: "pill" })} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[rgba(59,124,246,.55)] bg-[rgba(59,124,246,.15)] px-2 py-px text-[11px] font-semibold text-[#2a5fd0] hover:underline" data-testid={i.jiraKey ? "cmp-roadmap-jira" : "cmp-roadmap-idea"}>
                {i.jiraKey ? `${i.jiraKey}${i.jiraStatus ? ` · ${i.jiraStatus}` : ""}` : C.roadmap.ideaTag(i.batchStatus)}
              </a>
            ))}
          </span>
        )}
        <span className="flex gap-2">
          {k.ideas.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => { track("cmp_roadmap_idea_opened", { capabilityId: k.id, ideaId: k.ideas[0].id, via: "button" }); window.location.assign("/ideas"); }}>{k.ideas.length === 1 ? C.roadmap.openIdea : C.roadmap.openIdeas(k.ideas.length)}</Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void create()} disabled={busy} data-testid="cmp-roadmap-create-idea">{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={2.25} />}{busy ? C.roadmap.creating : C.roadmap.createIdea}</Button>
          )}
          <Button size="sm" variant={k.ideas.length > 0 ? "ghost" : "secondary"} onClick={toggle} aria-expanded={open} data-testid="cmp-roadmap-evidence">{C.roadmap.evidenceN(evidence.length)}</Button>
        </span>
      </div>
      {open && (
        <div className="border-t border-dashed border-[rgba(200,212,232,.7)] bg-[rgba(255,255,255,.55)] px-4 py-2.5">
          {evidence.length === 0 ? (
            <span className="text-[12px] text-fg-faint">{C.roadmap.evidenceNone}</span>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {evidence.map(({ c, cell }) => (
                <li key={c.id} className="grid grid-cols-[150px_1fr] gap-3 text-[12.5px]">
                  <span className="flex items-center gap-2 font-semibold"><CellValue cell={cell} /><span className="truncate">{c.name}</span></span>
                  <span className="min-w-0">
                    {cell?.quote && <span className="italic text-[#1f2f47]">“{cell.quote}”</span>}
                    {cell?.sourceUrl && <a href={cell.sourceUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-primary hover:underline">{C.matrix.learnMore}<ExternalLink size={11} /></a>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ————— Domain group (collapsible header row + its capability rows) —————

function DomainGroup({ domain, rows, lines, covered, partial, gaps, colSpan, children, suggestedBy, suggestedCount = 0, suggestedRows, canEdit = false, onDecide }: {
  domain: DomainRow; rows: CapabilityRow[]; lines: string[]; covered: number; partial: number; gaps: number; colSpan: number; children: React.ReactNode;
  /** Set when the domain itself is a scan suggestion (dashed group): the competitor it was seen at. */
  suggestedBy?: string | null;
  suggestedCount?: number;
  suggestedRows?: React.ReactNode;
  canEdit?: boolean;
  onDecide?: (decision: "active" | "dismissed") => void;
}) {
  const [open, setOpen] = useState(true);
  const isSuggested = suggestedBy != null;
  return (
    <>
      <tr data-testid={isSuggested ? "cmp-suggested-domain" : undefined}>
        <td colSpan={colSpan} className="p-0">
          <div className={cn("flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left", isSuggested && "border-y border-dashed border-[rgba(36,87,245,.55)]")} style={{ background: isSuggested ? "repeating-linear-gradient(135deg, rgba(36,87,245,.05) 0 10px, rgba(255,255,255,0) 10px 20px)" : "linear-gradient(90deg, rgba(36,87,245,.14), rgba(255,255,255,0) 60%)" }}>
            <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-3 text-left" title={isSuggested ? C.matrix.suggestedDomainHint(suggestedBy) : domain.summary || undefined}>
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", isSuggested && "border border-dashed border-[#2a5fd0] bg-transparent")} style={isSuggested ? undefined : { background: swatchColor(domain.color, PRODUCT_CHIP_DEFAULT), boxShadow: `0 0 10px ${swatchColor(domain.color, PRODUCT_CHIP_DEFAULT)}66` }} />
              <span className="text-[14px] font-bold">{domain.name}</span>
              {isSuggested ? (
                <span className="inline-flex items-center rounded-full border border-dashed border-[rgba(36,87,245,.55)] bg-white px-2 py-px font-mono text-[9.5px] font-semibold text-[#2a5fd0]">{C.matrix.suggestedDomain} · {C.settings.suggestedBy(suggestedBy)}</span>
              ) : (
                <span className="text-[11px] text-fg-muted">{C.matrix.capabilitiesCount(rows.length)}</span>
              )}
              {suggestedCount > 0 && !isSuggested && <span className="inline-flex items-center rounded-full border border-dashed border-[rgba(36,87,245,.55)] px-1.5 py-px font-mono text-[9.5px] font-semibold text-[#2a5fd0]">{C.matrix.suggestedN(suggestedCount)}</span>}
              {lines.length > 0 && <span className="text-[11px] text-fg-muted">{lines.join(" · ")}</span>}
              <span className="ml-auto flex items-center gap-[18px] text-[12px] text-fg-3">
                {!isSuggested && <span><b className="font-bold text-foreground">{covered}</b> {C.matrix.covered}</span>}
                {partial > 0 && <span className="font-semibold text-[#2a5fd0]">{C.matrix.partialN(partial)}</span>}
                {gaps > 0 && <span className="font-semibold text-[#8a5a00]">{C.matrix.gapN(gaps)}</span>}
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </button>
            {isSuggested && canEdit && onDecide && <DecideButtons accept={C.matrix.acceptDomain} dismiss={C.matrix.dismissDomain} onDecide={onDecide} />}
          </div>
        </td>
      </tr>
      {open && children}
      {open && suggestedRows}
    </>
  );
}

// ————— News feed rows (design C2: one line per signal, day groups) + the detail drawer —————

const IMPACT_PILL: Record<string, string> = {
  High: "border-[rgba(239,90,138,.4)] bg-[rgba(239,90,138,.15)] text-[#c23767]",
  Medium: "border-[rgba(240,180,60,.6)] bg-[#fff7e0] text-[#8a5a00]",
  Low: "border-[rgba(23,178,106,.4)] bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
};
const FACT_TAG_TONE: Record<string, string> = {
  product: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]", tagline: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]", pricingTier: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]",
  customer: "bg-[rgba(24,145,121,.14)] text-[#0f6b57]", hiring: "bg-[rgba(24,145,121,.14)] text-[#0f6b57]", vertical: "bg-[rgba(24,145,121,.14)] text-[#0f6b57]", funding: "bg-[rgba(24,145,121,.14)] text-[#0f6b57]",
};

/** What the row's tag says: gap evidence, capability, the fact kind, or suggestion. */
function feedTag(item: FeedItem): { label: string; className: string } {
  if (item.kind === "fact") return { label: C.notify.email.factKinds[item.factKind ?? ""] ?? item.factKind ?? "", className: FACT_TAG_TONE[item.factKind ?? ""] ?? "bg-[#eef1f6] text-[#4a5b74]" };
  if (item.kind === "gap") return { label: C.feed.tags.gap, className: "border border-dashed border-[#f0b43c] bg-[#fff7e0] text-[#8a5a00]" };
  if (item.kind === "suggestion") return { label: C.feed.tags.suggestion, className: "border border-dashed border-[rgba(36,87,245,.55)] bg-white text-[#2a5fd0]" };
  return { label: C.feed.tags[item.kind], className: "bg-[#eef1f6] text-[#4a5b74]" };
}

/** "Press & news · zerofox.com": the kind of source the item's URL belongs to, and the site it is on. */
function feedSourceLabel(item: FeedItem): string {
  const type = C.profile.sourceTypes[item.sourceType ?? "website"] ?? item.sourceType ?? "";
  let host = "";
  try {
    if (item.sourceUrl) host = new URL(item.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  return host ? `${type} · ${host}` : type;
}

function FeedRow({ item, org, competitor, meaning, open, onOpen }: { item: FeedItem; org: string; competitor: CompetitorRow | null; meaning: string; open: boolean; onOpen: () => void }) {
  // A fact shows the date the page states for it (a launch, a deal); a status change or suggestion has only the scan time.
  const when = item.factDate ? shortDate(item.factDate) : new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tag = feedTag(item);
  const title = item.headline
    ? item.headline
    : item.kind === "fact" || item.kind === "suggestion"
      ? `${item.competitorName}: ${item.title}`
      : `${item.competitorName} ${C.values[item.from ?? "unknown"].toLowerCase()} → ${C.values[item.to ?? "unknown"].toLowerCase()} on ${item.title}`;
  return (
    <button type="button" onClick={onOpen} aria-expanded={open} className={cn("flex h-[58px] w-full items-center gap-3.5 border-b border-[rgba(200,212,232,.5)] px-4 text-left hover:bg-[rgba(255,255,255,.7)]", !open && "[.group-last>&]:border-b-0")} data-testid="cmp-feed-item" data-read={item.read ? "1" : "0"}>
      {competitor ? <Logo c={competitor} /> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#0b1430] text-[11px] font-bold text-[#f3f1fb]">{initialsOf(item.competitorName)}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={cn("truncate text-[13.5px]", item.read ? "font-medium text-[#1f2f47]" : "font-semibold text-foreground")}>{title}</span>
        <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-fg-muted">
          <span className="font-semibold">{feedSourceLabel(item)}</span><span>·</span><span>{when}</span><span>·</span>
          <span className="truncate text-fg-3">{meaning}</span>
        </span>
      </span>
      <span className={cn("inline-flex shrink-0 items-center rounded-md px-2 py-px text-[11px] font-semibold", tag.className)}>{tag.label}</span>
      <span className="flex w-[84px] shrink-0 justify-end"><span className={cn("inline-flex items-center rounded-full border px-2.5 py-px text-[12px] font-semibold", IMPACT_PILL[item.impact])}>{item.impact}</span></span>
    </button>
  );
}

/** The signal opened in place, under its row: everything the feed knows about it, and the actions. */
function FeedDetail({ item, org, meaning, canEdit, onOpenCell, onDecide }: {
  item: FeedItem; org: string; meaning: string; canEdit: boolean;
  onOpenCell: (() => void) | null; onDecide: ((decision: "active" | "dismissed") => void) | null;
}) {
  const at = new Date(item.at);
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-[rgba(200,212,232,.5)] py-2.5 text-[13px] last:border-b-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
  return (
    <div className="border-b border-[rgba(200,212,232,.5)] px-4 pb-4 pl-[62px] pt-1" data-testid="cmp-feed-detail">
      <div className="rounded-inner border border-border bg-white px-4 py-1">
          {item.summary && <p className="my-2 text-[14px] leading-relaxed text-foreground">{item.summary}</p>}
          <div className="my-2 rounded-inner border border-[rgba(36,87,245,.25)] bg-[rgba(36,87,245,.06)] px-4 py-3 text-[13px] text-foreground">{meaning}</div>
          {(item.kind === "gap" || item.kind === "raised" || item.kind === "lowered") && (
            <>
              <Row label={C.feed.detail.change}><span className="font-semibold">{C.values[item.from ?? "unknown"]} → {C.values[item.to ?? "unknown"]}</span>{item.domain && <span className="text-fg-muted"> · {item.domain}</span>}</Row>
              <Row label={C.feed.detail.yourStatus}><span className="font-semibold">{C.values[item.own ?? "unknown"]}</span></Row>
              {item.product && <Row label={C.feed.detail.product}>{item.product}</Row>}
            </>
          )}
          {item.kind === "fact" && (
            <Row label={C.feed.kinds.fact}>{C.notify.email.factKinds[item.factKind ?? ""] ?? item.factKind}{item.factDate && <span className="text-fg-muted"> · {shortDate(item.factDate)}</span>}</Row>
          )}
          {item.kind === "suggestion" && (
            <Row label={C.feed.tags.suggestion}>{item.domain}{item.newDomain && <span className="text-fg-muted"> · {C.notify.email.newDomain}</span>}<span className="text-fg-muted"> · {C.feed.suggestionStates[item.suggestionState ?? ""] ?? ""}</span></Row>
          )}
          {item.quote && <Row label={C.feed.detail.evidence}><span className="italic text-[#1f2f47]">“{item.quote}”</span></Row>}
          <Row label={C.feed.detail.source}>
            <span className="flex flex-wrap items-center gap-2">
              <span>{feedSourceLabel(item)}</span>
              {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">{C.matrix.learnMore}<ExternalLink size={11} /></a>}
            </span>
          </Row>
          <Row label={C.feed.detail.found}>{at.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Row>
        {(onOpenCell || (onDecide && canEdit)) && (
          <div className="flex items-center gap-2 py-3">
            {onOpenCell && <Button size="sm" variant="secondary" onClick={onOpenCell}>{C.feed.openCell}</Button>}
            {onDecide && canEdit && (
              <span className="ml-auto inline-flex gap-2">
                <Button size="sm" onClick={() => onDecide("active")}><Check size={13} strokeWidth={2.5} />{C.matrix.accept}</Button>
                <Button size="sm" variant="secondary" onClick={() => onDecide("dismissed")}><X size={13} strokeWidth={2.5} />{C.matrix.dismiss}</Button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** ✓ / × for a suggestion, same pair on a row and on a suggested domain's header. */
function DecideButtons({ accept, dismiss, onDecide }: { accept: string; dismiss: string; onDecide: (decision: "active" | "dismissed") => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => onDecide("active")} title={accept} aria-label={accept} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(23,178,106,.5)] bg-white text-[#0f7a47] hover:bg-[rgba(23,178,106,.14)]" data-testid="cmp-suggestion-accept"><Check size={14} strokeWidth={2.5} /></button>
      <button type="button" onClick={() => onDecide("dismissed")} title={dismiss} aria-label={dismiss} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-white text-fg-3 hover:border-[#ef5a8a] hover:text-[#c23767]" data-testid="cmp-suggestion-dismiss"><X size={14} strokeWidth={2.5} /></button>
    </span>
  );
}

/** A capability a scan proposed: dashed row at the end of its domain, same height as a catalog row; the proposing competitor's ✓ opens the evidence; ✓ / × to decide. */
function SuggestedRow({ capability, org, seenAt, competitors, canEdit, onDecide, descOpen, onToggleDesc }: {
  capability: CapabilityRow; org: string; seenAt: string; competitors: CompetitorRow[]; canEdit: boolean; onDecide: (decision: "active" | "dismissed") => void;
  descOpen: boolean; onToggleDesc: () => void;
}) {
  const { quote, url } = splitSuggestedQuote(capability.suggestedQuote);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    track("cmp_suggestion_evidence_opened", { capabilityId: capability.id, competitorId: capability.suggestedById, hasUrl: Boolean(url) });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <>
    <tr className="group h-11 border-b border-dashed border-[rgba(36,87,245,.45)] bg-[rgba(36,87,245,.035)] last:border-b-0 hover:bg-[rgba(36,87,245,.07)]" data-testid="cmp-suggested-row">
      <td className="px-4 pl-[30px] font-medium text-[#1f2f47]">
        <span className="inline-flex flex-wrap items-center gap-2">
          {capability.name}
          <DescriptionInfo name={capability.name} description={capability.description} ownProduct="" org={org} open={descOpen} onToggle={onToggleDesc} suggested hint={C.matrix.suggestedRowHint} />
          <span className="inline-flex items-center rounded-full border border-dashed border-[rgba(36,87,245,.55)] bg-white px-1.5 py-px font-mono text-[9.5px] font-semibold text-[#2a5fd0]">{C.matrix.suggested}</span>
        </span>
      </td>
      <td className="bg-[rgba(36,87,245,.06)] text-center" title={C.matrix.ownCellTitle(org)}>
        <span className="inline-flex items-center rounded-full border border-dashed border-[#f0b43c] bg-[#fff7e0] px-2 py-px font-mono text-[10px] font-semibold text-[#8a5a00]">{C.matrix.ownSuggested}</span>
      </td>
      {competitors.map((c) => (
        <td key={c.id} className="text-center">
          {c.id === capability.suggestedById ? (
            <span className="relative inline-flex items-center justify-center">
              <button
                type="button"
                onClick={() => setOpen(!open)}
                title={C.matrix.suggestedCellHint(seenAt)}
                aria-label={`${capability.name}: ${C.values.has} — ${C.matrix.suggestedCellHint(seenAt)}`}
                aria-expanded={open}
                className={cn("inline-flex h-9 min-w-[40px] items-center justify-center rounded-[8px] px-1.5 hover:bg-white/80", open && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")}
                data-testid="cmp-suggestion-evidence"
              >
                <OkMark size={16} />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-[24]" onClick={() => setOpen(false)} />
                  <div className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[340px] -translate-x-1/2 rounded-inner border border-border bg-white p-3.5 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]">
                    <div className="mb-2 flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold">{capability.name}</div>
                        <div className="text-[11.5px] text-fg-muted">{C.matrix.suggested} · {C.settings.suggestedBy(seenAt)}</div>
                      </div>
                      <button type="button" onClick={() => setOpen(false)} aria-label={C.feed.detail.close} className="rounded-md p-1 text-fg-muted hover:bg-background"><X size={14} /></button>
                    </div>
                    {capability.description && <p className="m-0 mb-2 text-[12.5px] leading-snug text-foreground">{capability.description}</p>}
                    {quote ? (
                      <blockquote className="m-0 rounded-[8px] border-l-[3px] border-primary bg-bg-2 px-2.5 py-2 text-[12.5px] italic leading-snug text-[#1f2f47]">“{quote}”</blockquote>
                    ) : (
                      <div className="text-[12px] text-fg-faint">{C.cell.noEvidence}</div>
                    )}
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-primary hover:underline" data-testid="cmp-suggestion-link">
                        {C.matrix.learnMore}<ExternalLink size={12} />
                      </a>
                    )}
                    {canEdit && (
                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
                        <Button size="sm" onClick={() => { setOpen(false); onDecide("active"); }}><Check size={13} strokeWidth={2.5} />{C.matrix.accept}</Button>
                        <Button size="sm" variant="secondary" onClick={() => { setOpen(false); onDecide("dismissed"); }}><X size={13} strokeWidth={2.5} />{C.matrix.dismiss}</Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </span>
          ) : (
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-[#9aa8be]" aria-label={C.values.unknown} />
          )}
        </td>
      ))}
      <td className="px-4">
        {/* Same 98 px footprint as the coverage bar + "n of N" above, so the ✓ / × pair sits centred under it. */}
        <span className="flex w-[98px] items-center justify-center">
          {canEdit ? <DecideButtons accept={C.matrix.accept} dismiss={C.matrix.dismiss} onDecide={onDecide} /> : <span className="text-[11px] text-fg-faint">{C.matrix.suggested}</span>}
        </span>
      </td>
    </tr>
    </>
  );
}

/** Small (i) after a capability name: click opens a card with the plain description, the org's product when known. */
function DescriptionInfo({ name, description, ownProduct, org, open, onToggle, suggested = false, hint }: {
  name: string; description: string; ownProduct: string; org: string; open: boolean; onToggle: () => void; suggested?: boolean; hint?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={C.matrix.descriptionToggle(name)}
        aria-expanded={open}
        className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-fg-faint hover:bg-white hover:text-fg-2", open && "bg-white text-primary shadow-[0_0_0_2px_var(--app-accent-soft)]")}
        data-testid="cmp-description-info"
      >
        <Info size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={onToggle} />
          <div className={cn("absolute left-0 top-[calc(100%+6px)] z-[25] w-[380px] rounded-inner border border-border bg-white px-3.5 py-2.5 text-left text-[12.5px] font-normal leading-relaxed text-foreground shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]", suggested && "border-dashed border-[rgba(36,87,245,.45)]")} data-testid="cmp-description-card">
            <div className="mb-1 flex items-start gap-2">
              <div className="min-w-0 flex-1 text-[13px] font-bold">{name}</div>
              <button type="button" onClick={onToggle} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label={C.feed.detail.close}><X size={14} /></button>
            </div>
            {description ? <p className="m-0">{description}</p> : <p className="m-0 text-fg-faint">{C.matrix.descriptionEmpty}</p>}
            {ownProduct && <p className="m-0 mt-1.5 text-[12px] text-fg-muted">{C.matrix.ownProductTip(org, ownProduct)}</p>}
            {suggested && hint && <p className="m-0 mt-1.5 text-[12px] text-fg-muted">{hint}</p>}
          </div>
        </>
      )}
    </span>
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
                  <a href={cell.sourceUrl} target="_blank" rel="noreferrer" title={cell.sourceUrl} className="mt-1.5 flex max-w-full items-center gap-1 text-[12px] text-primary hover:underline">
                    <ExternalLink size={11} className="shrink-0" /> <span className="min-w-0 truncate">{cell.sourceUrl.replace(/^https?:\/\//, "")}</span>
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

// ————— The org's own cell: its status on a capability, set by PMs —————

function OwnCell({ capability, org, open, setOpen, onPatch }: {
  capability: CapabilityRow;
  org: string;
  open: { competitorId: string; capabilityId: string } | null;
  setOpen: (v: { competitorId: string; capabilityId: string } | null) => void;
  onPatch: (url: string, body: unknown) => Promise<boolean>;
}) {
  const isOpen = open?.competitorId === "own" && open.capabilityId === capability.id;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, setOpen]);
  const fake: CellRow = { id: "", competitorId: "own", capabilityId: capability.id, value: capability.ourStatus, scannedValue: capability.ourStatus, confidence: null, lowConfidence: false, quote: null, sourceUrl: null, changedAt: null, override: null, product: null, history: [] };
  async function set(v: OwnStatus) {
    if (v === capability.ourStatus) return;
    setBusy(true);
    const ok = await onPatch(`/api/competitors/capabilities/${capability.id}`, { ourStatus: v });
    setBusy(false);
    if (ok) setOpen(null);
  }
  return (
    <span className="relative inline-flex items-center justify-center">
      <button
        onClick={() => setOpen(isOpen ? null : { competitorId: "own", capabilityId: capability.id })}
        className={cn("inline-flex h-9 min-w-[40px] items-center justify-center rounded-[8px] px-1.5 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")}
        aria-label={`${capability.name}: ${org} ${C.values[capability.ourStatus]}`}
        aria-expanded={isOpen}
      >
        <CellValue cell={fake} />
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={() => setOpen(null)} />
          <div className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[280px] -translate-x-1/2 rounded-inner border border-border bg-white p-3.5 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]">
            <div className="mb-1 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold">{capability.name}</div>
                <div className="mt-0.5 text-[11.5px] text-fg-muted">{C.matrix.ownCellTitle(org)} · {C.matrix.ownCellHint}</div>
              </div>
              <button onClick={() => setOpen(null)} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label="Close"><X size={14} /></button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {OWN_STATUS_VALUES.map((v) => (
                <button key={v} onClick={() => void set(v)} disabled={busy} className={cn("rounded-full border px-2.5 py-1 text-[12px] font-semibold", capability.ourStatus === v ? "border-transparent bg-primary text-white" : "border-border bg-white text-fg-3 hover:border-primary/55")}>{C.values[v]}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
