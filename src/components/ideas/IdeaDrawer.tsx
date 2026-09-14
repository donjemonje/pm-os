"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Flag,
  GitMerge,
  Pencil,
  RotateCcw,
  X,
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
import {
  chipStyle,
  CUSTOMER_CHIP_DEFAULT,
  PRODUCT_CHIP_DEFAULT,
} from "@/lib/ideas/colors";
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

const ZEN_TAG = { background: "#e6eaf2", color: "#4a5b74" };
const JIRA_TAG = { background: "rgba(59,124,246,.15)", color: "#2a5fd0" };

export function IdeaDrawer({
  idea,
  initialSource,
  ticketsByKey,
  jiraByKey,
  csvMapping = DEFAULT_CSV_MAPPING,
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
  const [editMode, setEditMode] = useState(false);
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
  const [showDismissed, setShowDismissed] = useState(false);

  const ticket =
    srcSel?.kind === "zen" ? ticketsByKey.get(srcSel.key) : undefined;
  const jiraSrc =
    srcSel?.kind === "jira" ? jiraByKey.get(srcSel.key) : undefined;
  const viewingSource = !!ticket || !!jiraSrc;
  const badge = idea ? badgeOf(idea) : null;
  const score = idea ? scoreOf(idea) : null;
  const votes = idea ? votesLabel(idea) : null;

  const startEdit = () => {
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
    setEditMode(true);
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
    setEditMode(false);
  };
  const sameName = (a: string, b: string) => a.toLowerCase() === b.trim().toLowerCase();
  const toggleIn = (list: string[], name: string) =>
    list.some((x) => sameName(x, name)) ? list.filter((x) => !sameName(x, name)) : [...list, name];
  const addCustomer = (name: string) => {
    const n = name.trim();
    if (!n || editCustomers.some((c) => sameName(c, n))) {
      setNewCustomer("");
      return;
    }
    setEditCustomers((l) => [...l, n]);
    // Re-adding a name removed in this same edit just cancels the removal.
    if (editRemoved.some((c) => sameName(c, n))) {
      setEditRemoved((l) => l.filter((c) => !sameName(c, n)));
    } else {
      setEditAdded((l) => [...l, n]);
    }
    setNewCustomer("");
  };
  const removeCustomer = (name: string) => {
    setEditCustomers((l) => l.filter((c) => !sameName(c, name)));
    if (editAdded.some((c) => sameName(c, name))) {
      setEditAdded((l) => l.filter((c) => !sameName(c, name)));
    } else {
      setEditRemoved((l) => [...l, name]);
    }
  };

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
                  Jira idea <span className="font-mono">{jiraSrc.id}</span>
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

          {editMode && !viewingSource ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="font-title w-full rounded-control border border-primary px-3 py-2 text-[17px] font-bold shadow-[0_0_0_2px_var(--app-accent-soft)] outline-none"
            />
          ) : (
            <h2 className="font-title m-0 text-[19px] font-bold leading-[1.3] text-foreground">
              {ticket ? ticket.subject : jiraSrc ? jiraSrc.title : idea?.title}
            </h2>
          )}

          {!viewingSource &&
            idea &&
            (idea.products.length > 0 ||
              (idea.platforms ?? []).length > 0 ||
              (idea.customers ?? []).length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
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
            <>
              <div>
                <div className={`${MONO_LABEL} mb-1.5`}>Details</div>
                <div className="whitespace-pre-line text-[13.5px] leading-relaxed text-foreground">
                  {jiraSrc.body || "No description."}
                </div>
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted">
                {jiraSrc.status && <span>Status: {jiraSrc.status}</span>}
                {jiraSrc.products.length > 0 && (
                  <span>Components: {jiraSrc.products.join(", ")}</span>
                )}
              </div>
              {jiraSrc.url && (
                <a
                  href={jiraSrc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-primary hover:text-primary-hover hover:underline"
                >
                  <ExternalLink size={13} />
                  {jiraSrc.id} — View in Jira
                </a>
              )}
            </>
          ) : editMode ? (
            <>
              {SCORING_ENABLED && (
              <div className="flex w-[140px] flex-col gap-1.5">
                <span className={MONO_LABEL}>Manual score</span>
                <input
                  type="number"
                  value={editManual}
                  onChange={(e) => setEditManual(e.target.value)}
                  placeholder="—"
                  className="font-title w-full rounded-lg border border-border px-2.5 py-2 text-sm font-semibold outline-none focus:border-primary focus:shadow-[0_0_0_2px_var(--app-accent-soft)]"
                />
                <span className="text-[11px] text-[#9aa8be]">
                  Overrides the displayed score
                </span>
              </div>
              )}
              {/* Product lines — catalog names plus "Other"; PMOS's pick is a starting point, not a verdict. */}
              <div className="flex flex-col gap-1.5">
                <span className={MONO_LABEL}>Product lines</span>
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set([...catalogProducts, "Other", ...editProducts])].map((p) => {
                    const on = editProducts.some((x) => sameName(x, p));
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setEditProducts((l) => toggleIn(l, p))}
                        aria-pressed={on}
                        className={
                          on
                            ? "rounded border border-transparent px-2 py-0.5 font-mono text-[11px] font-medium ring-1 ring-black/10"
                            : "rounded border border-dashed border-[#c9d3e0] px-2 py-0.5 font-mono text-[11px] text-[#7a8aa3] hover:border-primary hover:text-foreground"
                        }
                        style={on ? chipStyle(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT) : undefined}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
              {(catalogPlatforms.length > 0 || editPlatforms.length > 0) && (
                <div className="flex flex-col gap-1.5">
                  <span className={MONO_LABEL}>Platforms</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[...new Set([...catalogPlatforms, ...editPlatforms])].map((p) => {
                      const on = editPlatforms.some((x) => sameName(x, p));
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setEditPlatforms((l) => toggleIn(l, p))}
                          aria-pressed={on}
                          className={
                            on
                              ? "rounded bg-[rgba(169,140,255,.16)] px-2 py-0.5 font-mono text-[11px] font-medium text-[#6b4bd0] ring-1 ring-black/10"
                              : "rounded border border-dashed border-[#c9d3e0] px-2 py-0.5 font-mono text-[11px] text-[#7a8aa3] hover:border-primary hover:text-foreground"
                          }
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Customers — any name, from the catalog or typed; removing a ticket-derived one dismisses it (restorable). */}
              <div className="flex flex-col gap-1.5">
                <span className={MONO_LABEL}>Customers</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {editCustomers.map((c) => {
                    const suggested = !customerCatalog.some((k) => sameName(k, c));
                    return (
                      <span
                        key={`edit-customer-${c}`}
                        className={
                          suggested
                            ? "inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-700"
                            : "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium"
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
                  <input
                    type="text"
                    list="idea-customer-options"
                    value={newCustomer}
                    onChange={(e) => setNewCustomer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomer(newCustomer);
                      }
                    }}
                    placeholder="Add customer…"
                    className="min-w-[140px] rounded-lg border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
                  />
                  <datalist id="idea-customer-options">
                    {customerCatalog
                      .filter((k) => !editCustomers.some((c) => sameName(c, k)))
                      .map((k) => (
                        <option key={k} value={k} />
                      ))}
                  </datalist>
                </div>
                <span className="text-[11px] text-[#9aa8be]">
                  Enter adds. A name outside the catalog is kept as a suggestion until approved.
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={MONO_LABEL}>Details</span>
                <textarea
                  rows={12}
                  value={editDetails}
                  onChange={(e) => setEditDetails(e.target.value)}
                  className="w-full resize-y rounded-lg border border-border px-3 py-2.5 text-[13.5px] leading-relaxed outline-none focus:border-primary focus:shadow-[0_0_0_2px_var(--app-accent-soft)]"
                />
              </div>
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
              <div>
                <div className={`${MONO_LABEL} mb-1.5`}>
                  Details
                </div>
                <UmMarkdown
                  content={idea.details}
                  className="text-[13.5px] leading-relaxed"
                />
              </div>
              {sourceEntries.length > 0 && (
                <div>
                  <div className={`${MONO_LABEL} mb-2`}>
                    Sources · {sourceEntries.length}
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
            {editMode ? (
              <>
                <Button variant="primary" glow onClick={saveEdit}>
                  Save changes
                </Button>
                <Button onClick={() => setEditMode(false)}>Cancel</Button>
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
                        : `Restores ${idea.undoable?.jiraKey} to its pre-merge state`
                    }
                  >
                    Undo merge
                  </Button>
                )}
                {onMerge && (
                  <Button onClick={onMerge}>
                    <GitMerge size={13} strokeWidth={2.25} />
                    Merge
                  </Button>
                )}
                <Button onClick={startEdit}>
                  <Pencil size={13} />
                  Edit
                </Button>
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

const FIELD_LABEL =
  "font-mono text-[10px] font-semibold tracking-[0.06em] text-[#9aa8be]";

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
            {ticket.body}
          </div>
        </div>
        {ticket.whyBuild && (
          <div>
            <div className={`${MONO_LABEL} mb-1.5`}>Why should we build this?</div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
              {ticket.whyBuild}
            </div>
          </div>
        )}
        {ticket.insights && (
          <div>
            <div className={`${MONO_LABEL} mb-1.5`}>What insights do we have?</div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
              {ticket.insights}
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
                      {empty ? "—" : v}
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
