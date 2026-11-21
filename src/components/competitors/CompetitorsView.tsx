"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronDown, ChevronRight, Download, ExternalLink, Info, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { Ring } from "@/components/ui/Ring";
import { EvidenceCard, EvidenceList } from "./EvidenceCard";
import { ProfilePanel } from "./ProfilePanel";
import { initialsOf } from "@/components/ui/Avatar";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { FACT_KINDS, isAnalysisActive, OWN_STATUS_VALUES, STATUS_VALUES, type OwnStatus, type StatusValue } from "@/lib/competitors/config";
import type { FeedItem } from "@/lib/competitors/feed";
import { isProductLinesPage, type OwnEvidence } from "@/lib/competitors/own";
import { rankByCloseness } from "@/lib/competitors/closeness";
import type { CapabilityRow, CellRow, CompetitorRow, CompetitorsState, DomainRow, FactRow, FeatureRow } from "@/lib/competitors/store";
import { shortDate, timeAgo } from "@/lib/competitors/time";
import { PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { NO_PARTS, type CompetitorsParts } from "@/lib/competitors/parts";
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
function ClosestCard({ org, ranked, measured, onOpen }: { org: string; ranked: ReturnType<typeof rankByCloseness<CompetitorRow>>; measured: boolean; /** Opens the company's profile; null where Profiles is off (the rows are then plain). */ onOpen: ((competitorId: string) => void) | null }) {
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
                {onOpen ? (
                <button type="button" onClick={() => onOpen(c.id)} className="flex w-full items-center gap-2 rounded-[6px] text-left hover:bg-white" title={`${c.name} · ${C.strip.closestScore(closeness.found, closeness.low, closeness.total)}`}>
                  <Logo c={c} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[#1f2f47]">{c.name}</span>
                  <span className="inline-flex h-1 w-[54px] shrink-0 overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                    <span className="block h-full" style={{ width: `${closeness.score ?? 0}%`, background: bar }} />
                  </span>
                  <span className="w-[22px] shrink-0 text-right text-[10.5px] font-semibold" style={{ color: fg }}>{closeness.score ?? "—"}</span>
                </button>
                ) : (
                <span className="flex w-full items-center gap-2 text-left" title={`${c.name} · ${C.strip.closestScore(closeness.found, closeness.low, closeness.total)}`}>
                  <Logo c={c} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[#1f2f47]">{c.name}</span>
                  <span className="inline-flex h-1 w-[54px] shrink-0 overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                    <span className="block h-full" style={{ width: `${closeness.score ?? 0}%`, background: bar }} />
                  </span>
                  <span className="w-[22px] shrink-0 text-right text-[10.5px] font-semibold" style={{ color: fg }}>{closeness.score ?? "—"}</span>
                </span>
                )}
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

/** The value a cell displays — a correction wins. Found = a check; low confidence = the check in an amber dashed ring; not found = the words (no X). */
function CellValue({ cell, size = 22 }: { cell: CellRow | undefined; size?: number }) {
  if (!cell) return <span className="text-[12px] text-fg-faint">—</span>;
  const v = cell.value;
  if (v === "found") return <OkMark size={size} />;
  if (v === "low") {
    return (
      <span className="inline-flex rounded-full border border-dashed border-[#f0b43c] p-px" title={C.matrix.lowConfidence} data-testid="cmp-cell-low">
        <OkMark size={size - 4} />
      </span>
    );
  }
  return <span className="whitespace-nowrap text-[11px] text-fg-faint">{C.values.not_found}</span>;
}

/**
 * The Competitors page: the C2 full-screen matrix fed by real data — the
 * org's own column first, one column per competitor, rows grouped by domain,
 * a summary strip, filters, cell evidence with a correction, lean profiles.
 * Feed and battle cards stay empty until their stories.
 */
export function CompetitorsView({ initialState, canEdit = false, parts = NO_PARTS }: { initialState: CompetitorsState; canEdit?: boolean; /** Which switched parts of the page are on for this organization (lib/competitors/parts.ts): all off unless given. */ parts?: CompetitorsParts }) {
  // The tabs this organization sees: the matrix and the feed always, the three switched ones only when on.
  // A company's column header opens its profile; where Profiles is off it is plain.
  const HeadTag = parts.profiles ? "button" : "div";
  const tabs = TABS.filter(({ key }) => key === "parity" || key === "feed" || (key === "profiles" && parts.profiles) || (key === "cards" && parts.cards) || (key === "roadmap" && parts.roadmap));
  const [state, setState] = useState(initialState);
  const own = state.orgName.trim() || "Your organization";
  const [tab, setTab] = useState<Tab>("parity");
  const [selectedCompetitor, setSelectedCompetitor] = useState<string | null>(null);
  /** The open cell popover: a competitor's cell (or "own") on a capability row or a feature row. */
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  // Capabilities whose features are shown under them. Closed by default.
  const [openFeatures, setOpenFeatures] = useState<Set<string>>(new Set());
  const toggleFeatures = (capabilityId: string, features: number) => {
    setOpenFeatures((cur) => {
      const next = new Set(cur);
      if (next.has(capabilityId)) next.delete(capabilityId);
      else {
        next.add(capabilityId);
        track("cmp_features_opened", { capabilityId, features });
      }
      return next;
    });
  };
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

  // News feed filters (story 4 fills them)
  const [signalQuery, setSignalQuery] = useState("");
  const [feedCompetitor, setFeedCompetitor] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [impactFilter, setImpactFilter] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);

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

  // ——— Scan (every competitor, one notification) ———
  const [runNote, setRunNote] = useState<string | null>(null);
  /** The run this page saw start: its note is shown when its summary arrives — after the analyses, which write it. */
  const [watchedRun, setWatchedRun] = useState<string | null>(null);
  const awaitingSummary = watchedRun != null && !state.activeRun && state.lastRun?.id === watchedRun && typeof state.lastRun.summary.competitors !== "number";

  // While a scan or an analysis runs (or a run's summary is still to come), learn when it ends; results land in one go.
  useEffect(() => {
    if (!state.scanning && !state.analyzing && !awaitingSummary) return;
    const tick = async () => {
      await refresh();
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [state.scanning, state.analyzing, awaitingSummary, refresh]);

  useEffect(() => {
    if (state.activeRun) {
      setWatchedRun(state.activeRun.id);
      return;
    }
    // The summary is written when the last analysis of the run's scans is done, not when the scans end.
    if (watchedRun && state.lastRun?.id === watchedRun && typeof state.lastRun.summary.competitors === "number") {
      setWatchedRun(null);
      const s = state.lastRun.summary;
      const changed = typeof s.competitors === "number" ? s.competitors : 0;
      const recipients = typeof s.recipients === "number" ? s.recipients : 0;
      setRunNote(`${C.run.finished(changed)}${changed > 0 ? ` ${recipients > 0 ? C.run.notified(recipients) : C.run.noRecipients}` : ""}`);
    }
  }, [state.activeRun, state.lastRun, watchedRun]);

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
  // Capabilities an analysis finds are just added. Only a NEW DOMAIN waits for a PM: a dashed group at the bottom of the table, approve or decline.
  const activeDomains = state.domains.filter((d) => d.state === "active");
  const decideDomain = (id: string, decision: "active" | "dismissed") => patch(`/api/competitors/domains/${id}`, { state: decision });
  const cellMap = useMemo(() => {
    const m = new Map<string, CellRow>();
    for (const c of state.cells) m.set(`${c.competitorId}|${c.capabilityId}`, c);
    return m;
  }, [state.cells]);
  const cellOf = (competitorId: string | null | undefined, capabilityId: string) => (competitorId ? cellMap.get(`${competitorId}|${capabilityId}`) : undefined);
  const featuresByCapability = useMemo(() => {
    const m = new Map<string, FeatureRow[]>();
    for (const f of [...state.features].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))) m.set(f.capabilityId, [...(m.get(f.capabilityId) ?? []), f]);
    return m;
  }, [state.features]);
  const featuresOf = (capabilityId: string) => featuresByCapability.get(capabilityId) ?? [];
  const featureCellMap = useMemo(() => {
    const m = new Map<string, CellRow>();
    for (const c of state.featureCells) m.set(`${c.competitorId}|${c.featureId}`, c);
    return m;
  }, [state.featureCells]);
  const featureCellOf = (competitorId: string, featureId: string) => featureCellMap.get(`${competitorId}|${featureId}`);
  /** The org's own cell is the capability's ourStatus — from its own website where that is analysed, else set by PMs; a PM's value always wins. */
  const ownOf = (k: CapabilityRow): OwnStatus => k.ourStatus;
  /** Gap = not found at the org while found at a competitor (a low-confidence find opens no gap); only-us = found at the org and at no competitor, not even with low confidence. */
  const rowKind = (k: CapabilityRow): "gap" | "only" | "level" | "none" => {
    const theirs = competitors.map((c) => cellOf(c.id, k.id)?.value ?? "not_found");
    const anyFound = theirs.some((v) => v === "found");
    const anyFoundOrLow = theirs.some((v) => v === "found" || v === "low");
    const ownV = ownOf(k);
    if (competitors.length === 0) return "none";
    if (ownV === "found" && !anyFoundOrLow) return "only";
    if (ownV === "not_found" && anyFound) return "gap";
    return "level";
  };

  const summary = useMemo(() => {
    const total = activeCaps.length;
    let full = 0, gaps = 0, only = 0;
    for (const k of activeCaps) {
      const kind = rowKind(k);
      if (ownOf(k) === "found") full++;
      if (kind === "gap") gaps++;
      if (kind === "only") only++;
    }
    const measured = competitors.length > 0 && total > 0 && state.cells.length > 0;
    return { total, full, gaps, only, measured, parity: measured ? Math.round((full / total) * 100) : null };
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
    return shownCompetitors.some((c) => (cellOf(c.id, k.id)?.value ?? "not_found") === wanted);
  };
  const visibleCaps = activeCaps.filter((k) => {
    if (q && !k.name.toLowerCase().includes(q) && !k.description.toLowerCase().includes(q)) return false;
    if (domainFilter.length && !domainFilter.includes(state.domains.find((d) => d.id === k.domainId)?.name ?? "")) return false;
    if (productFilter.length && !k.productLines.some((p) => productFilter.includes(p))) return false;
    if (gapsOnly && rowKind(k) !== "gap") return false;
    return matchesStatus(k);
  });
  const domainsWithRows = state.domains.filter((d) => d.state !== "dismissed" && visibleCaps.some((k) => k.domainId === d.id));
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
      const n = competitors.filter((c) => cellOf(c.id, i.capabilityId!)?.value === "found").length;
      return C.feed.meaning.gap(own, i.competitorName, n, competitors.length);
    }
    if (i.kind === "raised" || i.kind === "lowered") return C.feed.meaning[i.kind](own, i.competitorName, C.values[i.own ?? "not_found"].toLowerCase());
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
      });
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, domainFilter, productFilter, competitorFilter, statusFilter, gapsOnly]);

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
    if (!parts.profiles) return;
    setSelectedCompetitor(competitorId);
    setTab("profiles");
    setOpenCell(null);
    const facts = state.facts.filter((f) => f.competitorId === competitorId);
    track("cmp_profile_viewed", { competitorId, factsShown: facts.length, factsMissing: FACT_KINDS.length - new Set(facts.map((f) => f.kind)).size, from });
  }

  const sourcesCount = state.competitors.filter((c) => c.source).length;
  const headerScan = state.scanning ? C.header.scanning : state.analyzing ? C.header.analyzing : state.lastScanAt ? C.header.scanned(timeAgo(state.lastScanAt)) : C.header.neverScanned;

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
            {tabs.map(({ key, label }) => {
              const on = tab === key;
              const badge = key === "roadmap" && summary.measured ? summary.gaps : 0;
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
                    {summary.parity == null ? C.strip.parityNone : C.strip.paritySub(summary.full, summary.total)}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-fg-faint">{C.strip.counts(activeDomains.length, activeCaps.length, competitors.length)}</div>
                </div>
              </div>
              <StatCard label={C.strip.gaps} tone="#f0b43c" toneFg="#8a5a00" value={summary.measured ? summary.gaps : null} sub={summary.measured ? C.strip.gapsSub(summary.gaps) : C.strip.gapsNone} />
              <StatCard label={C.strip.only(own)} tone="#17b26a" toneFg="#0f7a47" value={summary.measured ? summary.only : null} sub={summary.measured ? C.strip.onlySub(summary.only) : C.strip.onlyNone} />
              <ClosestCard org={own} ranked={closest} measured={summary.measured} onOpen={parts.profiles ? (id) => openProfile(id, "cell") : null} />
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
                          <HeadTag {...(parts.profiles ? { onClick: () => openProfile(c.id, "cell") } : {})} className={cn("flex w-full flex-col items-center gap-1.5 pt-[13px]", parts.profiles && "hover:opacity-80")} title={c.lastScan?.badge === "blocked" || c.lastScan?.badge === "unreachable" ? `${c.name} — ${C.settings.badges[c.lastScan.badge]}${c.lastGoodScanAt ? `. ${C.settings.showingDataFrom(shortDate(c.lastGoodScanAt))}` : ""}` : c.name}>
                            <Logo c={c} />
                            <span className="max-w-[96px] truncate text-[11.5px] font-medium text-fg-3">{c.name}</span>
                            {(c.lastScan?.badge === "blocked" || c.lastScan?.badge === "unreachable") && (
                              <span className="rounded-full bg-[rgba(239,90,138,.15)] px-1.5 py-px font-mono text-[9px] font-semibold text-[#c23767]">{C.settings.badges[c.lastScan.badge]}{c.lastGoodScanAt ? ` · ${shortDate(c.lastGoodScanAt)}` : ""}</span>
                            )}
                            {c.analysis && isAnalysisActive(c.analysis.status) && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-[rgba(36,87,245,.12)] px-1.5 py-px font-mono text-[9px] font-semibold text-[#2a5fd0]"
                                title={c.analysis.status === "waiting" ? C.matrix.analysisWaiting : c.analysis.status === "queued" ? C.settings.analysisQueued : c.analysis.step === "reading" && c.analysis.pagesTotal > 0 ? C.settings.analyzingPages(c.analysis.pagesDone, c.analysis.pagesTotal) : C.settings.analysisStep[c.analysis.step] ?? C.matrix.analyzing}
                                data-testid="cmp-analyzing-chip"
                              >
                                <Loader2 size={9} className="animate-spin" />
                                {c.analysis.status === "waiting" ? C.matrix.analysisWaiting : C.matrix.analyzing}
                              </span>
                            )}
                          </HeadTag>
                        </th>
                      ))}
                      <th scope="col" className="w-[150px] border-b border-border px-4 py-2.5"><span className="sr-only">{C.matrix.coverage}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.setup !== "done" || activeCaps.length === 0 || competitors.length === 0 ? (
                      <tr>
                        <td colSpan={3 + shownCompetitors.length} className="px-10 py-14 text-center">
                          {state.setup !== "done" ? (
                            // Competitors needs its initial setup before it works: no empty table, no "add your domains".
                            <div data-testid="cmp-being-set-up">
                              <div className="font-title mb-1 text-[15px] font-bold">{C.setup.title}</div>
                              <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{C.setup.body} {C.setup.settingsHint}</div>
                            </div>
                          ) : (
                            <>
                              <div className="font-title mb-1 text-[15px] font-bold">{activeCaps.length === 0 ? C.matrix.noCatalogTitle : C.matrix.emptyTitle}</div>
                              <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{activeCaps.length === 0 ? C.matrix.noCatalogBody : C.matrix.emptyBody(own)}</div>
                            </>
                          )}
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
                        const covered = rows.filter((k) => ownOf(k) === "found").length;
                        const gaps = rows.filter((k) => rowKind(k) === "gap").length;
                        return (
                          <DomainGroup key={d.id} domain={d} rows={rows} lines={lines} covered={covered} gaps={gaps} colSpan={3 + shownCompetitors.length}
                            suggestedBy={d.state === "suggested" ? competitorName(d.suggestedById) : null} canEdit={canEdit} onDecide={(decision) => void decideDomain(d.id, decision)}>
                            {rows.map((k) => {
                              const kind = rowKind(k);
                              const haveN = shownCompetitors.filter((c) => cellOf(c.id, k.id)?.value === "found").length;
                              const descOpen = openDesc === k.id;
                              const features = featuresOf(k.id);
                              const featuresOpen = features.length > 0 && openFeatures.has(k.id);
                              return (
                                <Fragment key={k.id}>
                                <tr className={cn("group h-11 border-b border-border last:border-b-0 hover:bg-[rgba(255,255,255,.7)]", kind === "gap" && "bg-[#fff7e0]", kind === "only" && "bg-[rgba(23,178,106,.08)]")}>
                                  <td className={cn("px-4 pl-[30px] font-medium text-[#1f2f47]", (kind === "gap" || kind === "only") && "font-semibold text-foreground")}>
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                      {features.length > 0 && (
                                        <button type="button" onClick={() => toggleFeatures(k.id, features.length)} aria-expanded={featuresOpen} aria-label={C.matrix.featuresToggle(k.name, features.length)} title={C.matrix.featuresToggle(k.name, features.length)}
                                          className="-ml-[22px] inline-flex h-5 w-5 items-center justify-center rounded-[6px] text-fg-muted hover:bg-white hover:text-fg-2" data-testid="cmp-features-toggle">
                                          {featuresOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                        </button>
                                      )}
                                      {k.name}
                                      {features.length > 0 && <span className="text-[11px] font-normal text-fg-muted">{C.matrix.featuresCount(features.length)}</span>}
                                      <DescriptionInfo name={k.name} description={k.description} ownProduct={k.ownProduct} org={own} open={descOpen} onToggle={() => toggleDesc(k.id)} />
                                      {kind === "gap" && <span className="inline-flex items-center rounded-full border border-dashed border-[#f0b43c] bg-[#fff7e0] px-1.5 py-px font-mono text-[9.5px] font-semibold text-[#8a5a00]">Gap</span>}
                                      {kind === "only" && <span className="inline-flex items-center rounded-full bg-[rgba(23,178,106,.14)] px-2 py-px font-mono text-[10px] font-semibold text-[#0f7a47]">{C.strip.only(own)}</span>}
                                    </span>
                                  </td>
                                  <td className={cn("text-center", kind === "gap" ? "bg-[rgba(240,180,60,.18)]" : kind === "only" ? "bg-[rgba(23,178,106,.16)]" : "bg-[rgba(36,87,245,.06)]")}>
                                    <span className="inline-flex max-w-[100px] items-center justify-center gap-1">
                                      <OwnCell row={k} kind="capability" org={own} ownSite={state.ownSite} open={openCell} setOpen={setOpenCell} onPatch={patch} />
                                    </span>
                                  </td>
                                  {shownCompetitors.map((c) => {
                                    const cell = cellOf(c.id, k.id);
                                    return (
                                      <td key={c.id} className="text-center">
                                        <Cell cell={cell} competitorId={c.id} row={k} kind="capability" open={openCell} setOpen={setOpenCell} onPatch={patch} onProfile={parts.profiles ? () => openProfile(c.id, "cell") : null} notScanned={!c.source?.lastScanAt} analyzing={isAnalysisActive(c.analysis?.status)} />
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
                                {featuresOpen && features.map((f) => (
                                  <FeatureLine key={f.id} feature={f} org={own} ownSite={state.ownSite} competitors={shownCompetitors} cellOf={(competitorId) => featureCellOf(competitorId, f.id)} open={openCell} setOpen={setOpenCell} onPatch={patch} onProfile={parts.profiles ? (competitorId) => openProfile(competitorId, "cell") : null} />
                                ))}
                                </Fragment>
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
              <span className="inline-flex items-center gap-1.5"><OkMark size={16} />{C.matrix.legendFound}</span>
              <span className="inline-flex items-center gap-1.5" title={C.matrix.legendLowSub}>
                <span className="inline-flex rounded-full border border-dashed border-[#f0b43c] p-px"><OkMark size={12} /></span>
                {C.matrix.legendLow}
              </span>
              <span className="inline-flex items-center gap-1.5"><span className="text-[11px] text-fg-faint">{C.values.not_found}</span>{C.matrix.legendNotFound}</span>
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
                              <FeedDetail item={item} meaning={feedMeaning(item)}
                                onOpenCell={item.capabilityId && item.kind !== "suggestion" ? () => { setTab("parity"); setOpenCell({ competitorId: item.competitorId, rowId: item.capabilityId! }); } : null} />
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

        {tab === "profiles" && parts.profiles && (
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

        {tab === "cards" && parts.cards && (
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

        {tab === "roadmap" && parts.roadmap && (() => {
          const gapRows = summary.measured ? activeCaps.filter((k) => rowKind(k) === "gap") : [];
          const total = gapRows.length;
          const sections = [
            { key: "gap", title: C.roadmap.gaps, sub: C.roadmap.gapsSub(own), empty: C.roadmap.gapsEmpty, rows: gapRows, color: "#f0b43c", glow: "rgba(240,180,60,.6)", gradient: "linear-gradient(90deg, rgba(240,180,60,.18), rgba(255,255,255,0) 60%)" },
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
                        <RoadmapRow key={k.id} capability={k} competitors={competitors} cellOf={cellOf} domain={state.domains.find((d) => d.id === k.domainId)?.name ?? ""} onCreateIdea={() => post(`/api/competitors/capabilities/${k.id}/idea`)} />
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

function RoadmapRow({ capability: k, competitors, cellOf, domain, onCreateIdea }: {
  capability: CapabilityRow;
  competitors: CompetitorRow[];
  cellOf: (competitorId: string, capabilityId: string) => CellRow | undefined;
  domain: string;
  onCreateIdea: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const withIt = competitors
    .map((c) => ({ c, cell: cellOf(c.id, k.id) }))
    .filter(({ cell }) => cell && (cell.value === "found" || cell.value === "low"));
  const names = withIt.map(({ c }) => c.name);
  const headline = C.roadmap.haveIt(withIt.length, competitors.length);
  const sub = [headline, names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`, domain].filter(Boolean).join(" · ");
  const evidence = withIt.filter(({ cell }) => cell?.quote || cell?.sourceUrl);
  const toggle = () => {
    setOpen((v) => !v);
    if (!open) track("cmp_roadmap_evidence_opened", { capabilityId: k.id, kind: "gap", count: evidence.length });
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

function DomainGroup({ domain, rows, lines, covered, gaps, colSpan, children, suggestedBy, canEdit = false, onDecide }: {
  domain: DomainRow; rows: CapabilityRow[]; lines: string[]; covered: number; gaps: number; colSpan: number; children: React.ReactNode;
  /** Set when the domain itself is suggested by an analysis (dashed group at the bottom of the table): the competitor it was seen at. Its capabilities are ordinary rows. */
  suggestedBy?: string | null;
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
              {lines.length > 0 && <span className="text-[11px] text-fg-muted">{lines.join(" · ")}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-[18px] text-[12px] text-fg-3">
                {!isSuggested && <span><b className="font-bold text-foreground">{covered}</b> {C.matrix.covered}</span>}
                {gaps > 0 && <span className="font-semibold text-[#8a5a00]">{C.matrix.gapN(gaps)}</span>}
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </button>
            {isSuggested && canEdit && onDecide && <DecideButtons approve={C.matrix.approveDomain} decline={C.matrix.declineDomain} declineHint={C.matrix.declineDomainHint} onDecide={onDecide} />}
          </div>
        </td>
      </tr>
      {open && children}
    </>
  );
}

// ————— A feature row: the level under a capability — the own mark, a mark per competitor, the coverage —————

function FeatureLine({ feature, org, ownSite, competitors, cellOf, open, setOpen, onPatch, onProfile }: {
  feature: FeatureRow;
  org: string;
  ownSite: boolean;
  competitors: CompetitorRow[];
  cellOf: (competitorId: string) => CellRow | undefined;
  open: OpenCell | null;
  setOpen: (v: OpenCell | null) => void;
  onPatch: (url: string, body: unknown) => Promise<boolean>;
  onProfile: ((competitorId: string) => void) | null;
}) {
  const haveN = competitors.filter((c) => cellOf(c.id)?.value === "found").length;
  return (
    <tr className="h-10 border-b border-border bg-[rgba(255,255,255,.35)] last:border-b-0 hover:bg-[rgba(255,255,255,.7)]" data-testid="cmp-feature-row">
      <td className="px-4 pl-[52px] text-[12.5px] text-[#1f2f47]">
        {feature.name}
      </td>
      <td className="bg-[rgba(36,87,245,.06)] text-center">
        <span className="inline-flex max-w-[100px] items-center justify-center gap-1">
          <OwnCell row={feature} kind="feature" org={org} ownSite={ownSite} open={open} setOpen={setOpen} onPatch={onPatch} />
        </span>
      </td>
      {competitors.map((c) => (
        <td key={c.id} className="text-center">
          <Cell cell={cellOf(c.id)} competitorId={c.id} row={feature} kind="feature" open={open} setOpen={setOpen} onPatch={onPatch} onProfile={onProfile ? () => onProfile(c.id) : null} notScanned={!c.source?.lastScanAt} analyzing={isAnalysisActive(c.analysis?.status)} />
        </td>
      ))}
      <td className="px-4">
        <span className="flex items-center gap-2">
          <span className="inline-flex h-1 w-[54px] overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
            <span className="block h-full bg-[#5b6c85]" style={{ width: `${competitors.length ? Math.round((haveN / competitors.length) * 100) : 0}%` }} />
          </span>
          <span className="font-mono text-[11px] font-semibold text-fg-3">{C.matrix.ofN(haveN, competitors.length)}</span>
        </span>
      </td>
    </tr>
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
      : `${item.competitorName} ${C.values[item.from ?? "not_found"].toLowerCase()} → ${C.values[item.to ?? "not_found"].toLowerCase()} on ${item.title}`;
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
function FeedDetail({ item, meaning, onOpenCell }: {
  item: FeedItem; meaning: string;
  onOpenCell: (() => void) | null;
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
              <Row label={C.feed.detail.change}><span className="font-semibold">{C.values[item.from ?? "not_found"]} → {C.values[item.to ?? "not_found"]}</span>{item.domain && <span className="text-fg-muted"> · {item.domain}</span>}</Row>
              <Row label={C.feed.detail.yourStatus}><span className="font-semibold">{C.values[item.own ?? "not_found"]}</span></Row>
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
        {onOpenCell && (
          <div className="flex items-center gap-2 py-3">
            <Button size="sm" variant="secondary" onClick={onOpenCell}>{C.feed.openCell}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** ✓ / × on a suggested domain's header: approve keeps the domain, decline moves its capabilities to the closest existing domain. */
function DecideButtons({ approve, decline, declineHint, onDecide }: { approve: string; decline: string; declineHint: string; onDecide: (decision: "active" | "dismissed") => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => onDecide("active")} title={approve} aria-label={approve} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(23,178,106,.5)] bg-white text-[#0f7a47] hover:bg-[rgba(23,178,106,.14)]" data-testid="cmp-suggestion-accept"><Check size={14} strokeWidth={2.5} /></button>
      <button type="button" onClick={() => onDecide("dismissed")} title={declineHint} aria-label={decline} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-white text-fg-3 hover:border-[#ef5a8a] hover:text-[#c23767]" data-testid="cmp-suggestion-dismiss"><X size={14} strokeWidth={2.5} /></button>
    </span>
  );
}

/** Small (i) after a capability name: click opens a card with the plain description, the org's product when known. */
function DescriptionInfo({ name, description, ownProduct, org, open, onToggle }: {
  name: string; description: string; ownProduct: string; org: string; open: boolean; onToggle: () => void;
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
          <div className={cn("absolute left-0 top-[calc(100%+6px)] z-[25] w-[380px] rounded-inner border border-border bg-white px-3.5 py-2.5 text-left text-[12.5px] font-normal leading-relaxed text-foreground shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]")} data-testid="cmp-description-card">
            <div className="mb-1 flex items-start gap-2">
              <div className="min-w-0 flex-1 text-[13px] font-bold">{name}</div>
              <button type="button" onClick={onToggle} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label={C.feed.detail.close}><X size={14} /></button>
            </div>
            {description ? <p className="m-0">{description}</p> : <p className="m-0 text-fg-faint">{C.matrix.descriptionEmpty}</p>}
            {ownProduct && <p className="m-0 mt-1.5 text-[12px] text-fg-muted">{C.matrix.ownProductTip(org, ownProduct)}</p>}
          </div>
        </>
      )}
    </span>
  );
}

// ————— One cell with its evidence / correction popover —————

/** Cells whose evidence was shown on hover in this page view (the event is recorded once per cell). */
const hoverShown = new Set<string>();
/** The pointer rests this long on a cell before its evidence shows. */
const HOVER_OPEN_MS = 250;
/** The card stays this long after the pointer leaves, so it can cross the gap to the card and click the link. */
const HOVER_CLOSE_MS = 150;

/** Which popover is open: the competitor's column (or "own") and the row — a capability or a feature. */
interface OpenCell {
  competitorId: string;
  rowId: string;
}
/** Where a row's own mark and its competitor cells are saved. */
const PATCH_BASE = {
  capability: { own: "/api/competitors/capabilities", cell: "/api/competitors/statuses" },
  feature: { own: "/api/competitors/features", cell: "/api/competitors/feature-statuses" },
} as const;

function Cell({ cell, competitorId, row, kind, open, setOpen, onPatch, onProfile, notScanned, analyzing }: {
  cell: CellRow | undefined;
  competitorId: string;
  /** The row of the cell: a capability or a feature. */
  row: { id: string; name: string };
  kind: "capability" | "feature";
  open: OpenCell | null;
  setOpen: (v: OpenCell | null) => void;
  onPatch: (url: string, body: unknown) => Promise<boolean>;
  onProfile: (() => void) | null;
  notScanned?: boolean;
  /** The competitor's analysis run is queued or in progress. */
  analyzing?: boolean;
}) {
  const isOpen = open?.competitorId === competitorId && open.rowId === row.id;
  // Hover: the evidence, read-only, from the cell data already in the state — no fetch, nothing to wait for.
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTo = (next: boolean, ms: number) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(next), ms);
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  const showHover = hover && !isOpen && Boolean(cell) && (Boolean(cell?.quote) || cell?.value === "not_found");
  useEffect(() => {
    if (!showHover || !cell) return;
    const key = `${competitorId}|${row.id}`;
    if (!hoverShown.has(key)) {
      hoverShown.add(key);
      track("cmp_cell_evidence_shown", { competitorId, rowKind: kind, rowId: row.id, value: cell.value, via: "hover", hasEvidence: Boolean(cell.quote) });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHover(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHover]);
  const [editing, setEditing] = useState(false);
  // A PM corrects to found or not found; "low confidence" is a value only the analysis sets.
  const correctable = (v: StatusValue | undefined): OwnStatus => (v === "not_found" || v === undefined ? "not_found" : "found");
  const [value, setValue] = useState<OwnStatus>(correctable(cell?.value));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setEditing(false);
      setNote("");
    } else {
      setValue(correctable(cell?.value));
      track("cmp_cell_opened", { competitorId, rowKind: kind, ...(kind === "capability" ? { capabilityId: row.id } : { featureId: row.id }), value: cell?.value ?? "not_found", hasEvidence: Boolean(cell?.quote), overridden: Boolean(cell?.override) });
      track("cmp_cell_evidence_shown", { competitorId, rowKind: kind, rowId: row.id, value: cell?.value ?? "not_found", via: "click", hasEvidence: Boolean(cell?.quote) });
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

  if (!cell && (notScanned || analyzing)) {
    // No cell yet: the site was never scanned, or its first analysis is still filling the table.
    return <span className="text-[11px] text-fg-faint">{analyzing ? C.matrix.analyzingCell : C.matrix.notScanned}</span>;
  }

  async function save() {
    if (!cell) return;
    setBusy(true);
    const ok = await onPatch(`${PATCH_BASE[kind].cell}/${cell.id}`, { value, note });
    setBusy(false);
    if (ok) setEditing(false);
  }
  async function reset() {
    if (!cell) return;
    setBusy(true);
    await onPatch(`${PATCH_BASE[kind].cell}/${cell.id}`, { reset: true });
    setBusy(false);
  }

  return (
    <span className="relative inline-flex items-center justify-center" onMouseEnter={() => hoverTo(true, HOVER_OPEN_MS)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
      <button
        onClick={() => { setHover(false); setOpen(isOpen ? null : { competitorId, rowId: row.id }); }}
        className={cn("relative inline-flex h-9 min-w-[40px] items-center justify-center rounded-[8px] px-1.5 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")}
        aria-label={`${row.name}: ${C.values[cell?.value ?? "not_found"]}`}
        aria-expanded={isOpen}
      >
        <CellValue cell={cell} />
        {cell?.override && <Pencil size={9} className="absolute right-0.5 top-0.5 text-[#8a5a00]" aria-label={C.matrix.edited} />}
      </button>
      {showHover && cell && (
        <div role="tooltip" className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[320px] -translate-x-1/2 rounded-inner border border-border bg-white p-3 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]" data-testid="cmp-cell-hover">
          <EvidenceCard quote={cell.quote} url={cell.sourceUrl} reasoning={cell.reasoning} wording={cell.wording} description={cell.description} count={cell.evidenceCount} empty={C.cell.notFoundHint} />
        </div>
      )}
      {isOpen && cell && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={() => setOpen(null)} />
          <div className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[340px] -translate-x-1/2 rounded-inner border border-border bg-white p-3.5 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]" onKeyDown={(e) => { if (e.key === "Enter" && editing && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); void save(); } }}>
            <div className="mb-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold">{row.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-muted">
                  <span className="inline-flex items-center gap-1.5"><CellValue cell={cell} size={16} /> {C.values[cell.value]}</span>
                  {cell.changedAt && <span>· {C.matrix.changed(shortDate(cell.changedAt))}</span>}
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
                <EvidenceCard quote={cell.quote} url={cell.sourceUrl} reasoning={cell.reasoning} wording={cell.wording} count={cell.evidenceCount} empty={cell.scannedValue === "not_found" ? C.cell.notFoundHint : C.cell.noEvidence} />
                {cell.evidenceCount > 1 && <EvidenceList cellId={cell.id} kind={kind} competitorId={competitorId} rowId={row.id} count={cell.evidenceCount} />}
              </div>
            )}
            {editing && (
              <div className="text-[12.5px]">
                <div className="mb-1 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.cell.setTo}</div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {OWN_STATUS_VALUES.map((v) => (
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

// ————— The org's own cell: its status on a row — from its own website where it is analysed, or set by PMs —————

function OwnCell({ row, kind, org, ownSite, open, setOpen, onPatch }: {
  /** The row: a capability or a feature, with the org's own mark on it and the evidence of its own website behind it. */
  row: { id: string; name: string; ourStatus: OwnStatus; ourStatusByPm: boolean; ownEvidence: OwnEvidence | null };
  kind: "capability" | "feature";
  org: string;
  /** The organization's own website is analysed: the value comes from it unless a PM set it. */
  ownSite: boolean;
  open: OpenCell | null;
  setOpen: (v: OpenCell | null) => void;
  onPatch: (url: string, body: unknown) => Promise<boolean>;
}) {
  const isOpen = open?.competitorId === "own" && open.rowId === row.id;
  const [busy, setBusy] = useState(false);
  // Hover: the evidence of the own website, read-only, from the row already in the state — the same card as a competitor's cell.
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTo = (next: boolean, ms: number) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(next), ms);
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  const evidence = row.ownEvidence;
  const showHover = hover && !isOpen && ownSite && (Boolean(evidence) || row.ourStatus === "not_found");
  useEffect(() => {
    if (!showHover) return;
    const key = `own|${row.id}`;
    if (!hoverShown.has(key)) {
      hoverShown.add(key);
      track("cmp_cell_evidence_shown", { competitorId: "own", rowKind: kind, rowId: row.id, value: row.ourStatus, via: "hover", hasEvidence: Boolean(evidence) });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHover(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHover]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, setOpen]);
  const fake: CellRow = { id: "", competitorId: "own", capabilityId: kind === "capability" ? row.id : null, featureId: kind === "feature" ? row.id : null, value: row.ourStatus, scannedValue: row.ourStatus, quote: null, sourceUrl: null, reasoning: null, wording: null, description: null, evidenceCount: 0, changedAt: null, override: null, product: null, history: [] };
  // A quote from the product lines has no page to open: the card says where it is from instead of linking an internal address.
  const fromProductLines = isProductLinesPage(evidence?.sourceUrl);
  const card = (
    <>
      <EvidenceCard quote={evidence?.quote ?? null} url={fromProductLines ? null : evidence?.sourceUrl ?? null} reasoning={evidence?.reasoning || null} wording={null} description={evidence?.description ?? null} count={evidence?.count ?? 0} empty={C.matrix.ownEvidenceEmpty} />
      {evidence && fromProductLines && <div className="mt-1 text-[12px] text-fg-muted" data-testid="cmp-own-evidence-product-lines">{C.matrix.ownFromProductLines}</div>}
    </>
  );
  async function set(v: OwnStatus) {
    if (v === row.ourStatus) return;
    setBusy(true);
    const ok = await onPatch(`${PATCH_BASE[kind].own}/${row.id}`, { ourStatus: v });
    setBusy(false);
    if (ok) setOpen(null);
  }
  return (
    <span className="relative inline-flex items-center justify-center" onMouseEnter={() => hoverTo(true, HOVER_OPEN_MS)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
      <button
        onClick={() => { setHover(false); setOpen(isOpen ? null : { competitorId: "own", rowId: row.id }); }}
        className={cn("inline-flex h-9 min-w-[40px] items-center justify-center rounded-[8px] px-1.5 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")}
        aria-label={`${row.name}: ${org} ${C.values[row.ourStatus]}`}
        aria-expanded={isOpen}
      >
        <CellValue cell={fake} />
      </button>
      {showHover && (
        <div role="tooltip" className="absolute left-1/2 top-[calc(100%+6px)] z-[25] w-[320px] -translate-x-1/2 rounded-inner border border-border bg-white p-3 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]" data-testid="cmp-own-cell-hover">
          {card}
        </div>
      )}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={() => setOpen(null)} />
          <div className={cn("absolute left-1/2 top-[calc(100%+6px)] z-[25] -translate-x-1/2 rounded-inner border border-border bg-white p-3.5 text-left shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]", ownSite ? "w-[340px]" : "w-[280px]")}>
            <div className="mb-1 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold">{row.name}</div>
                <div className="mt-0.5 text-[11.5px] text-fg-muted" data-testid="cmp-own-cell-hint">{C.matrix.ownCellTitle(org)} · {!ownSite ? C.matrix.ownCellHint : row.ourStatusByPm ? C.matrix.ownCellByTeam : C.matrix.ownCellFromSite}</div>
              </div>
              <button onClick={() => setOpen(null)} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label="Close"><X size={14} /></button>
            </div>
            {ownSite && (
              <div className="mt-2 text-[12.5px] text-fg-2">
                <div className="mb-1 font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.cell.evidence}</div>
                {card}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {OWN_STATUS_VALUES.map((v) => (
                <button key={v} onClick={() => void set(v)} disabled={busy} className={cn("rounded-full border px-2.5 py-1 text-[12px] font-semibold", row.ourStatus === v ? "border-transparent bg-primary text-white" : "border-border bg-white text-fg-3 hover:border-primary/55")}>{C.values[v]}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
