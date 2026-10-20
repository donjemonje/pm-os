"use client";
import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Search, X } from "lucide-react";
import { LazyIdeaDetailsEditor } from "@/components/ideas/LazyIdeaDetailsEditor";
import { chipStyle, CUSTOMER_CHIP_DEFAULT, PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { STATUS_TONES } from "@/lib/ideas/idea";
import type { JiraSource, ZendeskTicket } from "@/lib/ideas/types";
import { Button } from "@/components/ui/Button";

/**
 * "New idea": a PM writes an idea from scratch — title, text, product line,
 * platforms, customers, and optionally the sources it rests on: Zendesk
 * tickets and Jira issues that back no idea yet, picked from a "Find
 * tickets" dropdown (search by contains, either list can be hidden). No
 * suggestions — the PM chooses. It lands as a New idea pending review and
 * syncs to Jira like any imported one (with a Jira issue attached, the sync
 * updates that issue instead of creating one). Same drawer frame as
 * IdeaDrawer and the same customer control; its own form state because
 * nothing exists to edit yet.
 */

export interface NewIdeaDraft {
  title: string;
  details: string;
  manual: number | null;
  products: string[];
  platforms: string[];
  addedCustomers: string[];
  zen: string[];
  jira: string[];
}

const MONO_LABEL = "font-mono text-[10px] font-semibold tracking-[0.06em] text-[#7a8aa3]";
const ZEN_TAG = { background: "#e6eaf2", color: "#4a5b74" };
const JIRA_TAG = { background: "rgba(59,124,246,.15)", color: "#2a5fd0" };
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

type Pick = { kind: "zen" | "jira"; key: string; id: string; title: string };

export function NewIdeaDrawer({
  catalogProducts,
  catalogPlatforms,
  customerCatalog,
  productColors = {},
  customerColors = {},
  freeTickets,
  freeJira,
  onClose,
  onCreate,
}: {
  catalogProducts: string[];
  catalogPlatforms: string[];
  customerCatalog: string[];
  productColors?: Record<string, string>;
  customerColors?: Record<string, string>;
  /** Tickets and issues that back no live idea — the pickable sources. */
  freeTickets: ZendeskTicket[];
  freeJira: JiraSource[];
  onClose: () => void;
  onCreate: (draft: NewIdeaDraft) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [customers, setCustomers] = useState<string[]>([]);
  const [newCustomer, setNewCustomer] = useState("");
  const [customerListOpen, setCustomerListOpen] = useState(false);
  const [picked, setPicked] = useState<Pick[]>([]);
  const [finderOpen, setFinderOpen] = useState(false);
  const [finderQuery, setFinderQuery] = useState("");
  const [showZen, setShowZen] = useState(true);
  const [showJira, setShowJira] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const finderRef = useRef<HTMLDivElement>(null);
  // Same width as the idea drawer (half the window, 380 minimum).
  const [width] = useState(() =>
    typeof window === "undefined" ? 640 : Math.max(380, Math.round(window.innerWidth / 2)),
  );

  const toggle = (list: string[], v: string) =>
    list.some((x) => sameName(x, v)) ? list.filter((x) => !sameName(x, v)) : [...list, v];

  const addCustomer = (name: string) => {
    const n = name.trim();
    setNewCustomer("");
    if (!n || customers.some((c) => sameName(c, n))) return;
    setCustomers((l) => [...l, n]);
  };

  const pool: Pick[] = useMemo(
    () => [
      ...freeTickets.map((t) => ({ kind: "zen" as const, key: t.key, id: t.id, title: t.subject })),
      ...freeJira.map((s) => ({ kind: "jira" as const, key: s.key, id: s.id, title: s.title })),
    ],
    [freeTickets, freeJira],
  );
  const fq = finderQuery.trim().toLowerCase();
  const found = useMemo(
    () =>
      pool
        .filter((p) => (p.kind === "zen" ? showZen : showJira))
        .filter((p) => !fq || p.title.toLowerCase().includes(fq) || p.id.toLowerCase().includes(fq) || p.key.toLowerCase().includes(fq))
        .slice(0, 40),
    [pool, fq, showZen, showJira],
  );
  const isPicked = (p: Pick) => picked.some((x) => x.kind === p.kind && x.key === p.key);
  const togglePick = (p: Pick) =>
    setPicked((l) => (isPicked(p) ? l.filter((x) => !(x.kind === p.kind && x.key === p.key)) : [...l, p]));

  const canCreate = title.trim().length > 0 && products.length > 0 && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError("");
    try {
      const ok = await onCreate({
        title: title.trim(),
        details,
        manual: null,
        products,
        platforms,
        addedCustomers: customers,
        zen: picked.filter((p) => p.kind === "zen").map((p) => p.key),
        jira: picked.filter((p) => p.kind === "jira").map((p) => p.key),
      });
      if (!ok) setError("Could not create the idea");
    } finally {
      setBusy(false);
    }
  };

  const cq = newCustomer.trim().toLowerCase();
  const customerOptions = customerCatalog
    .filter((k) => !customers.some((c) => sameName(c, k)))
    .filter((k) => !cq || k.toLowerCase().includes(cq))
    .slice(0, 8);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 right-0 top-0 z-[41] flex max-w-full flex-col border-l border-border bg-white shadow-[var(--app-shadow-drawer)]"
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (finderOpen) {
              e.stopPropagation();
              setFinderOpen(false);
              return;
            }
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {/* Status edge: New green, like the ideas this form creates. */}
        <div className="absolute bottom-0 left-0 top-0 w-[3px]" style={{ background: STATUS_TONES.new.solid }} aria-hidden />
        {/* Header */}
        <div className="flex flex-col gap-3 border-b border-border px-6 pb-4 pt-[18px]">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow text-primary">New idea</span>
            <button onClick={onClose} title="Close" className="flex rounded-md p-0.5 text-[#7a8aa3] hover:text-foreground">
              <X size={15} />
            </button>
          </div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Idea title"
            aria-label="Idea title"
            className="font-title w-full rounded-lg border border-border px-3 py-2 text-[17px] font-bold outline-none focus:border-primary"
          />
          {/* Tags row — the same controls as the drawer's tag editor. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[...new Set([...catalogProducts, "Other"])].map((p) => {
              const on = products.some((x) => sameName(x, p));
              return (
                <button
                  key={`p-${p}`}
                  type="button"
                  onClick={() => setProducts((l) => toggle(l, p))}
                  aria-pressed={on}
                  className={
                    on
                      ? "rounded-chip border border-transparent px-[7px] py-[2px] font-mono text-[11px] font-semibold ring-1 ring-black/10"
                      : "rounded-chip border border-dashed border-[#c9d3e0] px-[7px] py-[2px] font-mono text-[11px] text-[#7a8aa3] hover:border-primary hover:text-foreground"
                  }
                  style={on ? chipStyle(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT) : undefined}
                >
                  {p}
                </button>
              );
            })}
            {catalogPlatforms.length > 0 && <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-[#dde5ef]" />}
            {catalogPlatforms.map((p) => {
              const on = platforms.some((x) => sameName(x, p));
              return (
                <button
                  key={`pl-${p}`}
                  type="button"
                  onClick={() => setPlatforms((l) => toggle(l, p))}
                  aria-pressed={on}
                  className={
                    on
                      ? "rounded-chip bg-[rgba(169,140,255,.16)] px-[7px] py-[2px] font-mono text-[11px] font-semibold text-[#6b4bd0] ring-1 ring-black/10"
                      : "rounded-chip border border-dashed border-[#c9d3e0] px-[7px] py-[2px] font-mono text-[11px] text-[#7a8aa3] hover:border-primary hover:text-foreground"
                  }
                >
                  {p}
                </button>
              );
            })}
            <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-[#dde5ef]" />
            {customers.map((c) => {
              const suggested = !customerCatalog.some((k) => sameName(k, c));
              return (
                <span
                  key={`c-${c}`}
                  className={
                    suggested
                      ? "inline-flex items-center gap-1 rounded-chip border border-dashed border-amber-400 bg-amber-50 px-[7px] py-[2px] font-mono text-[11px] font-semibold text-amber-700"
                      : "inline-flex items-center gap-1 rounded-chip px-[7px] py-[2px] font-mono text-[11px] font-semibold"
                  }
                  style={suggested ? undefined : chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
                >
                  {c}
                  <button
                    type="button"
                    title="Remove from this idea"
                    onClick={() => setCustomers((l) => l.filter((x) => !sameName(x, c)))}
                    className="flex rounded-sm p-px opacity-70 hover:bg-black/10 hover:opacity-100"
                  >
                    <X size={11} strokeWidth={3} />
                  </button>
                </span>
              );
            })}
            <div className="relative">
              <input
                type="text"
                value={newCustomer}
                onChange={(e) => {
                  setNewCustomer(e.target.value);
                  setCustomerListOpen(true);
                }}
                onFocus={() => setCustomerListOpen(true)}
                onClick={() => setCustomerListOpen(true)}
                onBlur={() => setTimeout(() => setCustomerListOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const first = customerOptions[0];
                    addCustomer(first && cq && first.toLowerCase().startsWith(cq) ? first : newCustomer);
                    setCustomerListOpen(false);
                  } else if (e.key === "Escape" && customerListOpen) {
                    e.stopPropagation();
                    setCustomerListOpen(false);
                  }
                }}
                placeholder="Add customer…"
                aria-label="Add customer"
                className="min-w-[180px] rounded-lg border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
              />
              {customerListOpen && customerOptions.length > 0 && (
                <ul className="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
                  {customerOptions.map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          addCustomer(k);
                          setCustomerListOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--app-accent-soft)]"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: swatchColor(colorOf(customerColors, k), CUSTOMER_CHIP_DEFAULT) }}
                        />
                        <span className="truncate">{k}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {products.length === 0 && (
            <span className="text-[11px] text-[#9aa8be]">Pick at least one product line.</span>
          )}
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
          <div>
            <div className={`${MONO_LABEL} mb-2`}>Details</div>
            <LazyIdeaDetailsEditor defaultValue="" onChange={setDetails} />
            <span className="text-[11px] text-[#9aa8be]">⌘B bold · ⌘I italic · ⌘K link · ⌘↵ creates · Esc cancels</span>
          </div>
          <div>
            <div className={`${MONO_LABEL} mb-2 flex items-center gap-2`}>
              <span>Sources · {picked.length}</span>
              <div ref={finderRef} className="relative ml-auto">
                <button
                  type="button"
                  onClick={() => setFinderOpen((v) => !v)}
                  aria-expanded={finderOpen}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-border bg-white px-2 font-mono text-[10.5px] font-semibold text-fg-2 hover:border-primary"
                >
                  <Search size={11} strokeWidth={2.5} />
                  Find tickets
                  <ChevronDown size={11} />
                </button>
                {finderOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-[440px] max-w-[80vw] rounded-lg border border-border bg-white p-2 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={finderQuery}
                        onChange={(e) => setFinderQuery(e.target.value)}
                        placeholder="Search tickets and issues…"
                        aria-label="Search tickets and issues"
                        className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-[12.5px] outline-none focus:border-primary"
                      />
                      <button
                        type="button"
                        onClick={() => setShowZen((v) => !v)}
                        aria-pressed={showZen}
                        title={showZen ? "Hide Zendesk tickets" : "Show Zendesk tickets"}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] font-bold ${showZen ? "" : "opacity-40 line-through"}`}
                        style={ZEN_TAG}
                      >
                        Zendesk
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowJira((v) => !v)}
                        aria-pressed={showJira}
                        title={showJira ? "Hide Jira issues" : "Show Jira issues"}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] font-bold ${showJira ? "" : "opacity-40 line-through"}`}
                        style={JIRA_TAG}
                      >
                        Jira
                      </button>
                    </div>
                    {pool.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-fg-muted">Every ticket and issue already backs an idea.</div>
                    ) : found.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-fg-muted">Nothing matches.</div>
                    ) : (
                      <ul className="m-0 max-h-72 list-none overflow-y-auto p-0">
                        {found.map((p) => {
                          const on = isPicked(p);
                          return (
                            <li key={`${p.kind}:${p.key}`}>
                              <button
                                type="button"
                                onClick={() => togglePick(p)}
                                aria-pressed={on}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--app-accent-soft)]"
                              >
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-[#c9d3e0] bg-white">
                                  {on && <Check size={10} strokeWidth={3} className="text-primary" />}
                                </span>
                                <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] font-bold" style={p.kind === "zen" ? ZEN_TAG : JIRA_TAG}>
                                  {p.id}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[#33445e]">{p.title}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
            {picked.length === 0 ? (
              <div className="text-[12.5px] text-fg-muted">No sources yet — optional.</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {picked.map((p) => (
                  <div
                    key={`${p.kind}:${p.key}`}
                    className="flex items-center gap-2.5 rounded-[10px] border border-border bg-[rgba(240,244,250,.7)] px-3 py-2"
                  >
                    <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-bold" style={p.kind === "zen" ? ZEN_TAG : JIRA_TAG}>
                      {p.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#33445e]">{p.title}</span>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => togglePick(p)}
                      className="flex shrink-0 rounded p-1 text-[#9aa8be] hover:bg-white hover:text-[#c94266]"
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <div className="text-[12.5px] text-[#c94266]">{error}</div>}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border bg-[rgba(255,255,255,.6)] px-6 py-3">
          <Button variant="success" glow disabled={!canCreate} onClick={() => void submit()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Create idea
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </>
  );
}
