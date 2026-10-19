"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Flag,
  Pencil,
  RotateCcw,
  X,
  Share2,
} from "lucide-react";
import {
  badgeOf,
  needsApproval,
  SCORING_ENABLED,
  scoreOf,
  STATUS_TONES,
  votesLabel,
  CATALOG_KIND_LABELS,
} from "@/lib/ideas/idea";
import type { Idea, JiraSource, ZendeskTicket } from "@/lib/ideas/types";
import {
  DEFAULT_CSV_MAPPING,
  extractMappedFields,
  type CsvMapping,
} from "@/lib/ideas/csv-mapping";
import { chipStyle, CUSTOMER_CHIP_DEFAULT, PRODUCT_CHIP_DEFAULT, swatchColor } from "@/lib/ideas/colors";
import { PmosMark } from "@/components/brand/PmosMark";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Pill } from "@/components/ui/Pill";
import { VoteBar } from "@/components/ui/VoteBar";

/** Case-insensitive lookup of a catalog color by name. */
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { URL_RE } from "@/lib/ideas/editor-markdown";

type SourceSel = { kind: "zen" | "jira"; key: string };

interface IdeaDrawerProps {
  /** null when opening a standalone source (e.g. from the Merge page). */
  idea: Idea | null;
  /** When set, the drawer opens directly on this source. */
  initialSource?: SourceSel | null;
  ticketsByKey: Map<string, ZendeskTicket>;
  jiraByKey: Map<string, JiraSource>;
  /** The org's CSV mapping — the ticket view reads display-only fields from the raw row with it. */
  csvMapping?: CsvMapping;
  /** Label for the product line on the raw Jira issue — the mapped Jira field's name ("Module"). */
  jiraProductLineLabel?: string;
  /** Every idea by id — the ticket view links the ideas it produced. */
  ideasById?: Map<string, Idea>;
  /** Catalog chip colors (palette ids) by name. */
  productColors?: Record<string, string>;
  customerColors?: Record<string, string>;
  /** Settings catalogs — the edit form's pick lists. */
  catalogProducts?: string[];
  catalogPlatforms?: string[];
  /** Customer catalog names — chips for names outside it render as suggestions. */
  customerCatalog?: string[];
  /** Approve adds the suggested customer to the catalog; dismiss hides it on this idea (reversible); undismiss restores it. */
  onCustomerAction?: (
    action: "approve" | "dismiss" | "undismiss",
    name: string,
  ) => void;
  onClose: () => void;
  /** Set when the drawer was reached from another drawer view — shows a back chevron. */
  onBack?: () => void;
  /** Open another idea from inside the drawer (ticket view → the ideas it produced). */
  onOpenIdea?: (id: string, from: { source: SourceSel | null }) => void;
  onToggleApprove?: () => void;
  /** Set only while this idea's last-merge write is undoable AND the ideasUndo flag is on. */
  onUndoPush?: () => void;
  onSave?: (patch: {
    title: string;
    details: string;
    manual: number | null;
    products: string[];
    platforms: string[];
    addedCustomers: string[];
    removeCustomers: string[];
  }) => void;
  onMerge?: () => void;
}

const MONO_LABEL =
  "font-mono text-[10px] font-semibold tracking-[0.06em] text-[#7a8aa3]";

// The WYSIWYG Details editor (Tiptap) is loaded only when a PM clicks Edit —
// the Ideas page itself never pays for it.
const IdeaDetailsEditor = dynamic(
  () => import("@/components/ideas/IdeaDetailsEditor"),
  { ssr: false, loading: () => <div className="idea-editor idea-editor-loading" /> },
);

const ZEN_TAG = { background: "#e6eaf2", color: "#4a5b74" };
const JIRA_TAG = { background: "rgba(59,124,246,.15)", color: "#2a5fd0" };

export function IdeaDrawer({
  idea,
  initialSource,
  ticketsByKey,
  jiraByKey,
  csvMapping = DEFAULT_CSV_MAPPING,
  jiraProductLineLabel = "Product line",
  ideasById,
  productColors = {},
  customerColors = {},
  catalogProducts = [],
  catalogPlatforms = [],
  customerCatalog = [],
  onCustomerAction,
  onClose,
  onBack,
  onOpenIdea,
  onToggleApprove,
  onUndoPush,
  onSave,
  onMerge,
}: IdeaDrawerProps) {
  // Opens at half the window (sidebar included); the PM can still drag it
  // between 380px and 90% of the window.
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 640;
    return Math.max(380, Math.round(window.innerWidth / 2));
  });
  const [srcSel, setSrcSel] = useState<SourceSel | null>(initialSource ?? null);

  /** Which part is being edited: the text (title + details) or the tags
   *  (product lines, platforms, customers). null = viewing. */
  const [editSection, setEditSection] = useState<null | "details" | "tags">(null);
  const editMode = editSection !== null;
  // Esc closes the drawer (standing rule: Esc = cancel). Window-level so it
  // works wherever focus sits; the drawer is the topmost layer while open.
  useEffect(() => {
    if (editMode) return; // Esc cancels the edit instead (onEditKeyDown).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editMode]);
  const [editTitle, setEditTitle] = useState("");
  const [editManual, setEditManual] = useState("");
  const [editDetails, setEditDetails] = useState("");
  const [editProducts, setEditProducts] = useState<string[]>([]);
  const [editPlatforms, setEditPlatforms] = useState<string[]>([]);
  /** Customers as shown while editing (ticket-derived + manual, minus removed). */
  const [editCustomers, setEditCustomers] = useState<string[]>([]);
  const [editAdded, setEditAdded] = useState<string[]>([]);
  const [editRemoved, setEditRemoved] = useState<string[]>([]);
  const [newCustomer, setNewCustomer] = useState("");
  const [customerListOpen, setCustomerListOpen] = useState(false);
  /** Product-line multi-select dropdown (tags edit); closes on outside click. */
  const [productMenuOpen, setProductMenuOpen] = useState(false);
  const productMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!productMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (productMenuRef.current && !productMenuRef.current.contains(e.target as Node))
        setProductMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [productMenuOpen]);
  const [showDismissed, setShowDismissed] = useState(false);

  const ticket =
    srcSel?.kind === "zen" ? ticketsByKey.get(srcSel.key) : undefined;
  const jiraSrc =
    srcSel?.kind === "jira" ? jiraByKey.get(srcSel.key) : undefined;
  const viewingSource = !!ticket || !!jiraSrc;
  const badge = idea ? badgeOf(idea) : null;
  const score = idea ? scoreOf(idea) : null;
  const votes = idea ? votesLabel(idea) : null;

  const startEdit = (section: "details" | "tags" = "details") => {
    if (!idea) return;
    setEditTitle(idea.title);
    setEditManual(idea.manual != null ? String(idea.manual) : "");
    setEditDetails(idea.details);
    setEditProducts([...idea.products]);
    setEditPlatforms([...(idea.platforms ?? [])]);
    setEditCustomers([...(idea.customers ?? [])]);
    setEditAdded([...(idea.addedCustomers ?? [])]);
    setEditRemoved([]);
    setNewCustomer("");
    setCustomerListOpen(false);
    setEditSection(section);
  };
  const saveEdit = () => {
    if (!idea) return;
    const raw = editManual.trim();
    const parsed = raw === "" ? null : parseInt(raw, 10);
    onSave?.({
      title: editTitle.trim() || idea.title,
      details: editDetails,
      manual: parsed != null && Number.isNaN(parsed) ? idea.manual : parsed,
      products: editProducts,
      platforms: editPlatforms,
      addedCustomers: editAdded,
      removeCustomers: editRemoved,
    });
    setEditSection(null);
  };
  const cancelEdit = () => setEditSection(null);
  // Keyboard for the whole edit (title, score, customers, Details editor):
  // Esc cancels the edit and must not also close the drawer; ⌘↵ saves. Inputs
  // that handle these keys themselves (the editor's link bar) stop propagation.
  // Esc acts on the innermost thing that has focus: the customer typeahead
  // list closes itself (and stops the event), then this leaves the edit —
  // tags mode just closes (already saved), the text edit is cancelled — and
  // only when nothing is being edited does Esc close the drawer (window
  // listener above). ⌘↵ saves the text edit.
  const onEditKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editMode) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editSection === "details") {
      e.preventDefault();
      saveEdit();
    }
  };
  const sameName = (a: string, b: string) => a.toLowerCase() === b.trim().toLowerCase();
  const toggleIn = (list: string[], name: string) =>
    list.some((x) => sameName(x, name)) ? list.filter((x) => !sameName(x, name)) : [...list, name];
  /** Tag edits save on every change (no Save/Cancel — Daniel, 2026-10-19):
   *  one call per click with the full lists; a ticket-derived customer
   *  removed in this click goes out as a dismissal. */
  const commitTags = (next: {
    products?: string[];
    platforms?: string[];
    added?: string[];
    removed?: string[];
  }) => {
    if (!idea) return;
    onSave?.({
      title: idea.title,
      details: idea.details,
      manual: idea.manual ?? null,
      products: next.products ?? editProducts,
      platforms: next.platforms ?? editPlatforms,
      addedCustomers: next.added ?? editAdded,
      removeCustomers: next.removed ?? [],
    });
  };
  const toggleProduct = (p: string) => {
    const next = toggleIn(editProducts, p);
    if (next.length === 0) return; // one product line is mandatory
    setEditProducts(next);
    commitTags({ products: next });
  };
  const togglePlatform = (p: string) => {
    const next = toggleIn(editPlatforms, p);
    setEditPlatforms(next);
    commitTags({ platforms: next });
  };
  const addCustomer = (name: string) => {
    const n = name.trim();
    if (!n || editCustomers.some((c) => sameName(c, n))) {
      setNewCustomer("");
      return;
    }
    setEditCustomers((l) => [...l, n]);
    const added = [...editAdded, n];
    setEditAdded(added);
    setNewCustomer("");
    commitTags({ added });
  };
  const removeCustomer = (name: string) => {
    setEditCustomers((l) => l.filter((c) => !sameName(c, name)));
    if (editAdded.some((c) => sameName(c, name))) {
      const added = editAdded.filter((c) => !sameName(c, name));
      setEditAdded(added);
      commitTags({ added });
    } else {
      commitTags({ removed: [name] });
    }
  };

  /** Inline tag editing on the chips row: product lines toggle, customers
   *  get an × and the add field sits at the end of the row; the rest of the
   *  drawer stays as it is (Daniel, 2026-10-19). */
  const tagsEditor = (
    <div className="flex flex-wrap items-center gap-1.5" onKeyDown={onEditKeyDown}>
      <div ref={productMenuRef} className="relative flex flex-wrap items-center gap-1.5">
        {editProducts.map((p) => (
          <button
            key={`edit-product-${p}`}
            type="button"
            onClick={() => setProductMenuOpen((v) => !v)}
            title="Click to change product lines"
            className="rounded-chip border border-transparent px-[7px] py-[2px] font-mono text-[11px] font-semibold ring-1 ring-black/10 hover:ring-primary"
            style={chipStyle(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT)}
          >
            {p} ▾
          </button>
        ))}
        {productMenuOpen && (
          <ul
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setProductMenuOpen(false);
              }
            }}
            className="absolute left-0 top-full z-20 mt-1 max-h-64 w-60 overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-[0_8px_24px_rgba(10,22,40,.12)]"
          >
            {[...new Set([...catalogProducts, "Other", ...editProducts])].map((p) => {
              const on = editProducts.some((x) => sameName(x, p));
              const last = on && editProducts.length === 1;
              return (
                <li key={`product-option-${p}`}>
                  <button
                    type="button"
                    onClick={() => toggleProduct(p)}
                    disabled={last}
                    aria-pressed={on}
                    title={last ? "At least one product line stays" : undefined}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--app-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-[#c9d3e0] bg-white">
                      {on && <Check size={10} strokeWidth={3} className="text-primary" />}
                    </span>
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: swatchColor(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT) }}
                    />
                    <span className="truncate">{p}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {(catalogPlatforms.length > 0 || editPlatforms.length > 0) &&
        [...new Set([...catalogPlatforms, ...editPlatforms])].map((p) => {
          const on = editPlatforms.some((x) => sameName(x, p));
          return (
            <button
              key={`edit-platform-${p}`}
              type="button"
              onClick={() => togglePlatform(p)}
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
      {editCustomers.map((c) => {
        const suggested = !customerCatalog.some((k) => sameName(k, c));
        return (
          <span
            key={`edit-customer-${c}`}
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
              onClick={() => removeCustomer(c)}
              className="flex rounded-sm p-px opacity-70 hover:bg-black/10 hover:opacity-100"
            >
              <X size={11} strokeWidth={3} />
            </button>
          </span>
        );
      })}
        {(() => {
          const q = newCustomer.trim().toLowerCase();
          const options = customerCatalog
            .filter((k) => !editCustomers.some((c) => sameName(c, k)))
            .filter((k) => !q || k.toLowerCase().includes(q))
            .slice(0, 8);
          return (
            <div className="relative">
              <input
                type="text"
                value={newCustomer}
                onChange={(e) => {
                  setNewCustomer(e.target.value);
                  setCustomerListOpen(true);
                }}
                onFocus={() => setCustomerListOpen(true)}
                onBlur={() => setTimeout(() => setCustomerListOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    // Enter takes the first match when the typed text
                    // is a prefix of it; otherwise the text as typed.
                    const first = options[0];
                    addCustomer(
                      first && q && first.toLowerCase().startsWith(q) ? first : newCustomer,
                    );
                    setCustomerListOpen(false);
                  } else if (e.key === "Escape" && customerListOpen) {
                    e.stopPropagation();
                    setCustomerListOpen(false);
                  }
                }}
                placeholder="Add customer…"
                className="min-w-[180px] rounded-lg border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
              />
              {customerListOpen && options.length > 0 && (
                <ul className="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
                  {options.map((k) => (
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
          );
        })()}
      <button
        type="button"
        onClick={() => setEditSection(null)}
        title="Stop editing (every change is already saved) — Esc"
        aria-label="Stop editing tags"
        className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-[7px] text-fg-muted hover:bg-[var(--app-accent-soft)] hover:text-foreground"
      >
        <X size={14} strokeWidth={2.5} />
      </button>
    </div>
  );

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) =>
      setWidth(
        Math.min(Math.round(window.innerWidth * 0.9), Math.max(380, startW + (startX - ev.clientX)))
      );
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const stats: { label: string; value: React.ReactNode }[] =
    viewingSource || !idea
      ? []
      : [
          ...(SCORING_ENABLED && score
            ? [
                { label: "Score", value: score.value != null ? String(score.value) : "—" },
                { label: "PM-OS", value: idea.pmScore != null ? String(idea.pmScore) : "—" },
                { label: "Manual", value: idea.manual != null ? String(idea.manual) : "—" },
              ]
            : []),
          {
            label: "Votes",
            value: (
              <>
                <span>{votes ?? "—"}</span>
                {votes && (
                  <VoteBar
                    existing={idea.existingVotes}
                    added={idea.newVotes}
                    max={idea.existingVotes + idea.newVotes}
                    width={56}
                    height={5}
                  />
                )}
              </>
            ),
          },
          {
            label: "Sources",
            value: (
              <>
                <span>{idea.zen.length + idea.jira.length}</span>
                <span className="text-[11px] font-medium text-fg-muted">
                  {idea.zen.length} Zendesk · {idea.jira.length} Jira
                </span>
              </>
            ),
          },
          {
            label: "Reporters",
            value: (
              <>
                <span>{(idea.reporters ?? []).length || "—"}</span>
                {(idea.reporters ?? []).length > 0 && (
                  <span className="truncate text-[11px] font-medium text-fg-muted">
                    {(idea.reporters ?? []).slice(0, 2).join(", ")}
                    {(idea.reporters ?? []).length > 2 ? ` +${(idea.reporters ?? []).length - 2}` : ""}
                  </span>
                )}
              </>
            ),
          },
        ];

  if (!idea && !viewingSource) return null;

  const sourceEntries = idea
    ? [
        ...idea.zen.flatMap((key) => {
          const t = ticketsByKey.get(key);
          return t
            ? [
                {
                  kind: "zen" as const,
                  key,
                  id: t.id,
                  title: t.subject,
                  tag: ZEN_TAG,
                  reporter: t.requester,
                  url: t.url,
                },
              ]
            : [];
        }),
        ...idea.jira.flatMap((key) => {
          const s = jiraByKey.get(key);
          return s
            ? [
                {
                  kind: "jira" as const,
                  key,
                  id: s.id,
                  title: s.title,
                  tag: JIRA_TAG,
                  reporter: undefined as string | undefined,
                  url: s.url,
                },
              ]
            : [];
        }),
      ]
    : [];

  return (
    <>
      {/* Fixed elements chain wheel events to the viewport, not to the app's
          scroll container — forward them so the list keeps scrolling. */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onWheel={(e) => {
          document
            .querySelector("main")
            ?.scrollBy({ top: e.deltaY, left: e.deltaX });
        }}
      />
      <div
        className="fixed bottom-0 right-0 top-0 z-[41] flex flex-col border-l border-border bg-white shadow-[var(--app-shadow-drawer)]"
        style={{ width }}
        onKeyDown={onEditKeyDown}
      >
        {/* Status edge: the idea's batch color (accent for sources and In Jira). */}
        <div
          className="absolute bottom-0 left-0 top-0 w-[3px]"
          style={{
            background:
              !viewingSource && badge && badge.bg !== "#ffffff" && badge.bd === "transparent"
                ? badge.bg
                : "var(--app-accent)",
          }}
          aria-hidden
        />
        <div
          className="absolute -left-[3px] bottom-0 top-0 z-[42] w-2 cursor-col-resize"
          title="Drag to resize"
          onMouseDown={startResize}
        />

        {/* Header */}
        <div className="flex flex-col gap-3 border-b border-border px-6 pb-4 pt-[18px]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {viewingSource && idea ? (
                <button
                  onClick={() => setSrcSel(null)}
                  title="Back to idea"
                  className="flex rounded-md p-0.5 text-[#7a8aa3] hover:text-foreground"
                >
                  <ChevronLeft size={15} />
                </button>
              ) : onBack ? (
                <button
                  onClick={onBack}
                  title="Back"
                  className="flex rounded-md p-0.5 text-[#7a8aa3] hover:text-foreground"
                >
                  <ChevronLeft size={15} />
                </button>
              ) : null}
              {ticket ? (
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#dde5ef] px-2.5 py-0.5 text-xs font-semibold"
                  style={ZEN_TAG}
                >
                  Zendesk ticket <span className="font-mono">{ticket.id}</span>
                  {ticket.url && (
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open in Zendesk"
                      className="ml-0.5 flex text-[#7a8aa3] hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink size={11} />
                    </a>
                  )}
                </span>
              ) : jiraSrc ? (
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgba(59,124,246,.4)] px-2.5 py-0.5 text-xs font-semibold"
                  style={JIRA_TAG}
                >
                  Jira issue <span className="font-mono">{jiraSrc.id}</span>
                  {jiraSrc.url && (
                    <a
                      href={jiraSrc.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open in Jira"
                      className="ml-0.5 flex text-[#7a8aa3] hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink size={11} />
                    </a>
                  )}
                </span>
              ) : (
                badge && <Pill badge={badge} />
              )}
            </div>
            <button
              onClick={onClose}
              className="flex rounded-[7px] p-1 text-fg-muted hover:bg-[var(--app-accent-soft)] hover:text-foreground"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {editSection === "details" && !viewingSource ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="font-title w-full rounded-control border border-primary px-3 py-2 text-[17px] font-bold shadow-[0_0_0_2px_var(--app-accent-soft)] outline-none"
            />
          ) : (
            <h2
              className={`font-title m-0 text-[19px] font-bold leading-[1.3] text-foreground ${
                !viewingSource && idea && !editMode ? "cursor-text rounded-md hover:bg-[rgba(12,25,41,.04)]" : ""
              }`}
              title={!viewingSource && idea && !editMode ? "Click to edit" : undefined}
              onClick={() => {
                if (!viewingSource && idea && !editMode) startEdit("details");
              }}
            >
              {ticket ? ticket.subject : jiraSrc ? jiraSrc.title : idea?.title}
            </h2>
          )}

          {!viewingSource && idea && editSection === "tags" && tagsEditor}
          {!viewingSource &&
            idea &&
            editSection !== "tags" &&
            (idea.products.length > 0 ||
              (idea.platforms ?? []).length > 0 ||
              (idea.customers ?? []).length > 0) && (
              <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {idea.products.map((p) => (
                  <Chip key={p} dot style={chipStyle(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT)}>
                    {p}
                  </Chip>
                ))}
                {/* Platforms assigned by PMOS AI at import; purple per the design. */}
                {(idea.platforms ?? []).map((p) => (
                  <Chip key={`platform-${p}`} kind="platform">
                    {p}
                  </Chip>
                ))}
                {/* A hairline between the product side (lines, platforms) and the
                    customer side of the row. */}
                {(idea.products.length > 0 || (idea.platforms ?? []).length > 0) &&
                  (idea.customers ?? []).length > 0 && (
                    <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-[#dde5ef]" />
                  )}
                {/* Affected customers from the supporting tickets (All Customers is
                    one of them); palette chip when cataloged, amber suggestion
                    with approve/dismiss when not. */}
                {(idea.customers ?? []).map((c) => {
                  const suggested = !customerCatalog.some(
                    (k) => k.toLowerCase() === c.toLowerCase(),
                  );
                  if (!suggested) {
                    return (
                      <Chip
                        key={`customer-${c}`}
                        kind="customer"
                        style={chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
                      >
                        {c}
                      </Chip>
                    );
                  }
                  return (
                    <span
                      key={`customer-${c}`}
                      title="Suggested customer — not in the catalog yet"
                      className="inline-flex items-center gap-1 rounded-chip border border-dashed border-[var(--app-warn)] bg-[var(--app-warn-bg)] px-[7px] py-[2px] font-mono text-[11px] font-semibold text-[var(--app-warn-fg)]"
                    >
                      {c} ⚑
                      {onCustomerAction && (
                        <>
                          <button
                            title="Add to the Customers catalog"
                            onClick={() => onCustomerAction("approve", c)}
                            className="flex rounded-sm p-px text-amber-700 hover:bg-[#daf0e2] hover:text-[#1f8a53]"
                          >
                            <Check size={11} strokeWidth={3} />
                          </button>
                          <button
                            title="Dismiss this suggestion"
                            onClick={() => onCustomerAction("dismiss", c)}
                            className="flex rounded-sm p-px text-amber-700 hover:bg-[#fdeef2] hover:text-[#c94266]"
                          >
                            <X size={11} strokeWidth={3} />
                          </button>
                        </>
                      )}
                    </span>
                  );
                })}
              </div>
              {!editMode && (
                <button
                  type="button"
                  onClick={() => startEdit("tags")}
                  title="Edit product lines and customers"
                  aria-label="Edit product lines and customers"
                  className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-[7px] text-fg-muted hover:bg-[var(--app-accent-soft)] hover:text-foreground"
                >
                  <Pencil size={13} />
                </button>
              )}
              </div>
            )}

          {/* Dismissed suggestions stay reachable — a dismiss is a review
              decision, not a deletion, so it can be reversed any time. */}
          {!viewingSource &&
            idea &&
            (idea.dismissedCustomers ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setShowDismissed((v) => !v)}
                  className="font-mono text-[10.5px] font-medium text-[#9aa8be] hover:text-foreground"
                >
                  {showDismissed ? "▾" : "▸"}{" "}
                  {(idea.dismissedCustomers ?? []).length} dismissed customer
                  {(idea.dismissedCustomers ?? []).length === 1 ? "" : "s"}
                </button>
                {showDismissed &&
                  (idea.dismissedCustomers ?? []).map((c) => (
                    <span
                      key={`dismissed-${c}`}
                      className="inline-flex items-center gap-1 rounded bg-[#eef1f6] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#7a8496]"
                    >
                      <span className="line-through">{c}</span>
                      {onCustomerAction && (
                        <button
                          title="Restore this customer"
                          onClick={() => onCustomerAction("undismiss", c)}
                          className="flex rounded-sm p-px text-[#7a8496] hover:bg-[#daf0e2] hover:text-[#1f8a53]"
                        >
                          <RotateCcw size={10} strokeWidth={2.5} />
                        </button>
                      )}
                    </span>
                  ))}
              </div>
            )}

          {stats.length > 0 && (
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))",
              }}
            >
              {stats.map((st) => (
                <div
                  key={st.label}
                  className="flex min-w-0 flex-col gap-[3px] rounded-[10px] bg-[rgba(240,244,250,.85)] px-3 py-2.5"
                >
                  <div className="eyebrow text-[9.5px]">{st.label}</div>
                  <div className="font-title flex min-w-0 items-center gap-2 text-[18px] font-bold leading-none">
                    {st.value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {SCORING_ENABLED && !viewingSource && score && (
            <span className="text-[11px] text-[#9aa8be]">{score.src}</span>
          )}
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
          {ticket ? (
            <TicketView
              ticket={ticket}
              csvMapping={csvMapping}
              ideasById={ideasById}
              customerCatalog={customerCatalog}
              customerColors={customerColors}
              onOpenIdea={onOpenIdea ? (id) => onOpenIdea(id, { source: srcSel }) : undefined}
            />
          ) : jiraSrc ? (
            <JiraIssueView src={jiraSrc} productLineLabel={jiraProductLineLabel} />
          ) : editSection === "details" ? (
            <>
              {editSection === "details" && (
              <div className="flex flex-col gap-1.5">
                <span className={MONO_LABEL}>Details</span>
                <IdeaDetailsEditor
                  key={idea?.id}
                  defaultValue={editDetails}
                  onChange={setEditDetails}
                />
                <span className="text-[11px] text-[#9aa8be]">
                  ⌘B bold · ⌘I italic · ⌘K link · ⌘↵ saves · Esc cancels
                </span>
              </div>
              )}
            </>
          ) : idea ? (
            <>
              {/* What this import did to an Updated idea — the PM shouldn't
                  have to diff anything by eye. */}
              {idea.batch === "updated" &&
                (idea.batchChanges ?? []).length > 0 && (
                  <div className="rounded-[10px] border border-[rgba(59,124,246,.35)] bg-[rgba(59,124,246,.09)] px-3.5 py-2.5">
                    <div className={`${MONO_LABEL} mb-1.5 text-[#2a5fd0]`}>
                      Updated this import
                    </div>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {(idea.batchChanges ?? []).map((c, i) => (
                        <li
                          key={`${i}-${c}`}
                          className="flex items-start gap-1.5 text-[12.5px] leading-snug text-[#33445e]"
                        >
                          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#3b7cf6]" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              <div
                onClick={() => startEdit("details")}
                title="Click to edit"
                className="-mx-2 cursor-text rounded-lg px-2 py-1 hover:bg-[rgba(12,25,41,.03)]"
              >
                <UmMarkdown
                  content={autolinkBareUrls(idea.details)}
                  className="idea-text"
                />
              </div>
              {sourceEntries.length > 0 && (
                <div>
                  <div className={`${MONO_LABEL} mb-2 flex items-center gap-1.5`}>
                    <Share2 size={12} strokeWidth={2.25} className="text-primary" />
                    Sources · {sourceEntries.length}
                    {onMerge && (
                      <button
                        type="button"
                        onClick={onMerge}
                        title="Edit sources on the Merge board"
                        aria-label="Edit sources on the Merge board"
                        className="ml-auto flex h-6 items-center gap-1 rounded-[7px] px-1.5 text-fg-muted hover:bg-[var(--app-accent-soft)] hover:text-foreground"
                      >
                        <Pencil size={12} />
                        <ExternalLink size={11} />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {sourceEntries.map((src) => (
                      <button
                        key={`${src.kind}:${src.key}`}
                        onClick={() =>
                          setSrcSel({ kind: src.kind, key: src.key })
                        }
                        className="flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-[rgba(240,244,250,.7)] px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-white"
                      >
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-bold"
                          style={src.tag}
                        >
                          {src.id}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] leading-snug text-[#33445e]">
                            {src.title}
                          </span>
                          {src.reporter && (
                            <span className="block text-[11px] text-[#9aa8be]">
                              Reported by {src.reporter}
                            </span>
                          )}
                        </span>
                        {src.url && (
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open in source system"
                            className="shrink-0 rounded p-1 text-[#9aa8be] hover:bg-white hover:text-primary"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                        <ChevronRight
                          size={13}
                          className="shrink-0 text-[#9aa8be]"
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        {!viewingSource && idea && (
          <div className="flex items-center gap-2 border-t border-border bg-[rgba(255,255,255,.6)] px-6 py-3">
            {editSection === "details" ? (
              <>
                <Button variant="primary" glow onClick={saveEdit}>
                  Save changes
                </Button>
                <Button onClick={cancelEdit}>Cancel</Button>
              </>
            ) : (
              <>
                {needsApproval(idea) &&
                  (() => {
                    // Unresolved suggested metadata (customers outside the
                    // catalog) blocks approval — same rule the server enforces.
                    const blocked =
                      idea.decision === "pending" &&
                      (idea.customers ?? []).some(
                        (c) =>
                          !customerCatalog.some(
                            (n) => n.toLowerCase() === c.toLowerCase(),
                          ),
                      );
                    return (
                      <>
                        <Button
                          variant={idea.decision === "pending" ? "success" : "secondary"}
                          glow={idea.decision === "pending"}
                          onClick={() => onToggleApprove?.()}
                          disabled={blocked}
                          title={
                            blocked
                              ? "Approve or dismiss the suggested customers first"
                              : idea.decision === "pending"
                                ? undefined
                                : "Click to mark unreviewed"
                          }
                        >
                          <Check size={13} strokeWidth={3} />
                          {idea.decision === "pending" ? "Approve" : "Approved"}
                        </Button>
                      </>
                    );
                  })()}
                {onUndoPush && idea.decision === "injected" && (
                  <Button
                    variant="warning"
                    onClick={onUndoPush}
                    title={
                      idea.undoable?.action === "create"
                        ? `Deletes ${idea.undoable.jiraKey} in Jira (asks first)`
                        : `Restores ${idea.undoable?.jiraKey} to its pre-sync state`
                    }
                  >
                    Undo sync
                  </Button>
                )}
                {needsApproval(idea) &&
                  idea.decision === "pending" &&
                  (idea.customers ?? []).some(
                    (c) => !customerCatalog.some((n) => n.toLowerCase() === c.toLowerCase()),
                  ) && (
                    <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] text-[var(--app-warn-fg)]">
                      <Flag size={12} />
                      Resolve suggested customers first
                    </span>
                  )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── Zendesk ticket view ───────────────────────── */

const FIELD_LABEL = "text-[13px] font-medium text-[#9aa8be]";

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RawChip({ label, value }: { label: string; value: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[#dde5ef] bg-[#f6f8fb] px-2 py-0.5 text-[11.5px] text-[#3f506b]"
      title={label}
    >
      <span className="text-[#9aa8be]">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

/** One labelled value on the ticket's header line: "Customer  Acme". */

/**
 * Markdown with every bare http(s) URL wrapped as a CommonMark autolink
 * (`<https://…>`), so it renders clickable like a `[text](url)` link. URLs
 * already inside link syntax, autolinks, quotes or code are left alone.
 * Jira bodies (ADF inline cards, pasted links) and the idea's "Supported
 * tickets" list are mostly bare URLs.
 */
function autolinkBareUrls(md: string): string {
  return md.replace(URL_RE, (url, _m, offset: number) => {
    const prev = offset > 0 ? md[offset - 1] : "";
    return /[(<\["'=`]/.test(prev) ? url : `<${url}>`;
  });
}

/** Plain text with every http(s) URL turned into a link — raw ticket text as reporters typed it. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary hover:underline"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={FIELD_LABEL}>{label}</span>
      <span className="text-[13px] font-medium text-foreground">{children}</span>
    </span>
  );
}

/**
 * The ticket as evidence (what the reporter wrote), then PMOS's evaluation
 * of it, then every raw column verbatim (collapsed) — so nothing an export
 * carries is ever lost, and the reporter's words stay visibly apart from
 * what PMOS inferred. Type and priority are not used by the product yet, so
 * they live only under "All fields".
 */
/**
 * Raw Jira issue, laid out like the raw Zendesk ticket: the fields a PM
 * reads first on top, the description as Jira formats it, and every field in
 * an "All fields" dropdown. The link to Jira lives in the header pill.
 */
function JiraIssueView({
  src,
  productLineLabel,
}: {
  src: JiraSource;
  productLineLabel: string;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const created = formatDate(src.createdAt);
  const all: [string, string | undefined][] = [
    ["Key", src.id],
    ["Type", src.issueType],
    ["Status", src.status],
    ["Priority", src.priority],
    [productLineLabel, src.products.join(", ") || undefined],
    ["Reporter", src.reporter],
    ["Assignee", src.assignee],
    ["Customers (read from text)", src.customers?.join(", ") || undefined],
    ["Created", created ?? undefined],
    ["Link", src.url],
  ];
  return (
    <>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {src.products.length > 0 && (
          <Field label={productLineLabel}>{src.products.join(", ")}</Field>
        )}
        {src.status && <Field label="Status">{src.status}</Field>}
        <Field label="Assignee">
          {src.assignee || <span className="font-normal text-muted">Unassigned</span>}
        </Field>
        <Field label="Reporter">
          {src.reporter || <span className="font-normal text-muted">Unknown</span>}
        </Field>
        {created && <Field label="Created">{created}</Field>}
      </div>
      <div>
        <div className={`${MONO_LABEL} mb-1.5`}>Description</div>
        {src.body ? (
          <UmMarkdown content={autolinkBareUrls(src.body)} className="source-text" />
        ) : (
          <p className="m-0 text-[13.5px] italic text-muted">No description.</p>
        )}
      </div>
      <div className="border-t border-[#e8eef7] pt-3">
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-[#7a8aa3] hover:text-foreground"
          aria-expanded={allOpen}
        >
          {allOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          All fields ({all.length})
        </button>
        {allOpen && (
          <dl className="mt-2 grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1 text-xs">
            {all.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate font-mono text-[11px] text-[#9aa8be]" title={k}>
                  {k}
                </dt>
                <dd className={`m-0 whitespace-pre-wrap break-words ${v ? "text-foreground" : "text-[#c3ccd8]"}`}>
                  {v ? <Linkified text={v} /> : "—"}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  );
}

function TicketView({
  ticket,
  csvMapping,
  ideasById,
  customerCatalog,
  customerColors,
  onOpenIdea,
}: {
  ticket: ZendeskTicket;
  csvMapping: CsvMapping;
  ideasById?: Map<string, Idea>;
  customerCatalog: string[];
  customerColors: Record<string, string>;
  onOpenIdea?: (id: string) => void;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const raw = ticket.raw ?? {};
  const mapped = extractMappedFields(raw, csvMapping);
  const created = formatDate(ticket.createdAt);
  const chips: { label: string; value: string }[] = [
    ...(mapped.severity ? [{ label: "Severity", value: mapped.severity }] : []),
    ...(ticket.dealRelated ? [{ label: "Deal related", value: ticket.dealRelated }] : []),
  ];
  const verbatimAffected = mapped.customers.filter(
    (c) => c.toLowerCase() !== (ticket.customerName ?? "").toLowerCase(),
  );
  const notes = ticket.matchNotes ?? [];
  const rawEntries = Object.entries(raw);

  return (
    <>
      {/* ── Raw ticket: what the reporter wrote ── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
          <Field label="Customer">
            {ticket.customerName || <span className="font-normal text-muted">Not named</span>}
          </Field>
          <Field label="Reported by">
            {ticket.requester || <span className="font-normal text-muted">Unknown</span>}
          </Field>
          {ticket.module && <Field label="Module">{ticket.module}</Field>}
          {created && <Field label="Created">{created}</Field>}
        </div>
        <div>
          <div className={`${MONO_LABEL} mb-1.5`}>Description</div>
          <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            <Linkified text={ticket.body} />
          </div>
        </div>
        {ticket.whyBuild && (
          <div>
            <div className={`${MONO_LABEL} mb-1.5`}>Why should we build this?</div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
              <Linkified text={ticket.whyBuild} />
            </div>
          </div>
        )}
        {ticket.insights && (
          <div>
            <div className={`${MONO_LABEL} mb-1.5`}>What insights do we have?</div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
              <Linkified text={ticket.insights} />
            </div>
          </div>
        )}
        {verbatimAffected.length > 0 && (
          <div className="text-xs text-muted">
            <span className={FIELD_LABEL}>Affected customers (as written)</span>{" "}
            {verbatimAffected.join(", ")}
          </div>
        )}
        {(ticket.tags.length > 0 || chips.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={`${FIELD_LABEL} mr-0.5`}>Tags</span>
            {chips.map((c) => (
              <RawChip key={c.label} label={c.label} value={c.value} />
            ))}
            {ticket.tags.map((t) => (
              <span
                key={t}
                className="rounded bg-[#eef1f6] px-1.5 py-0.5 font-mono text-[11px] text-[#4a5b74]"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── PMOS's evaluation — kept apart from the evidence ── */}
      <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-[rgba(240,244,250,.7)] px-4 py-3">
        <span className="font-title inline-flex items-center gap-1.5 text-[13px] font-bold text-foreground">
          <PmosMark size={20} />
          Evaluation
        </span>
        {ticket.catalog ? (
          <div className="text-[13px] leading-relaxed">
            <span className="font-semibold">{CATALOG_KIND_LABELS[ticket.catalog.kind]}</span>
            {ticket.catalog.reason ? (
              <span className="text-muted"> — {ticket.catalog.reason}</span>
            ) : null}
          </div>
        ) : (
          <div className="text-[13px] text-muted">Not evaluated yet.</div>
        )}
        {(ticket.affectedCustomers ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className={`${FIELD_LABEL} mr-0.5`}>Customers</span>
            {(ticket.affectedCustomers ?? []).map((c) => {
              const dismissed = (ticket.dismissedCustomers ?? []).some(
                (k) => k.toLowerCase() === c.toLowerCase(),
              );
              const suggested = !customerCatalog.some(
                (k) => k.toLowerCase() === c.toLowerCase(),
              );
              return (
                <span
                  key={`ticket-customer-${c}`}
                  title={
                    dismissed
                      ? "Dismissed on the idea — restorable there"
                      : suggested
                        ? "Suggested customer — review on the idea"
                        : undefined
                  }
                  className={
                    dismissed
                      ? "rounded-chip bg-[#eef1f6] px-[7px] py-[2px] font-mono text-[11px] font-semibold text-[#7a8496] line-through"
                      : suggested
                        ? "rounded-chip border border-dashed border-[var(--app-warn)] bg-[var(--app-warn-bg)] px-[7px] py-[2px] font-mono text-[11px] font-semibold text-[var(--app-warn-fg)]"
                        : "rounded-chip px-[7px] py-[2px] font-mono text-[11px] font-semibold"
                  }
                  style={
                    dismissed || suggested
                      ? undefined
                      : chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)
                  }
                >
                  {c}
                </span>
              );
            })}
          </div>
        )}
        {notes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`${FIELD_LABEL} mr-0.5 whitespace-nowrap`}>
              {notes.length > 1 ? `Split into ${notes.length} ideas` : "Idea"}
            </span>
            {notes.map((n) => {
              const idea = ideasById?.get(n.ideaId);
              const tone = n.merged ? STATUS_TONES.updated : STATUS_TONES.new;
              if (!idea)
                return (
                  <span key={n.unit} className="text-[12px] text-muted">
                    (idea no longer exists)
                  </span>
                );
              return (
                <button
                  key={n.unit}
                  type="button"
                  onClick={() => onOpenIdea?.(idea.id)}
                  disabled={!onOpenIdea}
                  title={`${n.merged ? "Merged into" : "New idea"}: ${idea.title}${n.reason ? ` — ${n.reason}` : ""}`}
                  className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border bg-white py-[3px] pl-2.5 pr-1.5 text-[12px] font-medium transition-colors hover:border-primary disabled:cursor-default"
                  style={{ borderColor: `color-mix(in srgb, ${tone.solid} 40%, white)`, color: tone.fg }}
                >
                  <span className="truncate text-fg-2">{idea.title}</span>
                  <ChevronRight size={12} className="shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── All fields: the raw row verbatim — nothing dropped ── */}
      {rawEntries.length > 0 && (
        <div className="border-t border-[#e8eef7] pt-3">
          <button
            type="button"
            onClick={() => setAllOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-[#7a8aa3] hover:text-foreground"
            aria-expanded={allOpen}
          >
            {allOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            All fields ({rawEntries.length})
          </button>
          {allOpen && (
            <dl className="mt-2 grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1 text-xs">
              {rawEntries.map(([k, v]) => {
                const empty = !v || !v.trim();
                return (
                  <div key={k} className="contents">
                    <dt className="truncate font-mono text-[11px] text-[#9aa8be]" title={k}>
                      {k}
                    </dt>
                    <dd
                      className={`m-0 whitespace-pre-wrap break-words ${
                        empty ? "text-[#c3ccd8]" : "text-foreground"
                      }`}
                    >
                      {empty ? "—" : <Linkified text={v} />}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
      )}
    </>
  );
}
