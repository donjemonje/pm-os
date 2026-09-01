"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RotateCcw,
  X,
} from "lucide-react";
import { badgeOf, needsApproval, scoreOf, votesLabel } from "@/lib/ideas/idea";
import type { Idea, JiraSource, ZendeskTicket } from "@/lib/ideas/types";

type SourceSel = { kind: "zen" | "jira"; key: string };

interface IdeaDrawerProps {
  /** null when opening a standalone source (e.g. from the Merge page). */
  idea: Idea | null;
  /** When set, the drawer opens directly on this source. */
  initialSource?: SourceSel | null;
  ticketsByKey: Map<string, ZendeskTicket>;
  jiraByKey: Map<string, JiraSource>;
  /** Customer catalog names — chips for names outside it render as suggestions. */
  customerCatalog?: string[];
  /** Approve adds the suggested customer to the catalog; dismiss hides it on this idea (reversible); undismiss restores it. */
  onCustomerAction?: (action: "approve" | "dismiss" | "undismiss", name: string) => void;
  onClose: () => void;
  onToggleApprove?: () => void;
  /** Set only while this idea's last-merge write is undoable AND the ideasUndo flag is on. */
  onUndoPush?: () => void;
  onSave?: (patch: { title: string; details: string; manual: number | null }) => void;
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

  const ticket = srcSel?.kind === "zen" ? ticketsByKey.get(srcSel.key) : undefined;
  const jiraSrc = srcSel?.kind === "jira" ? jiraByKey.get(srcSel.key) : undefined;
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
          { label: "Score", value: score.value != null ? String(score.value) : "—" },
          { label: "PM-OS", value: idea.pmScore != null ? String(idea.pmScore) : "—" },
          { label: "Manual", value: idea.manual != null ? String(idea.manual) : "—" },
          { label: "Votes", value: votes ?? "—" },
        ];

  if (!idea && !viewingSource) return null;

  const sourceEntries = idea
    ? [
        ...idea.zen.flatMap((key) => {
          const t = ticketsByKey.get(key);
          return t
            ? [{ kind: "zen" as const, key, id: t.id, title: t.subject, tag: ZEN_TAG }]
            : [];
        }),
        ...idea.jira.flatMap((key) => {
          const s = jiraByKey.get(key);
          return s
            ? [{ kind: "jira" as const, key, id: s.id, title: s.title, tag: JIRA_TAG }]
            : [];
        }),
      ]
    : [];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
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
                      background: badge.bg === "transparent" ? "#ffffff" : badge.bg,
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
              (idea.customers ?? []).length > 0) && (
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
                {(idea.customers ?? []).map((c) => {
                  const suggested = !customerCatalog.some(
                    (k) => k.toLowerCase() === c.toLowerCase()
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
          {!viewingSource && idea && (idea.dismissedCustomers ?? []).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setShowDismissed((v) => !v)}
                className="font-mono text-[10.5px] font-medium text-[#9aa8be] hover:text-foreground"
              >
                {showDismissed ? "▾" : "▸"} {(idea.dismissedCustomers ?? []).length} dismissed
                customer{(idea.dismissedCustomers ?? []).length === 1 ? "" : "s"}
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
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))" }}>
              {stats.map((st) => (
                <div key={st.label} className="rounded-lg bg-background px-2.5 py-2">
                  <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#7a8aa3]">
                    {st.label}
                  </div>
                  <div className="font-title text-base font-bold">{st.value}</div>
                </div>
              ))}
            </div>
          )}
          {!viewingSource && score && (
            <span className="text-[11px] text-[#9aa8be]">{score.src}</span>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
          {ticket ? (
            <>
              <div>
                <div className={`${MONO_LABEL} mb-1.5`}>Description</div>
                <div className="text-[13.5px] leading-relaxed text-foreground">{ticket.body}</div>
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted">
                {ticket.catalog && (
                  <span>
                    Catalog:{" "}
                    {ticket.catalog.kind === "fr"
                      ? "Feature request"
                      : ticket.catalog.kind === "bug"
                        ? "Bug"
                        : "Needs more details"}
                    {ticket.catalog.reason ? ` — ${ticket.catalog.reason}` : ""}
                  </span>
                )}
                {ticket.requester && <span>Requester: {ticket.requester}</span>}
                {(ticket.affectedCustomers ?? []).length > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    Affected customers:
                    {(ticket.affectedCustomers ?? []).map((c) => {
                      const dismissed = (ticket.dismissedCustomers ?? []).some(
                        (k) => k.toLowerCase() === c.toLowerCase()
                      );
                      const suggested = !customerCatalog.some(
                        (k) => k.toLowerCase() === c.toLowerCase()
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
                  </span>
                )}
                {ticket.createdAt && <span>Created: {ticket.createdAt}</span>}
                {ticket.tags.length > 0 && <span>Tags: {ticket.tags.join(", ")}</span>}
              </div>
            </>
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
              <div className="flex w-[140px] flex-col gap-1.5">
                <span className={MONO_LABEL}>Manual score</span>
                <input
                  type="number"
                  value={editManual}
                  onChange={(e) => setEditManual(e.target.value)}
                  placeholder="—"
                  className="font-title w-full rounded-lg border border-border px-2.5 py-2 text-sm font-semibold outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]"
                />
                <span className="text-[11px] text-[#9aa8be]">Overrides the displayed score</span>
              </div>
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
              {idea.batch === "updated" && (idea.batchChanges ?? []).length > 0 && (
                <div className="rounded-lg border border-[rgba(122,167,255,.35)] bg-[rgba(122,167,255,.07)] px-3.5 py-2.5">
                  <div className={`${MONO_LABEL} mb-1.5`}>Updated this import</div>
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
                <div className={`${MONO_LABEL} mb-1.5`}>Details ({idea.batch})</div>
                <div className="whitespace-pre-line text-[13.5px] leading-relaxed text-foreground">
                  {idea.details}
                </div>
              </div>
              {(idea.reporters ?? []).length > 0 && (
                <div className="text-xs text-muted">
                  Reported by {(idea.reporters ?? []).join(", ")}
                </div>
              )}
              {sourceEntries.length > 0 && (
                <div>
                  <div className={`${MONO_LABEL} mb-2`}>Sources · {sourceEntries.length}</div>
                  <div className="flex flex-col gap-2">
                    {sourceEntries.map((src) => (
                      <button
                        key={`${src.kind}:${src.key}`}
                        onClick={() => setSrcSel({ kind: src.kind, key: src.key })}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-[#e2eaf4] bg-[#f7fafd] px-3 py-2.5 text-left transition-colors hover:border-primary"
                      >
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold"
                          style={src.tag}
                        >
                          {src.id}
                        </span>
                        <span className="min-w-0 flex-1 text-[13px] leading-snug text-[#33445e]">
                          {src.title}
                        </span>
                        <ChevronRight size={13} className="shrink-0 text-[#9aa8be]" />
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
                {needsApproval(idea) && (() => {
                  // Unresolved suggested metadata (customers outside the
                  // catalog) blocks approval — same rule the server enforces.
                  const blocked =
                    idea.decision === "pending" &&
                    (idea.customers ?? []).some(
                      (c) => !customerCatalog.some((n) => n.toLowerCase() === c.toLowerCase())
                    );
                  return (
                  <button
                    onClick={() => onToggleApprove?.()}
                    disabled={blocked}
                    title={blocked ? "Approve or dismiss the suggested customers first" : undefined}
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
