"use client";
import { useMemo, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { LazyIdeaDetailsEditor } from "@/components/ideas/LazyIdeaDetailsEditor";
import { chipStyle, CUSTOMER_CHIP_DEFAULT, PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import type { ZendeskTicket } from "@/lib/ideas/types";
import { Button } from "@/components/ui/Button";

/**
 * "New idea": a PM writes an idea from scratch — title, text, product line,
 * platforms, customers, score, and optionally the tickets it rests on (only
 * tickets that back no idea yet). It lands as a New idea pending review and
 * syncs to Jira like any imported one. Same drawer frame as IdeaDrawer; its
 * own form state because nothing exists to edit yet.
 */

export interface NewIdeaDraft {
  title: string;
  details: string;
  manual: number | null;
  products: string[];
  platforms: string[];
  addedCustomers: string[];
  zen: string[];
}

const MONO_LABEL = "font-mono text-[10px] font-semibold tracking-[0.06em] text-[#7a8aa3]";
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

export function NewIdeaDrawer({
  catalogProducts,
  catalogPlatforms,
  customerCatalog,
  productColors = {},
  customerColors = {},
  freeTickets,
  onClose,
  onCreate,
}: {
  catalogProducts: string[];
  catalogPlatforms: string[];
  customerCatalog: string[];
  productColors?: Record<string, string>;
  customerColors?: Record<string, string>;
  /** Tickets that back no live idea — the pickable sources. */
  freeTickets: ZendeskTicket[];
  onClose: () => void;
  onCreate: (draft: NewIdeaDraft) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [customers, setCustomers] = useState<string[]>([]);
  const [newCustomer, setNewCustomer] = useState("");
  const [zen, setZen] = useState<string[]>([]);
  const [ticketQuery, setTicketQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (list: string[], v: string) =>
    list.some((x) => sameName(x, v)) ? list.filter((x) => !sameName(x, v)) : [...list, v];

  const q = ticketQuery.trim().toLowerCase();
  const pickable = useMemo(
    () =>
      freeTickets
        .filter((t) => !q || t.subject.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
        .slice(0, 12),
    [freeTickets, q],
  );

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
        zen,
      });
      if (!ok) setError("Could not create the idea");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 right-0 top-0 z-[41] flex w-[620px] max-w-full flex-col border-l border-border bg-white shadow-[var(--app-shadow-drawer)]"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="absolute bottom-0 left-0 top-0 w-[3px] bg-[var(--app-accent)]" aria-hidden />
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
          {/* Tags: product lines (one is mandatory), platforms, customers */}
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
                  {on && (
                    <span
                      className="mr-1 inline-block h-2 w-2 rounded-full"
                      style={{ background: swatchColor(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT) }}
                    />
                  )}
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
            {customers.map((c) => (
              <span
                key={`c-${c}`}
                className="inline-flex items-center gap-1 rounded-chip px-[7px] py-[2px] font-mono text-[11px] font-semibold"
                style={chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
              >
                {c}
                <button
                  type="button"
                  title="Remove"
                  onClick={() => setCustomers((l) => l.filter((x) => !sameName(x, c)))}
                  className="flex rounded-sm p-px opacity-70 hover:bg-black/10 hover:opacity-100"
                >
                  <X size={11} strokeWidth={3} />
                </button>
              </span>
            ))}
            <input
              list="new-idea-customers"
              value={newCustomer}
              onChange={(e) => setNewCustomer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCustomer.trim()) {
                  e.preventDefault();
                  e.stopPropagation();
                  const n = newCustomer.trim();
                  if (!customers.some((x) => sameName(x, n))) setCustomers((l) => [...l, n]);
                  setNewCustomer("");
                }
              }}
              placeholder="+ customer"
              aria-label="Add customer"
              className="w-28 rounded-chip border border-dashed border-[#c9d3e0] px-[7px] py-[2px] font-mono text-[11px] outline-none focus:border-primary"
            />
            <datalist id="new-idea-customers">
              {customerCatalog.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
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
            <div className={`${MONO_LABEL} mb-2`}>
              Sources · {zen.length}
              <span className="ml-2 font-normal normal-case tracking-normal text-[#9aa8be]">
                optional — tickets that back no idea yet
              </span>
            </div>
            {freeTickets.length === 0 ? (
              <div className="text-[12.5px] text-fg-muted">Every imported ticket already backs an idea.</div>
            ) : (
              <>
                <input
                  value={ticketQuery}
                  onChange={(e) => setTicketQuery(e.target.value)}
                  placeholder="Filter tickets…"
                  aria-label="Filter tickets"
                  className="mb-2 w-full rounded-md border border-border px-2 py-1 text-[12.5px] outline-none focus:border-primary"
                />
                <div className="flex flex-col gap-1.5">
                  {pickable.map((t) => {
                    const on = zen.includes(t.key);
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setZen((l) => (on ? l.filter((k) => k !== t.key) : [...l, t.key]))}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors ${
                          on ? "border-primary bg-white" : "border-border bg-[rgba(240,244,250,.7)] hover:border-primary hover:bg-white"
                        }`}
                      >
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-[#c9d3e0] bg-white">
                          {on && <Check size={10} strokeWidth={3} className="text-primary" />}
                        </span>
                        <span className="shrink-0 rounded bg-[#e6eaf2] px-1.5 py-0.5 font-mono text-[11px] font-bold text-[#4a5b74]">
                          {t.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[#33445e]">{t.subject}</span>
                      </button>
                    );
                  })}
                  {pickable.length === 0 && (
                    <div className="text-[12.5px] text-fg-muted">No ticket matches.</div>
                  )}
                </div>
              </>
            )}
          </div>
          {error && <div className="text-[12.5px] text-[#c94266]">{error}</div>}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border bg-[rgba(255,255,255,.6)] px-6 py-3">
          <Button variant="primary" glow disabled={!canCreate} onClick={() => void submit()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Create idea
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </>
  );
}
