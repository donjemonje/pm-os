"use client";

import { useState } from "react";
import { Check, CheckCheck, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { Ring } from "@/components/ui/Ring";
import { initialsOf } from "@/components/ui/Avatar";

type Tab = "parity" | "feed" | "profiles" | "cards" | "roadmap";

const TABS: { key: Tab; label: string }[] = [
  { key: "parity", label: "Parity matrix" },
  { key: "feed", label: "News feed" },
  { key: "profiles", label: "Profiles" },
  { key: "cards", label: "Battle cards" },
  { key: "roadmap", label: "Roadmap" },
];

/** The matrix legend's three cell states — also the Status filter's options. */
const CELL_STATES = ["Has it", "Partial", "Missing"];
const IMPACTS = ["High", "Medium", "Low"];

function chipClass(active: boolean): string {
  return active
    ? "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-primary px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_-6px_var(--app-accent)]"
    : "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-[var(--app-glass)] px-3 text-[12.5px] font-semibold text-[#3f506b] shadow-sm hover:border-primary/55 hover:bg-white";
}

function toggleIn(setter: React.Dispatch<React.SetStateAction<string[]>>) {
  return (o: string) =>
    setter((prev) => (prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]));
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

/** KPI card of the summary strip — the Ideas stat card with a colored top rule. */
function StatCard({ label, tone, toneFg, sub }: { label: string; tone: string; toneFg: string; sub: string }) {
  return (
    <div className="relative flex min-w-[132px] flex-[0.55] flex-col gap-0.5 overflow-hidden rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: tone }} />
      <span className="flex items-baseline gap-2">
        <span className="font-title text-2xl font-bold leading-none text-fg-faint">—</span>
        <span className="font-mono text-[10px] font-medium tracking-[0.04em]" style={{ color: toneFg }}>
          {label}
        </span>
      </span>
      <span className="mt-1 text-[11.5px] text-fg-muted">{sub}</span>
    </div>
  );
}

function OkMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-[rgba(23,178,106,.16)] text-[#0f7a47]"
      style={{ width: size, height: size }}
    >
      <Check size={Math.round(size * 0.55)} strokeWidth={3} />
    </span>
  );
}

/**
 * The Competitors page (design of record: C2, full-screen matrix). Story 1
 * is the layout only: zero competitors, every count and panel empty. The org's
 * own name and product lines are the only real data on it.
 */
export function CompetitorsView({
  orgName,
  catalogProducts = [],
}: {
  orgName: string;
  catalogProducts?: string[];
}) {
  const own = orgName.trim() || "Your organization";
  const [tab, setTab] = useState<Tab>("parity");

  // Parity matrix filters
  const [capQuery, setCapQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<string[]>([]);
  const [productFilter, setProductFilter] = useState<string[]>([]);
  const [competitorFilter, setCompetitorFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [newChanges, setNewChanges] = useState(false);

  // News feed filters
  const [signalQuery, setSignalQuery] = useState("");
  const [feedCompetitor, setFeedCompetitor] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [impactFilter, setImpactFilter] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);

  return (
    <div className="app-canvas font-title min-h-full">
      <div className="mx-auto w-full max-w-[1680px] px-7 pb-24 pt-6">
        {/* Header + tabs */}
        <header className="mb-4 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-3.5">
            <h1 className="font-title m-0 text-[26px] font-bold leading-none tracking-[-0.02em]">
              Competitors
            </h1>
            <span className="ml-1.5 text-[11px] text-fg-faint">0 competitors · 0 sources · not scanned yet</span>
          </div>
          <div
            role="tablist"
            aria-label="Competitor views"
            className="flex flex-wrap gap-1.5 border-b border-border pb-3"
          >
            {TABS.map(({ key, label }) => {
              const on = tab === key;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(key)}
                  className={`font-title inline-flex h-8 items-center whitespace-nowrap rounded-control border px-4 text-[13px] font-semibold transition-[background,box-shadow] ${
                    on
                      ? "border-transparent bg-primary text-white shadow-[0_6px_18px_-6px_rgba(36,87,245,.8)]"
                      : "border-border bg-[var(--app-glass)] text-fg-3 shadow-sm hover:border-primary/55 hover:bg-white"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </header>

        {tab === "parity" && (
          <section aria-label="Parity matrix" className="flex flex-col">
            {/* Summary strip */}
            <div className="glass-weak mb-4 flex flex-wrap items-stretch gap-3 rounded-card p-3">
              <div className="flex min-w-[280px] items-center gap-3.5 py-1.5 pl-1.5 pr-3.5">
                <span className="relative inline-flex" aria-label="Parity not measured yet" role="img">
                  <Ring value={0} label={false} />
                  <span className="font-title absolute inset-0 flex items-center justify-center text-[19px] font-bold leading-none text-fg-faint">
                    —
                  </span>
                </span>
                <div>
                  <div className="font-title text-[15px] font-bold">Parity with the market</div>
                  <div className="mt-0.5 text-[12.5px] text-fg-3">No competitors tracked yet</div>
                  <div className="mt-1 font-mono text-[10.5px] text-fg-faint">
                    0 domains · 0 capabilities · 0 competitors
                  </div>
                </div>
              </div>
              <StatCard label="Gaps" tone="#f0b43c" toneFg="#8a5a00" sub="None tracked yet" />
              <StatCard label="Partial" tone="#3b7cf6" toneFg="#2a5fd0" sub="Limited or in beta" />
              <StatCard label={`Only ${own}`} tone="#17b26a" toneFg="#0f7a47" sub="None tracked yet" />
              <div className="flex flex-[1_1_280px] flex-col gap-1.5 rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
                <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">Risk</span>
                <span className="text-[12px] text-fg-faint">No competitors yet</span>
              </div>
            </div>

            {/* Filters */}
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <SearchBox value={capQuery} onChange={setCapQuery} placeholder="Search capabilities…" />
              <FilterPopover
                label="Domain"
                options={[]}
                selected={domainFilter}
                onToggle={toggleIn(setDomainFilter)}
                emptyText="No domains yet"
              />
              <FilterPopover
                label="Product line"
                options={catalogProducts}
                selected={productFilter}
                onToggle={toggleIn(setProductFilter)}
                emptyText="No product lines yet"
              />
              <FilterPopover
                label="Competitor"
                accent="customer"
                options={[]}
                selected={competitorFilter}
                onToggle={toggleIn(setCompetitorFilter)}
                emptyText="No competitors yet"
              />
              <FilterPopover
                single
                label="Status"
                accent="status"
                options={CELL_STATES}
                selected={statusFilter}
                onToggle={(o) => setStatusFilter((prev) => (prev.includes(o) ? [] : [o]))}
              />
              <span className="mx-1 h-5 w-px bg-border" />
              <button aria-pressed={gapsOnly} onClick={() => setGapsOnly((v) => !v)} className={chipClass(gapsOnly)}>
                Gaps only
                {gapsOnly && <Check size={12} strokeWidth={3} />}
              </button>
              <button aria-pressed={newChanges} onClick={() => setNewChanges((v) => !v)} className={chipClass(newChanges)}>
                New Changes
                {newChanges && <Check size={12} strokeWidth={3} />}
              </button>
            </div>

            {/* Matrix: the org's own column first; competitor columns join it as they are added */}
            <div className="glass overflow-hidden rounded-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="border-b border-border px-4 pb-[30px] pl-[30px] pt-2.5 text-left align-middle text-[12px] font-semibold tracking-[0.06em] text-fg-muted"
                      >
                        Capability
                      </th>
                      <th
                        scope="col"
                        className="w-[104px] border-b border-t-[3px] border-b-border border-t-primary bg-[rgba(36,87,245,.08)] px-2 pb-2.5 text-center align-bottom"
                      >
                        <span className="flex flex-col items-center gap-1.5 pt-2.5">
                          <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#0b1430] text-[11px] font-bold text-[#f3f1fb]">
                            {initialsOf(own)}
                          </span>
                          <span className="text-[12px] font-bold">{own}</span>
                        </span>
                      </th>
                      <th scope="col" className="w-[150px] border-b border-border px-4 py-2.5">
                        <span className="sr-only">Coverage</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td colSpan={3} className="px-10 py-14 text-center">
                        <div className="font-title mb-1 text-[15px] font-bold">No capabilities or competitors yet</div>
                        <div className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-fg-3">
                          Competitors become columns here and capabilities become rows, grouped by domain,
                          with {own}&apos;s own status in the first column.
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-[18px] px-1 text-[12px] text-fg-3">
              <span className="inline-flex items-center gap-1.5">
                <OkMark size={16} />
                Has it
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block rounded-full bg-[rgba(59,124,246,.15)] px-2 py-px text-[11px] font-semibold text-[#2a5fd0]">
                  Partial
                </span>
                Limited or beta
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="font-semibold text-[#5b6c85]">—</span>
                Missing
              </span>
              <span className="ml-auto text-fg-muted">Click a cell to open that capability in the competitor&apos;s profile</span>
            </div>
          </section>
        )}

        {tab === "feed" && (
          <section aria-label="News feed" className="flex flex-col">
            <div className="mb-3.5 flex flex-wrap items-center gap-2">
              <SearchBox value={signalQuery} onChange={setSignalQuery} placeholder="Search signals…" />
              <FilterPopover
                label="Competitor"
                accent="customer"
                options={[]}
                selected={feedCompetitor}
                onToggle={toggleIn(setFeedCompetitor)}
                emptyText="No competitors yet"
              />
              <FilterPopover
                label="Source"
                accent="platform"
                options={[]}
                selected={sourceFilter}
                onToggle={toggleIn(setSourceFilter)}
                emptyText="No sources yet"
              />
              <FilterPopover
                label="Impact"
                accent="status"
                options={IMPACTS}
                selected={impactFilter}
                onToggle={toggleIn(setImpactFilter)}
              />
              <span className="mx-1 h-5 w-px bg-border" />
              <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} className={chipClass(unreadOnly)}>
                Unread
                {unreadOnly && <Check size={12} strokeWidth={3} />}
              </button>
              <div className="ml-auto">
                <span title="No signals to mark" className="inline-flex">
                  <Button size="sm" variant="ghost" disabled>
                    <CheckCheck size={13} strokeWidth={2.25} />
                    Mark all read
                  </Button>
                </span>
              </div>
            </div>
            <EmptyPanel
              title="No signals yet"
              body="PMOS AI posts what changed at each competitor here, day by day, with what it means for your roadmap, once competitors and sources are added."
            />
          </section>
        )}

        {tab === "profiles" && (
          <section aria-label="Profiles" className="flex flex-col">
            <EmptyPanel
              title="No competitor profiles yet"
              body="Each competitor gets a profile: company facts, a timeline, capabilities by product, people, UI captures and the sources behind them."
            />
          </section>
        )}

        {tab === "cards" && (
          <section aria-label="Battle cards" className="flex flex-col">
            <div className="mb-3.5 flex items-center gap-2">
              <span className="text-[12.5px] text-fg-3">0 cards</span>
              <div className="ml-auto">
                <span title="No battle cards to export" className="inline-flex">
                  <Button size="sm" disabled>
                    <Download size={13} />
                    Export
                  </Button>
                </span>
              </div>
            </div>
            <EmptyPanel
              title="No battle cards yet"
              body={`One card per competitor: why ${own} wins, areas to avoid, and answers to the questions buyers ask.`}
            />
          </section>
        )}

        {tab === "roadmap" && (
          <section aria-label="Roadmap" className="flex flex-col gap-4">
            {[
              { title: "Gaps", sub: `Capabilities competitors have and ${own} doesn't`, empty: "No gaps found yet" },
              { title: "Partial", sub: `Capabilities ${own} must improve to reach parity`, empty: "No partial capabilities found yet" },
            ].map((g) => (
              <div key={g.title} className="glass overflow-hidden rounded-card">
                <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                  <span className="text-[14px] font-bold">{g.title}</span>
                  <span className="text-[11px] text-fg-muted">
                    {g.sub} · 0
                  </span>
                </div>
                <div className="px-4 py-8 text-center text-[13px] text-fg-3">{g.empty}</div>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
