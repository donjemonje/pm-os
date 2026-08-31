"use client";

import { Check } from "lucide-react";
import { scoreOf } from "@/lib/ideas/idea";
import type { Idea, JiraSource, MergeEdit, ZendeskTicket } from "@/lib/ideas/types";

type SourceKind = "zen" | "jira";

interface MergePageProps {
  ideas: Idea[];
  tickets: ZendeskTicket[];
  jiraSources: JiraSource[];
  query: string;
  productFilter: string[];
  platformFilter: string[];
  customerFilter: string[];
  pendingOnly: boolean;
  mergeFilter: "Merge" | "Single";
  edit: MergeEdit | null;
  selectedFinalId: string | "auto" | null;
  onStartEdit: (id: string) => void;
  onToggleSrc: (kind: SourceKind, key: string) => void;
  onOpenIdea: (id: string) => void;
  onOpenSource: (kind: SourceKind, key: string) => void;
}

const COL_HEADER =
  "border-b border-[#e8eef7] px-3.5 py-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#7a8aa3]";

interface SourceRow {
  key: string;
  id: string;
  text: string;
  checked: boolean;
  selected: boolean;
  orphan: boolean;
  owners: number;
  ownerId: string | null;
  /** Catalog label for parked tickets (Bug / Needs details). */
  parkLabel?: string;
}

export function MergePage({
  ideas,
  tickets,
  jiraSources,
  query,
  productFilter,
  platformFilter,
  customerFilter,
  pendingOnly,
  mergeFilter,
  edit,
  selectedFinalId,
  onStartEdit,
  onToggleSrc,
  onOpenIdea,
  onOpenSource,
}: MergePageProps) {
  const matches = (i: Idea): boolean => {
    // Same rule as the Final page: the mostly-unchanged Jira backlog is
    // noise here — unchanged ideas stay out of the merge view.
    if (i.batch === "unchanged") return false;
    const q = query.trim().toLowerCase();
    if (q && !i.title.toLowerCase().includes(q)) return false;
    if (productFilter.length > 0 && !i.products.some((p) => productFilter.includes(p))) return false;
    if (platformFilter.length > 0 && !(i.platforms ?? []).some((p) => platformFilter.includes(p)))
      return false;
    if (customerFilter.length > 0 && !(i.customers ?? []).some((c) => customerFilter.includes(c)))
      return false;
    if (pendingOnly && i.decision !== "pending") return false;
    return true;
  };

  const srcCount = (i: Idea) => i.zen.length + i.jira.length;

  const finals = ideas
    .filter(matches)
    .map((i) => ({ idea: i, count: srcCount(i) }))
    .filter((c) => c.count === 0 || (mergeFilter === "Merge" ? c.count > 1 : c.count === 1))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const av = scoreOf(a.idea).value ?? -1;
      const bv = scoreOf(b.idea).value ?? -1;
      return bv - av;
    });

  const selId = edit
    ? edit.ideaId
    : selectedFinalId === "auto"
      ? (finals[0]?.idea.id ?? null)
      : selectedFinalId;

  // Sources of visible finals first (in finals order), then every remaining
  // source, deduped — shared sources appear once with an N× tag.
  const buildRows = (
    kind: SourceKind,
    all: Array<{ key: string; id: string; title: string; parkLabel?: string }>
  ): SourceRow[] => {
    const refs = (i: Idea) => (kind === "zen" ? i.zen : i.jira);
    const editRefs = edit ? (kind === "zen" ? edit.zen : edit.jira) : null;
    const ownersOf = (key: string) => ideas.filter((i) => refs(i).includes(key));
    const rows: SourceRow[] = [];
    const seen = new Set<string>();
    const push = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const src = all.find((s) => s.key === key);
      if (!src) return;
      const owners = ownersOf(key);
      // Sources backing only unchanged ideas are hidden with them; edit mode
      // shows the full pool so any backlog item can still be attached.
      if (!edit && owners.length > 0 && owners.every((o) => o.batch === "unchanged")) return;
      rows.push({
        key,
        id: src.id,
        text: src.title,
        checked: editRefs != null && editRefs.includes(key),
        selected: owners.some((o) => o.id === selId),
        orphan: owners.length === 0,
        owners: owners.length,
        ownerId: owners[0]?.id ?? null,
        parkLabel: src.parkLabel,
      });
    };
    for (const c of finals) for (const key of refs(c.idea)) push(key);
    for (const src of all) push(src.key);
    return rows;
  };

  const zenRows = buildRows(
    "zen",
    tickets.map((t) => ({
      key: t.key,
      id: t.id,
      title: t.subject,
      parkLabel:
        t.catalog && t.catalog.kind !== "fr"
          ? t.catalog.kind === "bug"
            ? "Bug"
            : "Needs details"
          : undefined,
    }))
  );
  const jiraRows = buildRows(
    "jira",
    jiraSources.map((s) => ({ key: s.key, id: s.id, title: s.title }))
  );

  const renderColumn = (kind: SourceKind, label: string, rows: SourceRow[], emptyText: string) => (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      <div className={COL_HEADER}>
        {label} · {rows.length}
      </div>
      <div>
        {rows.map((row) => (
          <div
            key={row.key}
            onClick={() => {
              if (edit) onToggleSrc(kind, row.key);
              else if (row.ownerId) onStartEdit(row.ownerId);
            }}
            className="flex cursor-pointer items-center gap-2 border-b border-[#eef3f9] px-3 py-2"
            style={{
              background: row.checked || (row.selected && !edit) ? "#daf0e2" : "#ffffff",
              opacity: row.orphan && !row.checked ? 0.5 : 1,
            }}
          >
            {edit && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSrc(kind, row.key);
                }}
                className="flex h-[15px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded border text-white"
                style={{
                  background: row.checked ? "#1f8a53" : "#ffffff",
                  borderColor: row.checked ? "#1f8a53" : "#c8d4e3",
                }}
              >
                {row.checked && <Check size={9} strokeWidth={3.5} />}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenSource(kind, row.key);
              }}
              title={kind === "zen" ? "Open ticket" : "Open Jira idea"}
              className="shrink-0 font-mono text-[10.5px] font-semibold text-primary hover:text-primary-hover hover:underline"
            >
              {row.id}
            </button>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[#33445e]">
              {row.text}
            </span>
            {row.parkLabel && (
              <span className="shrink-0 rounded-full border border-[#dde5ef] bg-[#eef1f6] px-[5px] py-px font-mono text-[9.5px] font-semibold text-[#7a8496]">
                {row.parkLabel}
              </span>
            )}
            {row.owners > 1 && (
              <span
                title="Used in more than one idea"
                className="shrink-0 rounded-full border border-[rgba(122,167,255,.4)] bg-[rgba(122,167,255,.14)] px-[5px] py-px font-mono text-[9.5px] font-semibold text-[#3b6fd4]"
              >
                {row.owners}×
              </span>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-xs text-muted">{emptyText}</div>}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-[1fr_1fr_1.15fr] items-start gap-5">
      {renderColumn("zen", "Zendesk", zenRows, "No Zendesk sources")}
      {renderColumn("jira", "Jira", jiraRows, "No Jira sources")}

      {/* Final column */}
      <div className="overflow-hidden rounded-xl border border-border bg-white">
        <div className={COL_HEADER}>Final · {finals.length}</div>
        <div>
          {finals.map(({ idea, count }) => {
            const gone = count === 0;
            const sel = idea.id === selId;
            return (
              <div
                key={idea.id}
                onClick={() => onStartEdit(idea.id)}
                className="flex cursor-pointer items-center gap-2 border-b border-[#eef3f9] px-3 py-2"
                style={{
                  background: sel && !gone ? "#daf0e2" : "#ffffff",
                  opacity: gone ? 0.55 : 1,
                }}
              >
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px]">
                  {idea.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenIdea(idea.id);
                  }}
                  title="Open idea"
                  className="shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-mono text-[10px] font-semibold hover:border-primary hover:shadow-[0_0_0_1px_rgba(122,167,255,.3)]"
                  style={{
                    background: gone ? "#f7eef1" : sel ? "#c4e8d2" : "#f0f4fa",
                    color: gone ? "#a3556b" : sel ? "#1f8a53" : "#4a5b74",
                    borderColor: gone ? "#ecd6dd" : sel ? "#a9dcbd" : "#e2eaf4",
                  }}
                >
                  {gone ? "Deleted" : `${count} src`}
                </button>
              </div>
            );
          })}
          {finals.length === 0 && <div className="p-4 text-xs text-muted">No ideas match</div>}
        </div>
      </div>
    </div>
  );
}
