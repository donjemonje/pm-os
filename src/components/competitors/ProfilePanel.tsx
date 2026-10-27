"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, Flag, Lightbulb, Pencil, Plus, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { initialsOf } from "@/components/ui/Avatar";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { FACT_KINDS, STATUS_VALUES, type StatusValue } from "@/lib/competitors/config";
import { track } from "@/lib/analytics/track";
import type { CapabilityRow, CellRow, CompetitorRow, DomainRow, FactRow } from "@/lib/competitors/store";
import { shortDate, timeAgo } from "@/lib/competitors/time";
import { PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { cn } from "@/lib/utils";

/**
 * Competitor profile — the C2 design on the pipeline's rows only: competitor
 * chips, header (identity facts, the parity-based risk ring, fact grid),
 * timeline from dated facts, capabilities by domain and product with a deep
 * dive per capability (quote, source, confidence, history), and the side
 * column (what changed, UI gallery from the media store, sources). A section
 * whose rows are empty shows its empty state; nothing is shown that no scan
 * or PM produced.
 */

const EB = "font-mono text-[10px] font-semibold tracking-[0.06em] text-fg-muted";
const CARD = "flex flex-col gap-0.5 rounded-[9px] border border-border bg-[rgba(255,255,255,.72)] px-3 py-2.5";
const KIND: Record<string, string> = {
  int: "bg-[#eef1f6] text-[#4a5b74]",
  pos: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]",
  gtm: "bg-[rgba(24,145,121,.14)] text-[#0f6b57]",
};
const PILL: Record<string, string> = {
  high: "border-[rgba(239,90,138,.4)] bg-[rgba(239,90,138,.15)] text-[#c23767]",
  medium: "border-[rgba(240,180,60,.6)] bg-[#fff7e0] text-[#8a5a00]",
  low: "border-[rgba(23,178,106,.4)] bg-[rgba(23,178,106,.14)] text-[#0f7a47]",
};

/** Timeline event types, derived from the kind of a dated fact. */
type EventType = "company" | "funding" | "product" | "hr";
const TL_COLOR: Record<EventType, string> = { company: "#5b6c85", funding: "#e67700", product: "#2457f5", hr: "#189179" };
const TL_LABEL: Record<EventType, string> = { company: "Company", funding: "Funding", product: "Products", hr: "Hiring" };
function eventTypeOf(kind: string): EventType {
  if (kind === "funding") return "funding";
  if (kind === "hiring" || kind === "headcount") return "hr";
  if (kind === "product" || kind === "pricingTier") return "product";
  return "company";
}

function Kind({ tone = "int", children, className }: { tone?: string; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-[6px] px-2 py-px text-[11px] font-semibold", KIND[tone] ?? KIND.int, className)}>{children}</span>;
}

function Logo({ c, size = 28, className }: { c: CompetitorRow; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-white text-[11px] font-bold text-fg-2", className)} style={{ width: size, height: size, borderRadius: size >= 40 ? 12 : 8 }} title={c.name}>
      {c.logoUrl && !broken ? <img src={c.logoUrl} alt="" onError={() => setBroken(true)} style={{ width: size * 0.72, height: size * 0.72 }} className="object-contain" /> : initialsOf(c.name)}
    </span>
  );
}

function Ring({ value, color, size = 52 }: { value: number; color: string; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span role="img" aria-label={`Risk ${value} of 100`} className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(12,25,41,.08)" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <span className="text-[15px] font-bold leading-none">{value}</span>
    </span>
  );
}

function OkMark({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full bg-[rgba(23,178,106,.16)] text-[#0f7a47]" style={{ width: size, height: size }}>
      <Check size={Math.round(size * 0.55)} strokeWidth={3} />
    </span>
  );
}

function CellMark({ value }: { value: StatusValue | undefined }) {
  if (value === "has") return <OkMark />;
  if (value === "partial") return <span className="inline-block rounded-full bg-[rgba(59,124,246,.15)] px-2 py-px text-[11px] font-semibold text-[#2a5fd0]">Partial</span>;
  if (value === "missing") return <span className="font-semibold text-[#5b6c85]">—</span>;
  return <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-[#9aa8be]" />;
}

type Stance = "missing" | "partial" | "level" | "ahead" | "none";
function stanceOf(theirs: StatusValue | undefined, ours: StatusValue): Stance {
  const t = theirs ?? "unknown";
  if (t === "has" || t === "partial") {
    if (ours === "missing") return "missing";
    if (ours === "partial" && t === "has") return "partial";
    return "level";
  }
  if (t === "missing" && ours !== "missing") return "ahead";
  return "none";
}
const STANCE_LABEL: Record<Stance, { text: (org: string) => string; cls: string }> = {
  missing: { text: (o) => `${o} missing`, cls: "font-semibold text-[#c23767]" },
  partial: { text: (o) => `${o} partial`, cls: "font-semibold text-[#2a5fd0]" },
  level: { text: () => "Level", cls: "text-[#4a5b74]" },
  ahead: { text: (o) => `${o} ahead`, cls: "font-semibold text-[#0f7a47]" },
  none: { text: () => "No signal", cls: "text-fg-faint" },
};

/**
 * Risk vs the org, from the matrix alone: the share of capabilities with a
 * signal where the competitor is ahead (has/partial while the org is missing,
 * or has while the org is partial). Deterministic; no opinion involved.
 */
export function riskOf(capabilities: CapabilityRow[], cellOf: (capabilityId: string) => CellRow | undefined): { score: number; level: "high" | "medium" | "low"; behind: number; total: number } | null {
  let behind = 0;
  let total = 0;
  for (const k of capabilities) {
    const s = stanceOf(cellOf(k.id)?.value, k.ourStatus);
    if (s === "none") continue;
    total++;
    if (s === "missing" || s === "partial") behind++;
  }
  if (total === 0) return null;
  const score = Math.round((behind / total) * 100);
  return { score, level: score >= 50 ? "high" : score >= 25 ? "medium" : "low", behind, total };
}

/** Media store URL for a stored path (lib/competitors/media.ts serves it). */
const mediaUrl = (rel: string) => `/api/competitors/media?p=${encodeURIComponent(rel)}`;

export function ProfilePanel({ org, competitors, selectedId, onSelect, domains, capabilities, cellOf, facts, onPatchFact, onAddFact, onPatchStatus }: {
  org: string;
  competitors: CompetitorRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  domains: DomainRow[];
  capabilities: CapabilityRow[];
  cellOf: (competitorId: string | null | undefined, capabilityId: string) => CellRow | undefined;
  facts: FactRow[];
  onPatchFact: (id: string, body: unknown) => Promise<boolean>;
  onAddFact: (competitorId: string, kind: string, value: string) => Promise<boolean>;
  onPatchStatus: (cellId: string, body: unknown) => Promise<boolean>;
}) {
  const selected = competitors.find((c) => c.id === selectedId) ?? competitors[0] ?? null;
  useEffect(() => {
    if (!selectedId && competitors[0]) onSelect(competitors[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, competitors.length]);

  if (competitors.length === 0) {
    return (
      <div className="glass rounded-card px-10 py-16 text-center">
        <div className="font-title mb-1 text-[16px] font-bold">{C.profile.emptyTitle}</div>
        <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">{C.profile.emptyBody}</div>
      </div>
    );
  }
  if (!selected) return null;
  const myFacts = facts.filter((f) => f.competitorId === selected.id);
  const sourcesCount = selected.sources.filter((s) => s.lastScanAt).length;
  const captures = selected.media.length;
  const scanAgo = selected.lastAnyScanAt ? timeAgo(selected.lastAnyScanAt) : null;

  return (
    <section aria-label={C.tabs.profiles} className="flex flex-col gap-3.5">
      {/* Competitor chips */}
      <div role="group" aria-label="Choose a competitor" className="flex flex-wrap items-center gap-1.5">
        {competitors.map((c) => {
          const on = c.id === selected.id;
          return (
            <button key={c.id} onClick={() => onSelect(c.id)} aria-pressed={on}
              className={cn("inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-semibold shadow-sm", on ? "border-transparent bg-primary text-white shadow-[0_6px_16px_-6px_var(--app-accent)]" : "border-border bg-[var(--app-glass)] text-[#3f506b] hover:border-primary/55 hover:bg-white")}>
              <Logo c={c} size={18} className={cn(on && "border-white/30")} />
              {c.name}
            </button>
          );
        })}
        <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-fg-faint">
          {scanAgo ? `Last scan ${scanAgo}` : C.profile.neverScanned} · {sourcesCount} source{sourcesCount === 1 ? "" : "s"} · {captures} UI capture{captures === 1 ? "" : "s"}
        </span>
      </div>

      <Header c={selected} org={org} facts={myFacts} capabilities={capabilities} cellOf={cellOf} onPatchFact={onPatchFact} onAddFact={onAddFact} />
      <Timeline c={selected} facts={myFacts} />

      <div className="flex flex-wrap items-start gap-3.5">
        <Capabilities c={selected} org={org} domains={domains} capabilities={capabilities} cellOf={cellOf} onPatchStatus={onPatchStatus} />
        <aside aria-label="Profile details" className="flex min-w-0 flex-[1_1_300px] flex-col gap-3.5">
          <WhatChanged c={selected} capabilities={capabilities} cellOf={cellOf} facts={myFacts} />
          <Gallery c={selected} />
          <Sources c={selected} />
        </aside>
      </div>
    </section>
  );
}

// ————— Header: identity facts, risk vs the org, fact grid, every fact (editable) —————

function Header({ c, org, facts, capabilities, cellOf, onPatchFact, onAddFact }: {
  c: CompetitorRow; org: string; facts: FactRow[]; capabilities: CapabilityRow[];
  cellOf: (competitorId: string | null | undefined, capabilityId: string) => CellRow | undefined;
  onPatchFact: (id: string, body: unknown) => Promise<boolean>;
  onAddFact: (competitorId: string, kind: string, value: string) => Promise<boolean>;
}) {
  const [showFacts, setShowFacts] = useState(false);
  const [editingFact, setEditingFact] = useState<string | null>(null);
  const [factValue, setFactValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState("product");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const tagline = facts.find((f) => f.kind === "tagline");
  const ofKind = (k: string) => facts.filter((f) => f.kind === k);
  const join = (vals: string[], max = 5) => (vals.length ? `${vals.slice(0, max).join(" · ")}${vals.length > max ? ` · +${vals.length - max}` : ""}` : "—");
  // Fact grid: one card per kind, the values joined, the source line from the
  // facts' own source label (the scan names its source type).
  const card = (label: string, kind: string) => {
    const rows = ofKind(kind);
    const first = rows[0];
    return { label, value: join(rows.map((f) => f.value)), source: first?.sourceLabel ?? (first ? C.profile.website : "—"), tone: rows.find((f) => f.tone)?.tone ?? null };
  };
  const grid = [
    card(C.profile.kinds.funding, "funding"), card(C.profile.kinds.headcount, "headcount"), card(C.profile.kinds.hiring, "hiring"), card(C.profile.kinds.vertical, "vertical"),
    card(C.profile.kinds.certification, "certification"), card(C.profile.kinds.integration, "integration"), card(C.profile.kinds.customer, "customer"), card(C.profile.kinds.pricingTier, "pricingTier"),
  ].filter((g, i) => g.value !== "—" || i >= 3);
  // Identity line from the company facts (ownership, HQ, founded, headcount) when the pages stated them.
  const one = (k: string) => ofKind(k)[0]?.value ?? null;
  const founded = one("founded");
  const about = [one("ownership"), one("hq"), founded ? `founded ${founded}` : null, one("headcount")].filter(Boolean).join(" · ");
  const risk = riskOf(capabilities, (id) => cellOf(c.id, id));
  const riskColor = risk?.level === "high" ? "#c23767" : risk?.level === "medium" ? "#f0b43c" : "#17b26a";

  async function submitFact() {
    if (!newValue.trim()) return;
    setBusy(true);
    const ok = await onAddFact(c.id, newKind, newValue.trim());
    setBusy(false);
    if (ok) { setNewValue(""); setAdding(false); }
  }

  return (
    <section className="glass flex flex-col gap-4 rounded-card px-[18px] py-4">
      <div className="flex flex-wrap items-start gap-4">
        <Logo c={c} size={48} />
        <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
          <span className="flex flex-wrap items-baseline gap-2.5">
            <h2 className="font-title m-0 text-[20px] font-bold tracking-[-0.01em]">{c.name}</h2>
            <a href={c.websiteUrl} target="_blank" rel="noreferrer" className="text-[12px] text-primary hover:underline">{c.host}</a>
          </span>
          {about ? <span className="text-[12.5px] text-fg-3">{about}</span> : tagline ? <span className="text-[12.5px] italic text-fg-3">“{tagline.value}”</span> : <span className="text-[12.5px] text-fg-faint">—</span>}
          {about && tagline && <span className="text-[12.5px] italic text-fg-3">“{tagline.value}”</span>}
        </div>
        {risk && (
          <div className="flex items-center gap-3 rounded-[12px] border border-border bg-[rgba(255,255,255,.72)] py-2 pl-2 pr-3.5" title={`${risk.behind} of ${risk.total} capabilities with a signal where ${org} is behind`}>
            <Ring value={risk.score} color={riskColor} />
            <span className="flex flex-col gap-0.5">
              <span className={cn("inline-flex self-start rounded-full border px-2.5 py-px text-[12px] font-semibold", PILL[risk.level])}>{risk.level === "high" ? "High risk" : risk.level === "medium" ? "Medium" : "Low"}</span>
              <span className="text-[10.5px] text-fg-muted">Ahead of {org} on {risk.behind} of {risk.total} capabilities</span>
            </span>
          </div>
        )}
      </div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {grid.map((f) => (
          <div key={f.label} className={CARD}>
            <span className={EB}>{f.label}</span>
            <span className={cn("text-[13px] font-semibold", f.value === "—" && "text-fg-faint")}>{f.value}</span>
            <span className={cn("text-[11px]", f.tone === "warn" ? "text-[#8a5a00]" : "text-fg-muted")}>{f.source}</span>
          </div>
        ))}
      </div>
      {/* Every fact the scans found — editable, as in story 2 */}
      <div className="border-t border-border pt-3">
        <button onClick={() => setShowFacts((v) => !v)} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg-3 hover:text-foreground">
          {showFacts ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {C.profile.facts} · {facts.length}
        </button>
        {showFacts && (
          <div className="mt-3">
            <div className="mb-3 flex items-center gap-2">
              {!adding ? (
                <Button size="sm" onClick={() => setAdding(true)}><Plus size={12} /> {C.profile.addFact}</Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); if (e.key === "Enter") { e.preventDefault(); void submitFact(); } }}>
                  <select value={newKind} onChange={(e) => setNewKind(e.target.value)} className="h-8 rounded-control border border-border bg-white px-2 text-[12.5px]" aria-label={C.profile.addFactKind}>
                    {FACT_KINDS.map((k) => <option key={k} value={k}>{C.profile.kinds[k] ?? k}</option>)}
                  </select>
                  <input autoFocus value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={C.profile.addFactPlaceholder} maxLength={80} aria-label={C.profile.addFactValue} className="h-8 w-72 rounded-control border border-border bg-white px-3 text-[13px] outline-none focus:border-primary" />
                  <Button size="sm" onClick={() => setAdding(false)} disabled={busy}>{C.cell.cancel}</Button>
                  <Button size="sm" variant="primary" onClick={submitFact} disabled={busy || !newValue.trim()}>{C.profile.addFactSave}</Button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] md:grid-cols-3">
              {FACT_KINDS.filter((k) => k !== "tagline").map((kind) => {
                const rows = facts.filter((f) => f.kind === kind);
                return (
                  <div key={kind}>
                    <div className={cn(EB, "mb-1")}>{C.profile.kinds[kind]}</div>
                    {rows.length === 0 ? <div className="text-fg-faint">—</div> : (
                      <ul className="space-y-0.5">
                        {rows.map((f) => (
                          <li key={f.id} className="group flex items-center gap-1.5">
                            {editingFact === f.id ? (
                              <input autoFocus value={factValue} onChange={(e) => setFactValue(e.target.value)}
                                onKeyDown={async (e) => { if (e.key === "Escape") setEditingFact(null); if (e.key === "Enter") { e.preventDefault(); if (await onPatchFact(f.id, { value: factValue })) setEditingFact(null); } }}
                                className="w-full rounded-[6px] border border-border px-1.5 py-0.5 text-[12.5px] outline-none focus:border-primary" />
                            ) : (
                              <>
                                <span className={cn("min-w-0 truncate", f.override && "text-[#8a5a00]", (f.stale || f.unreachable) && "text-fg-muted")} title={f.value}>{f.value}</span>
                                {f.factDate && <span className="shrink-0 text-[11px] text-fg-muted">{f.factDate.slice(0, 4)}</span>}
                                {f.sourceUrl && <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="shrink-0 text-fg-faint hover:text-primary" title={f.sourceUrl}><ExternalLink size={10} /></a>}
                                {f.manual && <Kind className="!text-[9px]">{C.profile.manual}</Kind>}
                                {f.unreachable && <span className="shrink-0 rounded-full bg-[rgba(239,90,138,.12)] px-1.5 py-px font-mono text-[9px] text-[#c23767]" title={C.profile.unreachableTip}>{C.profile.unreachable}</span>}
                                {f.stale && !f.unreachable && <span className="shrink-0 rounded-full bg-[#fff7e0] px-1.5 py-px font-mono text-[9px] text-[#8a5a00]" title={C.profile.staleTip}>{C.profile.stale}</span>}
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
        )}
      </div>
    </section>
  );
}

// ————— Timeline: the dated facts —————

interface TimelineEvent { key: string; date: string; title: string; type: EventType; sourceUrl: string | null }

function Timeline({ c, facts }: { c: CompetitorRow; facts: FactRow[] }) {
  const events = useMemo<TimelineEvent[]>(
    () => facts
      .filter((f) => f.factDate)
      .map((f) => ({ key: f.id, date: f.factDate as string, title: f.kind === "founded" ? "Founded" : f.value, type: eventTypeOf(f.kind), sourceUrl: f.sourceUrl }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [facts],
  );
  const [filter, setFilterState] = useState<EventType | "all">("all");
  const setFilter = (f: EventType | "all") => {
    setFilterState(f);
    track("cmp_profile_timeline_filtered", { competitorId: c.id, type: f });
  };
  if (events.length === 0) {
    return (
      <section className="glass flex flex-col gap-2 rounded-card px-[18px] py-4" aria-label="Company timeline">
        <span className="text-[14px] font-bold">Timeline</span>
        <span className="text-[12.5px] text-fg-3">No dated facts yet — funding rounds, acquisitions and launches appear here once a source states their dates.</span>
      </section>
    );
  }
  const first = new Date(events[0].date).getFullYear();
  const last = Math.max(new Date(events[events.length - 1].date).getFullYear(), new Date().getFullYear());
  const span = Math.max(1, last - first + 1);
  const x = (iso: string) => {
    const d = new Date(iso);
    return 2 + ((d.getFullYear() + d.getMonth() / 12 - first) / span) * 94;
  };
  const todayX = Math.min(96, x(new Date().toISOString()));
  const shown = events.filter((e) => filter === "all" || e.type === filter);
  const types = (Object.keys(TL_LABEL) as EventType[]).filter((t) => events.some((e) => e.type === t));
  const years: number[] = [];
  const step = span > 12 ? 3 : span > 6 ? 2 : 1;
  for (let y = first; y <= last; y += step) years.push(y);
  return (
    <section className="glass flex flex-col gap-2.5 rounded-card px-[18px] py-4" aria-label="Company timeline">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-2.5 flex flex-col gap-0.5">
          <span className="text-[14px] font-bold">Timeline</span>
          <span className="text-[11px] text-fg-muted">{first} → today · not to scale · dated facts from the competitor's sources</span>
        </span>
        <TlChip on={filter === "all"} onClick={() => setFilter("all")}>All · {events.length}</TlChip>
        {types.map((t) => (
          <TlChip key={t} on={filter === t} onClick={() => setFilter(t)}>
            <span className="h-2 w-2 rounded-full" style={{ background: TL_COLOR[t] }} />
            {TL_LABEL[t]} · {events.filter((e) => e.type === t).length}
          </TlChip>
        ))}
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="relative mx-14 h-[222px] min-w-[760px]">
          <span className="absolute left-0 top-[96px] h-[2px] bg-[#c8d4e8]" style={{ width: `${todayX}%` }} />
          <span className="absolute top-[72px] h-[50px] w-[2px] -translate-x-1/2 bg-primary" style={{ left: `${todayX}%` }} />
          <span className="absolute top-[56px] -translate-x-1/2 rounded-full bg-primary px-[7px] py-px text-[10px] font-semibold text-white" style={{ left: `${todayX}%` }}>Today</span>
          {years.map((y) => (
            <span key={y} className="absolute top-[204px] -translate-x-1/2 text-[10px] text-fg-faint" style={{ left: `${2 + ((y - first) / span) * 94}%` }}>{y}</span>
          ))}
          {shown.map((e, i) => {
            const above = i % 2 === 0;
            const color = TL_COLOR[e.type];
            const dot = <span className="h-3.5 w-3.5 rounded-full border-2 border-white" style={{ background: color, boxShadow: `0 0 0 1px ${color}` }} />;
            const when = e.date.length > 7 ? `${new Date(e.date).getUTCFullYear()} ${new Date(e.date).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}` : e.date.slice(0, 4);
            const card = (
              <span className="rounded-[8px] border border-border bg-[rgba(255,255,255,.92)] px-2 py-1 text-center text-[11px] leading-[1.3] text-[#1f2f47]">
                <b className="block font-semibold">{e.title}</b>
                {when} · {TL_LABEL[e.type].toLowerCase()}
              </span>
            );
            const body = above ? <>{card}<span className="h-3.5 w-px bg-[#c8d4e8]" />{dot}</> : <>{dot}<span className="h-3.5 w-px bg-[#c8d4e8]" />{card}</>;
            const cls = cn("absolute flex w-[120px] -translate-x-1/2 flex-col items-center gap-1", above ? "top-0 h-[104px] justify-end" : "top-[90px] h-[104px]");
            return e.sourceUrl
              ? <a key={e.key} href={e.sourceUrl} target="_blank" rel="noreferrer" className={cn(cls, "hover:opacity-80")} style={{ left: `${x(e.date)}%` }} title={e.sourceUrl}>{body}</a>
              : <div key={e.key} className={cls} style={{ left: `${x(e.date)}%` }}>{body}</div>;
          })}
        </div>
      </div>
    </section>
  );
}

function TlChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={cn("inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] font-semibold", on ? "border-transparent bg-primary text-white" : "border-border bg-[var(--app-glass)] text-[#3f506b] hover:border-primary/55 hover:bg-white")}>
      {children}
    </button>
  );
}

// ————— Capabilities by domain and product, with the deep dive —————

function Capabilities({ c, org, domains, capabilities, cellOf, onPatchStatus }: {
  c: CompetitorRow; org: string; domains: DomainRow[]; capabilities: CapabilityRow[];
  cellOf: (competitorId: string | null | undefined, capabilityId: string) => CellRow | undefined;
  onPatchStatus: (cellId: string, body: unknown) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const stance = (k: CapabilityRow) => stanceOf(cellOf(c.id, k.id)?.value, k.ourStatus);
  const counts = { ahead: 0, level: 0, behind: 0 };
  for (const k of capabilities) {
    const s = stance(k);
    if (s === "missing" || s === "partial") counts.ahead++;
    else if (s === "level") counts.level++;
    else if (s === "ahead") counts.behind++;
  }
  // The competitor's products are the names the pages gave for its capabilities.
  const productOf = (k: CapabilityRow): string | null => cellOf(c.id, k.id)?.product ?? null;
  const products = [...new Set(capabilities.map(productOf).filter((p): p is string => Boolean(p)))].sort();

  const row = (k: CapabilityRow, indent: number) => {
    const cell = cellOf(c.id, k.id);
    const s = stance(k);
    const isOpen = open === k.id;
    return (
      <div key={k.id} className={cn(isOpen && "bg-[rgba(36,87,245,.05)] shadow-[inset_3px_0_0_#2457f5]")}>
        <button onClick={() => { setOpen(isOpen ? null : k.id); if (!isOpen) track("cmp_capability_dive_opened", { competitorId: c.id, capabilityId: k.id, value: cell?.value ?? "unknown", hasHistory: (cell?.history.length ?? 0) > 0 }); }} className="flex h-11 w-full items-center gap-3 border-b border-border pr-4 text-left hover:bg-white/70" style={{ paddingLeft: indent }}>
          <span className={cn("min-w-0 flex-1 text-[13px]", isOpen ? "font-semibold" : "font-medium text-[#1f2f47]")}>{k.name}</span>
          <CellMark value={cell?.value} />
          <span className={cn("w-[120px] text-[11.5px]", STANCE_LABEL[s].cls)}>{STANCE_LABEL[s].text(org)}</span>
          <span className="w-[110px] text-[11px] text-fg-muted">{cell?.changedAt ? `Changed ${shortDate(cell.changedAt)}` : cell ? "No change" : "No signal"}</span>
          {isOpen ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
        </button>
        {isOpen && <DeepDive org={org} k={k} cell={cell} onPatchStatus={onPatchStatus} indent={indent} />}
      </div>
    );
  };

  return (
    <section className="glass min-w-0 flex-[2_1_560px] overflow-hidden rounded-card">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5" style={{ background: "linear-gradient(90deg, rgba(36,87,245,.14), rgba(255,255,255,0) 60%)" }}>
        <span className="h-2.5 w-2.5 rounded-[3px] bg-primary shadow-[0_0_10px_rgba(36,87,245,.6)]" />
        <span className="text-[14px] font-bold">Capabilities</span>
        <span className="text-[11px] text-fg-muted">{domains.length} domains · {products.length} product{products.length === 1 ? "" : "s"} · {capabilities.length} capabilities</span>
        <span className="ml-auto text-[12px] text-fg-3">vs {org}: <b className="font-semibold text-[#c23767]">ahead on {counts.ahead}</b> · level on {counts.level} · <b className="font-semibold text-[#0f7a47]">behind on {counts.behind}</b></span>
      </div>
      {capabilities.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-fg-3">{C.matrix.noCatalogTitle}</div>}
      {domains.map((d) => {
        const rows = capabilities.filter((k) => k.domainId === d.id);
        if (rows.length === 0) return null;
        const color = swatchColor(d.color, PRODUCT_CHIP_DEFAULT);
        const behind = rows.filter((k) => ["missing", "partial"].includes(stance(k))).length;
        const partial = rows.filter((k) => stance(k) === "partial").length;
        const ahead = rows.filter((k) => stance(k) === "ahead").length;
        const level = rows.filter((k) => stance(k) === "level").length;
        const prods = products.filter((p) => rows.some((k) => productOf(k) === p));
        const orphan = rows.filter((k) => !productOf(k));
        const isCollapsed = collapsed[d.id];
        return (
          <div key={d.id}>
            <button onClick={() => setCollapsed((p) => ({ ...p, [d.id]: !p[d.id] }))} className="flex w-full items-center gap-3 border-b border-border px-4 py-2 text-left" style={{ background: `linear-gradient(90deg, ${color}24, rgba(255,255,255,0) 60%)` }}>
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color, boxShadow: `0 0 10px ${color}99` }} />
              <span className="text-[13px] font-bold">{d.name}</span>
              <span className="text-[11px] text-fg-muted">domain · {prods.length} product{prods.length === 1 ? "" : "s"} · {rows.length} capabilit{rows.length === 1 ? "y" : "ies"}{prods.length ? ` · ${prods.join(", ")}` : ""}</span>
              <span className="ml-auto flex items-center gap-[18px] text-[12px]">
                {behind > 0 && <span className="font-semibold text-[#c23767]">{org} behind on {behind}</span>}
                {partial > 0 && <span className="font-semibold text-[#2a5fd0]">partial on {partial}</span>}
                {level > 0 && <span className="font-semibold text-fg-3">level on {level}</span>}
                {ahead > 0 && <span className="font-semibold text-[#0f7a47]">ahead on {ahead}</span>}
                {isCollapsed ? <ChevronRight size={14} className="text-fg-muted" /> : <ChevronDown size={14} className="text-fg-muted" />}
              </span>
            </button>
            {!isCollapsed && (
              <>
                {prods.map((p) => {
                  const inProduct = rows.filter((k) => productOf(k) === p);
                  return (
                    <div key={p}>
                      <div className="flex items-center gap-2.5 border-b border-border bg-[rgba(255,255,255,.55)] py-[7px] pl-7 pr-4">
                        <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] bg-[rgba(217,72,15,.14)] px-1 text-[9px] font-bold text-[#a63a07]">{initialsOf(p)}</span>
                        <span className="text-[13px] font-semibold">{p}</span>
                        <span className="text-[11px] text-fg-muted">product · {inProduct.length} capabilit{inProduct.length === 1 ? "y" : "ies"}</span>
                      </div>
                      {inProduct.map((k) => row(k, 44))}
                    </div>
                  );
                })}
                {orphan.length > 0 && prods.length > 0 && (
                  <div className="flex items-center gap-2.5 border-b border-border bg-[rgba(255,255,255,.55)] py-[7px] pl-7 pr-4">
                    <span className="h-[22px] w-[22px] rounded-[6px] border border-dashed border-[#9aa8be]" />
                    <span className="text-[13px] font-semibold text-fg-3">No product named</span>
                    <span className="text-[11px] text-fg-muted">the pages do not say which product provides these</span>
                  </div>
                )}
                {orphan.map((k) => row(k, prods.length > 0 ? 44 : 28))}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function DeepDive({ org, k, cell, onPatchStatus, indent }: {
  org: string; k: CapabilityRow; cell: CellRow | undefined;
  onPatchStatus: (cellId: string, body: unknown) => Promise<boolean>; indent: number;
}) {
  const [flagging, setFlagging] = useState(false);
  const [busy, setBusy] = useState(false);
  async function setValue(v: StatusValue) {
    if (!cell) return;
    setBusy(true);
    await onPatchStatus(cell.id, { value: v, note: "Flagged from the profile", surface: "profile" });
    setBusy(false);
    setFlagging(false);
  }
  const standing = k.ourStatus === "has" ? "has" : k.ourStatus === "partial" ? "partial" : "missing";
  const host = (u: string) => u.replace(/^https?:\/\//, "").slice(0, 70);
  return (
    <div className="flex flex-col gap-3.5 border-b border-border pb-4 pr-4 pt-0.5" style={{ paddingLeft: indent }}>
      {/* Evidence: the quote the scan kept, and where it is */}
      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline gap-2"><span className={EB}>Evidence</span><span className="text-[10.5px] text-fg-faint">{cell?.sourceUrl ? "quoted from the competitor's pages" : ""}</span></span>
        {cell?.quote ? (
          <>
            <blockquote className="m-0 border-l-2 border-border pl-2.5 text-[13px] italic leading-[1.55] text-[#1f2f47]">“{cell.quote}”</blockquote>
            {cell.sourceUrl && <a href={cell.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"><ExternalLink size={11} /> {host(cell.sourceUrl)}</a>}
          </>
        ) : (
          <span className="text-[12.5px] text-fg-faint">{C.cell.noEvidence}</span>
        )}
      </div>
      {cell && (cell.confidence != null || cell.product || cell.override) && (
        <div className="flex flex-wrap gap-2.5">
          {cell.product && <span className={cn(CARD, "min-w-[150px] flex-1")}><span className={EB}>Product</span><span className="text-[12.5px] font-semibold">{cell.product}</span></span>}
          {cell.confidence != null && <span className={cn(CARD, "min-w-[150px] flex-1")}><span className={EB}>Confidence</span><span className="text-[12.5px] font-semibold">{Math.round(cell.confidence * 100)}%</span></span>}
          {cell.override && <span className={cn(CARD, "min-w-[150px] flex-1")}><span className={EB}>Corrected</span><span className="text-[12.5px] font-semibold text-[#8a5a00]">{C.matrix.editedBy(cell.override.userName ?? "a PM", shortDate(cell.override.at))} · scan said {C.values[cell.scannedValue]}</span></span>}
        </div>
      )}
      {cell && cell.history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={EB}>History · {cell.history.length}</span>
          {cell.history.map((h, i) => (
            <span key={i} className="flex items-center gap-2.5 rounded-[9px] border border-border bg-[rgba(255,255,255,.72)] px-2.5 py-2">
              <Kind>{C.values[h.value]}</Kind>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{h.quote ? `“${h.quote}”` : "—"}</span>
              {h.sourceUrl && <a href={h.sourceUrl} target="_blank" rel="noreferrer" className="shrink-0 text-fg-faint hover:text-primary" title={h.sourceUrl}><ExternalLink size={10} /></a>}
              <span className="text-[11px] text-fg-muted">until {shortDate(h.at)}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-[rgba(255,255,255,.72)] px-3.5 py-2.5">
        <span className="text-[12px] text-fg-3">
          Where {org} stands: <b className={cn("font-semibold", standing === "missing" ? "text-[#8a5a00]" : standing === "partial" ? "text-[#2a5fd0]" : "text-[#0f7a47]")}>{standing}</b>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span title="Roadmap integration arrives with its own story"><Button size="sm" disabled><Lightbulb size={12} /> Attach to idea</Button></span>
          {cell && !flagging && <Button size="sm" variant="ghost" onClick={() => setFlagging(true)}><Flag size={12} /> Flag as wrong</Button>}
          {cell && flagging && (
            <span className="inline-flex items-center gap-1">
              <span className="text-[11.5px] text-fg-muted">Set to</span>
              {STATUS_VALUES.map((v) => <button key={v} disabled={busy} onClick={() => void setValue(v)} className={cn("rounded-full border px-2 py-0.5 text-[11.5px] font-semibold", cell.value === v ? "border-transparent bg-primary text-white" : "border-border bg-white text-fg-3 hover:border-primary/55")}>{C.values[v]}</button>)}
              <button onClick={() => setFlagging(false)} className="rounded p-1 text-fg-muted hover:text-foreground" aria-label="Cancel"><X size={12} /></button>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// ————— Side column —————

function WhatChanged({ c, capabilities, cellOf, facts }: { c: CompetitorRow; capabilities: CapabilityRow[]; cellOf: (competitorId: string | null | undefined, capabilityId: string) => CellRow | undefined; facts: FactRow[] }) {
  const since = Date.now() - 30 * 86_400_000;
  const items: { title: string; source: string; date: string; impact: "high" | "medium" | "low"; at: number }[] = [];
  for (const k of capabilities) {
    const cell = cellOf(c.id, k.id);
    if (cell?.changedAt && new Date(cell.changedAt).getTime() > since) items.push({ title: `${k.name}: now ${C.values[cell.value].toLowerCase()}`, source: C.profile.website, date: shortDate(cell.changedAt), impact: cell.value === "has" && k.ourStatus !== "has" ? "high" : "medium", at: new Date(cell.changedAt).getTime() });
  }
  for (const f of facts) {
    if (f.changedAt && new Date(f.changedAt).getTime() > since && !f.manual) items.push({ title: `${C.profile.kinds[f.kind] ?? f.kind}: ${f.value}`, source: f.sourceLabel ?? C.profile.website, date: shortDate(f.changedAt), impact: "low", at: new Date(f.changedAt).getTime() });
  }
  items.sort((a, b) => b.at - a.at);
  const shown = items.slice(0, 8);
  return (
    <section className="glass overflow-hidden rounded-card">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5" style={{ background: "linear-gradient(90deg, rgba(91,108,133,.14), rgba(255,255,255,0) 60%)" }}>
        <span className="h-2.5 w-2.5 rounded-[3px] bg-[#5b6c85]" />
        <span className="text-[14px] font-bold">What changed · 30 days</span>
        <span className="text-[11px] text-fg-muted">{items.length} signal{items.length === 1 ? "" : "s"}</span>
      </div>
      {shown.length === 0 && <div className="px-4 py-6 text-center text-[12.5px] text-fg-3">Nothing changed in the last 30 days.</div>}
      {shown.map((s, i) => (
        <div key={i} className="flex h-12 items-center gap-3.5 border-b border-border px-4 last:border-b-0 hover:bg-white/70">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12.5px] font-semibold">{s.title}</span>
            <span className="truncate text-[11.5px] text-fg-muted">{s.source} · {s.date}</span>
          </span>
          <span className={cn("inline-flex rounded-full border px-2.5 py-px text-[11px] font-semibold", PILL[s.impact])}>{s.impact[0].toUpperCase() + s.impact.slice(1)}</span>
        </div>
      ))}
    </section>
  );
}

function Gallery({ c }: { c: CompetitorRow }) {
  const [all, setAll] = useState(false);
  const items = c.media;
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 4);
  return (
    <section className="glass flex flex-col gap-2.5 rounded-card px-4 py-3.5">
      <span className="flex items-baseline gap-2">
        <span className="text-[14px] font-bold">UI gallery</span>
        <span className="text-[11px] text-fg-muted">{items.length} capture{items.length === 1 ? "" : "s"}</span>
        {items.length > 4 && <button onClick={() => setAll((v) => !v)} className="ml-auto text-[12px] font-semibold text-primary hover:underline">{all ? "Fewer" : "All"}</button>}
      </span>
      <div className="grid grid-cols-2 gap-2">
        {shown.map((g) => (
          <a key={g.id} href={mediaUrl(g.mediaPath)} target="_blank" rel="noreferrer" onClick={() => track("cmp_media_opened", { competitorId: c.id, capabilityId: null, kind: g.kind })} className="group flex flex-col gap-1">
            <span className="block h-[84px] overflow-hidden rounded-[9px] border border-border bg-white"><img src={mediaUrl(g.mediaPath)} alt={g.label} className="h-full w-full object-cover object-top transition group-hover:scale-[1.02]" /></span>
            <span className="truncate text-[11px] text-fg-muted">{g.label}{g.sourceLabel ? ` · ${g.sourceLabel}` : ""}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function Sources({ c }: { c: CompetitorRow }) {
  const items = c.sources.filter((s) => s.lastScanAt);
  const last = c.lastAnyScanAt;
  return (
    <section className="glass flex flex-col gap-2.5 rounded-card px-4 py-3.5">
      <span className="flex items-baseline gap-2"><span className="text-[14px] font-bold">Sources</span><span className="text-[11px] text-fg-muted">{items.length ? `${items.length} · last scan ${last ? timeAgo(last) : ""}` : "no scan yet"}</span></span>
      {items.length === 0 ? <span className="text-[12.5px] text-fg-faint">—</span> : (
        <span className="flex flex-wrap gap-1.5">{items.map((s) => <Kind key={s.id}><span title={s.url}>{C.profile.sourceTypes[s.type] ?? s.type} · {s.pages} page{s.pages === 1 ? "" : "s"}</span></Kind>)}</span>
      )}
    </section>
  );
}
