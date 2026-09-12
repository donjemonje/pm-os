"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RotateCcw,
  X,
} from "lucide-react";
import {
  badgeOf,
  needsApproval,
  SCORING_ENABLED,
  scoreOf,
  votesLabel,
  CATALOG_KIND_LABELS,
} from "@/lib/ideas/idea";
import type { Idea, JiraSource, ZendeskTicket } from "@/lib/ideas/types";
import {
  DEFAULT_CSV_MAPPING,
  extractMappedFields,
  type CsvMapping,
} from "@/lib/ideas/csv-mapping";
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
  /** Customer catalog names — chips for names outside it render as suggestions. */
  customerCatalog?: string[];
  /** Approve adds the suggested customer to the catalog; dismiss hides it on this idea (reversible); undismiss restores it. */
  onCustomerAction?: (
    action: "approve" | "dismiss" | "undismiss",
    name: string,
  ) => void;
  onClose: () => void;
  onToggleApprove?: () => void;
  /** Set only while this idea's last-merge write is undoable AND the ideasUndo flag is on. */
  onUndoPush?: () => void;
  onSave?: (patch: {
    title: string;
    details: string;
    manual: number | null;
  }) => void;
  onMerge?: () => void;
}

const MONO_LABEL =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7a8aa3]";

const ZEN_TAG = { background: "#eef1f6", color: "#4a5b74" };
const JIRA_TAG = { background: "rgba(122,167,255,.14)", color: "#3b6fd4" };

export function IdeaDrawer({
  idea,
  initialSource,
  ticketsByKey,
  jiraByKey,
  csvMapping = DEFAULT_CSV_MAPPING,
  ideasById,
  customerCatalog = [],
  onCustomerAction,
  onClose,
  onToggleApprove,
  onUndoPush,
  onSave,
  onMerge,
}: IdeaDrawerProps) {
  const [width, setWidth] = useState(480);
  const [srcSel, setSrcSel] = useState<SourceSel | null>(initialSource ?? null);
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editManual, setEditManual] = useState("");
  const [editDetails, setEditDetails] = useState("");
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
    });
    setEditMode(false);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) =>
      setWidth(Math.min(1100, Math.max(380, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const stats: { label: string; value: string }[] =
    viewingSource || !idea || !score
      ? []
      : [
          ...(SCORING_ENABLED
            ? [
                {
                  label: "Score",
                  value: score.value != null ? String(score.value) : "—",
                },
                {
                  label: "PM-OS",
                  value: idea.pmScore != null ? String(idea.pmScore) : "—",
                },
                {
                  label: "Manual",
                  value: idea.manual != null ? String(idea.manual) : "—",
                },
              ]
            : []),
          { label: "Votes", value: votes ?? "—" },
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
        className="fixed bottom-0 right-0 top-0 z-[41] flex flex-col border-l border-border bg-white shadow-[-24px_0_48px_rgba(10,22,40,.14)]"
        style={{ width }}
      >
        <div
          className="absolute -left-[3px] bottom-0 top-0 z-[42] w-2 cursor-col-resize"
          title="Drag to resize"
          onMouseDown={startResize}
        />

        {/* Header */}
        <div className="flex flex-col gap-3 border-b border-[#e8eef7] px-6 pb-4 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {viewingSource && idea && (
                <button
                  onClick={() => setSrcSel(null)}
                  title="Back to idea"
                  className="flex rounded-md p-0.5 text-[#7a8aa3] hover:text-foreground"
                >
                  <ChevronLeft size={15} />
                </button>
              )}
              {ticket ? (
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#dde5ef] px-2.5 py-0.5 text-xs font-medium"
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
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgba(122,167,255,.4)] px-2.5 py-0.5 text-xs font-medium"
                  style={JIRA_TAG}
                >
                  Jira idea <span className="font-mono">{jiraSrc.id}</span>
                </span>
              ) : (
                badge && (
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium"
                    style={{
                      background:
                        badge.bg === "transparent" ? "#ffffff" : badge.bg,
                      color: badge.fg,
                      borderColor: badge.bd,
                    }}
                  >
                    {badge.check && <Check size={11} strokeWidth={3} />}
                    {badge.label}
                  </span>
                )
              )}
            </div>
            <button
              onClick={onClose}
              className="flex rounded-md p-1 text-[#7a8aa3] hover:bg-background hover:text-foreground"
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
              className="font-title w-full rounded-lg border border-primary px-3 py-2 text-base font-semibold shadow-[0_0_0_1px_rgba(122,167,255,.3)] outline-none"
            />
          ) : (
            <h2 className="font-title m-0 text-lg font-semibold leading-snug">
              {ticket ? ticket.subject : jiraSrc ? jiraSrc.title : idea?.title}
            </h2>
          )}

          {!viewingSource &&
            idea &&
            (idea.products.length > 0 ||
              (idea.platforms ?? []).length > 0 ||
              (idea.customers ?? []).length > 0 ||
              idea.affectsAllCustomers) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {idea.products.map((p) => (
                  <span
                    key={p}
                    className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary"
                  >
                    {p}
                  </span>
                ))}
                {/* Platforms assigned by PMOS AI at import; purple per the design. */}
                {(idea.platforms ?? []).map((p) => (
                  <span
                    key={`platform-${p}`}
                    className="rounded bg-[rgba(169,140,255,.16)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#6b4bd0]"
                  >
                    {p}
                  </span>
                ))}
                {/* Affected customers from the supporting tickets; teal when
                    cataloged, amber suggestion with approve/dismiss when not. */}
                {idea.affectsAllCustomers && (
                  <span
                    title="A supporting ticket marks this as affecting all customers"
                    className="rounded bg-[rgba(122,167,255,.16)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#3b6fd4]"
                  >
                    All customers
                  </span>
                )}
                {(idea.customers ?? []).map((c) => {
                  const suggested = !customerCatalog.some(
                    (k) => k.toLowerCase() === c.toLowerCase(),
                  );
                  if (!suggested) {
                    return (
                      <span
                        key={`customer-${c}`}
                        className="rounded bg-[rgba(47,160,143,.14)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#0f7a6a]"
                      >
                        {c}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={`customer-${c}`}
                      title="Suggested customer — not in the catalog yet"
                      className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-700"
                    >
                      {c}
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
                  className="rounded-lg bg-background px-2.5 py-2"
                >
                  <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#7a8aa3]">
                    {st.label}
                  </div>
                  <div className="font-title text-base font-bold">
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
                  className="font-title w-full rounded-lg border border-border px-2.5 py-2 text-sm font-semibold outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]"
                />
                <span className="text-[11px] text-[#9aa8be]">
                  Overrides the displayed score
                </span>
              </div>
              )}
              <div className="flex flex-col gap-1.5">
                <span className={MONO_LABEL}>Details</span>
                <textarea
                  rows={12}
                  value={editDetails}
                  onChange={(e) => setEditDetails(e.target.value)}
                  className="w-full resize-y rounded-lg border border-border px-3 py-2.5 text-[13.5px] leading-relaxed outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]"
                />
              </div>
            </>
          ) : idea ? (
            <>
              {/* What this import did to an Updated idea — the PM shouldn't
                  have to diff anything by eye. */}
              {idea.batch === "updated" &&
                (idea.batchChanges ?? []).length > 0 && (
                  <div className="rounded-lg border border-[rgba(122,167,255,.35)] bg-[rgba(122,167,255,.07)] px-3.5 py-2.5">
                    <div className={`${MONO_LABEL} mb-1.5`}>
                      Updated this import
                    </div>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {(idea.batchChanges ?? []).map((c, i) => (
                        <li
                          key={`${i}-${c}`}
                          className="flex items-start gap-1.5 text-[12.5px] leading-snug text-[#33445e]"
                        >
                          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#7aa7ff]" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              <div>
                <div className={`${MONO_LABEL} mb-1.5`}>
                  Details ({idea.batch})
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
                        className="flex w-full items-center gap-2.5 rounded-lg border border-[#e2eaf4] bg-[#f7fafd] px-3 py-2.5 text-left transition-colors hover:border-primary"
                      >
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold"
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
          <div className="flex gap-2 border-t border-[#e8eef7] bg-white px-6 py-3.5">
            {editMode ? (
              <>
                <button
                  onClick={saveEdit}
                  className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover"
                >
                  Save changes
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                >
                  Cancel
                </button>
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
                      <button
                        onClick={() => onToggleApprove?.()}
                        disabled={blocked}
                        title={
                          blocked
                            ? "Approve or dismiss the suggested customers first"
                            : undefined
                        }
                        className={
                          blocked
                            ? "inline-flex h-8 cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium opacity-40"
                            : idea.decision === "pending"
                              ? "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                              : "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover"
                        }
                      >
                        <Check size={13} strokeWidth={3} />
                        {idea.decision === "pending" ? "Approve" : "Approved"}
                      </button>
                    );
                  })()}
                {onUndoPush && idea.decision === "injected" && (
                  <button
                    onClick={onUndoPush}
                    title={
                      idea.undoable?.action === "create"
                        ? `Deletes ${idea.undoable.jiraKey} in Jira (asks first)`
                        : `Restores ${idea.undoable?.jiraKey} to its pre-merge state`
                    }
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-amber-50 px-3.5 text-[13px] font-medium text-amber-800 hover:border-amber-400"
                  >
                    Undo merge
                  </button>
                )}
                {onMerge && (
                  <button
                    onClick={onMerge}
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                  >
                    Merge
                    <ArrowUpRight size={13} />
                  </button>
                )}
                <button
                  onClick={startEdit}
                  className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                >
                  Edit
                </button>
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
  "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa8be]";

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

/**
 * The ticket as evidence, then PMOS AI's reading of it, then every raw
 * column verbatim (collapsed) — so nothing an export carries is ever lost,
 * and what the reporter wrote stays visibly apart from what the model
 * inferred.
 */
function TicketView({
  ticket,
  csvMapping,
  ideasById,
  customerCatalog,
}: {
  ticket: ZendeskTicket;
  csvMapping: CsvMapping;
  ideasById?: Map<string, Idea>;
  customerCatalog: string[];
}) {
  const [allOpen, setAllOpen] = useState(false);
  const raw = ticket.raw ?? {};
  const mapped = extractMappedFields(raw, csvMapping);
  const created = formatDate(ticket.createdAt);
  const chips: { label: string; value: string }[] = [
    ...(ticket.module ? [{ label: "Module (hint)", value: ticket.module }] : []),
    ...(mapped.requestType ? [{ label: "Type", value: mapped.requestType }] : []),
    ...(mapped.priority ? [{ label: "Priority", value: mapped.priority }] : []),
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
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
          {ticket.customerName ? (
            <span className="font-semibold text-foreground">
              {ticket.customerName}
              {ticket.customerType ? (
                <span className="font-normal text-muted"> · {ticket.customerType}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted">No customer named</span>
          )}
          <span className="text-muted">
            {ticket.requester ? `Reported by ${ticket.requester}` : "Reporter unknown"}
            {created ? ` · ${created}` : ""}
          </span>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <RawChip key={c.label} label={c.label} value={c.value} />
            ))}
          </div>
        )}
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
        {ticket.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
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

      {/* ── PMOS AI's reading — interpretation, kept apart from the evidence ── */}
      <div className="flex flex-col gap-2.5 rounded-lg border border-[#e3ebf7] bg-[#f8fafd] px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className={MONO_LABEL}>PMOS AI reading</span>
          <span className="text-[11px] text-[#9aa8be]">interpretation, not ticket data</span>
        </div>
        {ticket.catalog ? (
          <div className="text-[13px] leading-relaxed">
            <span className="font-semibold">{CATALOG_KIND_LABELS[ticket.catalog.kind]}</span>
            {ticket.catalog.reason ? (
              <span className="text-muted"> — {ticket.catalog.reason}</span>
            ) : null}
          </div>
        ) : (
          <div className="text-[13px] text-muted">Not classified yet.</div>
        )}
        {ticket.affectsAllCustomers && (
          <div className="text-xs font-medium text-[#4a6fd6]">Affects all customers</div>
        )}
        {(ticket.affectedCustomers ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className={FIELD_LABEL}>Customers</span>
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
                      ? "rounded bg-[#eef1f6] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#7a8496] line-through"
                      : suggested
                        ? "rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-700"
                        : "rounded bg-[rgba(47,160,143,.14)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#0f7a6a]"
                  }
                >
                  {c}
                </span>
              );
            })}
          </div>
        )}
        {notes.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {notes.length > 1 && (
              <div className="text-xs text-muted">Split into {notes.length} ideas</div>
            )}
            {notes.map((n) => {
              const idea = ideasById?.get(n.ideaId);
              return (
                <div key={n.unit} className="text-[13px] leading-relaxed">
                  <span className="text-muted">{n.merged ? "Merged into" : "New idea"}</span>{" "}
                  {idea ? (
                    <span className="font-medium">{idea.title}</span>
                  ) : n.merged ? (
                    <span className="text-muted">(idea no longer exists)</span>
                  ) : null}
                  {n.reason ? <span className="text-muted"> — {n.reason}</span> : null}
                </div>
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
