"use client";

import { useEffect, useState } from "react";
import { Check, Layers, LifeBuoy, Sparkles, X } from "lucide-react";
import { ApproveMark } from "@/components/ui/ApproveMark";
import { Chip } from "@/components/ui/Chip";
import { chipStyle, PRODUCT_CHIP_DEFAULT } from "@/lib/ideas/colors";
import {
  CATALOG_KIND_LABELS,
  compareIdeas,
  STATUS_CHIP_TO_BATCH,
} from "@/lib/ideas/idea";
import type {
  Idea,
  JiraSource,
  MergeEdit,
  ZendeskTicket,
} from "@/lib/ideas/types";

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
  /** Shared Status filter from the toolbar (chip labels; empty = all except Unchanged). */
  statusFilter: string[];
  edit: MergeEdit | null;
  selectedFinalId: string | null;
  onStartEdit: (id: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleSrc: (kind: SourceKind, key: string) => void;
  onOpenIdea: (id: string) => void;
  onOpenSource: (kind: SourceKind, key: string) => void;
  /** Catalog chip colors (palette ids) by product-line name. */
  productColors?: Record<string, string>;
}

/** Case-insensitive lookup of a catalog color by name. */
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

/** Selected / checked row: green wash with an inset bar on the left. */
const SELECTED_ROW = {
  background: "linear-gradient(90deg, rgba(23,178,106,.18), rgba(23,178,106,.06))",
  boxShadow: "inset 3px 0 0 #17b26a",
};

const ROW =
  "flex h-[44px] cursor-pointer items-center gap-2.5 border-b border-hairline px-3 transition-colors duration-150 last:border-b-0";

interface SourceRow {
  key: string;
  id: string;
  text: string;
  checked: boolean;
  selected: boolean;
  orphan: boolean;
  owners: number;
  ownerId: string | null;
  /** Catalog label for parked tickets (Bug / Needs details / Ops task / Question). */
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
  statusFilter,
  edit,
  selectedFinalId,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleSrc,
  onOpenIdea,
  onOpenSource,
  productColors = {},
}: MergePageProps) {
  // The mostly-unchanged Jira backlog is noise: unchanged ideas show only
  // when the Status filter says Unchanged, same as the Final page.
  const unchangedView = statusFilter.includes("Unchanged");
  const allView = statusFilter.includes("All");

  const matches = (i: Idea): boolean => {
    if (allView) {
      // "All" shows everything, the unchanged backlog included.
    } else if (unchangedView) {
      if (i.batch !== "unchanged") return false;
    } else {
      if (i.batch === "unchanged") return false;
      if (
        statusFilter.length > 0 &&
        !statusFilter.some((s) => STATUS_CHIP_TO_BATCH[s] === i.batch)
      )
        return false;
    }
    const q = query.trim().toLowerCase();
    if (q && !i.title.toLowerCase().includes(q)) return false;
    if (
      productFilter.length > 0 &&
      !i.products.some((p) => productFilter.includes(p))
    )
      return false;
    if (
      platformFilter.length > 0 &&
      !(i.platforms ?? []).some((p) => platformFilter.includes(p))
    )
      return false;
    if (
      customerFilter.length > 0 &&
      !(i.customers ?? []).some((c) => customerFilter.includes(c))
    )
      return false;
    if (pendingOnly && i.decision !== "pending") return false;
    return true;
  };

  const srcCount = (i: Idea) => i.zen.length + i.jira.length;

  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const editedIdea = edit ? ideas.find((i) => i.id === edit.ideaId) : undefined;
  const editDirty =
    edit != null &&
    editedIdea != null &&
    !(sameSet(edit.zen, editedIdea.zen) && sameSet(edit.jira, editedIdea.jira));

  const finals = ideas
    .filter(matches)
    .map((i) => ({ idea: i, count: srcCount(i) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return compareIdeas(a.idea, b.idea);
    });

  const selId = edit ? edit.ideaId : selectedFinalId;

  // Clicking a source's N× badge highlights every idea it backs — the same
  // green as merge-edit, view-only: no checkboxes, no save/discard.
  const [highlightSrc, setHighlightSrc] = useState<{
    kind: SourceKind;
    key: string;
  } | null>(null);
  useEffect(() => {
    if (edit) setHighlightSrc(null);
  }, [edit]);
  useEffect(() => {
    if (!highlightSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHighlightSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [highlightSrc]);
  const highlightedIdeaIds = new Set(
    highlightSrc
      ? ideas
          .filter((i) =>
            (highlightSrc.kind === "zen" ? i.zen : i.jira).includes(
              highlightSrc.key,
            ),
          )
          .map((i) => i.id)
      : [],
  );

  // Sources of visible finals first (in finals order), then every remaining
  // source, deduped — shared sources appear once with an N× tag.
  const buildRows = (
    kind: SourceKind,
    all: Array<{ key: string; id: string; title: string; parkLabel?: string }>,
  ): SourceRow[] => {
    const refs = (i: Idea) => (kind === "zen" ? i.zen : i.jira);
    const editRefs = edit ? (kind === "zen" ? edit.zen : edit.jira) : null;
    const ownersOf = (key: string) =>
      ideas.filter((i) => refs(i).includes(key));
    const rows: SourceRow[] = [];
    const seen = new Set<string>();
    const push = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const src = all.find((s) => s.key === key);
      if (!src) return;
      const owners = ownersOf(key);
      // Sources backing only unchanged ideas are hidden with them; the
      // Unchanged chip and edit mode (attach-anything) show the full pool.
      if (
        !edit &&
        !unchangedView &&
        !allView &&
        owners.length > 0 &&
        owners.every((o) => o.batch === "unchanged")
      )
        return;
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
          ? CATALOG_KIND_LABELS[t.catalog.kind]
          : undefined,
    })),
  );
  const jiraRows = buildRows(
    "jira",
    jiraSources.map((s) => ({ key: s.key, id: s.id, title: s.title })),
  );

  const columnFrame = (
    label: string,
    count: number,
    Icon: typeof Layers,
    children: React.ReactNode,
  ) => (
    <div className="glass overflow-hidden rounded-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-3">
        <Icon size={13} strokeWidth={2.25} className="text-primary" />
        <span>{label}</span>
        <span className="ml-auto rounded-full bg-[rgba(12,25,41,.06)] px-[7px] py-px tracking-normal">
          {count}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );

  const tag = (text: string, accent?: boolean, active?: boolean, extra?: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const cls = active
      ? "border-[#17b26a] bg-[rgba(23,178,106,.16)] text-[#0f7a47]"
      : accent
        ? "border-[rgba(36,87,245,.4)] bg-[var(--app-accent-soft)] text-[#2a5fd0] hover:border-primary"
        : "border-[#dde5ef] bg-[#eef1f6] text-[#7a8496]";
    const base = `shrink-0 rounded-full border px-[6px] py-px font-mono text-[9.5px] font-semibold ${cls}`;
    return extra ? (
      <button {...extra} className={base}>
        {text}
      </button>
    ) : (
      <span className={base}>{text}</span>
    );
  };

  const renderColumn = (
    kind: SourceKind,
    label: string,
    Icon: typeof Layers,
    rows: SourceRow[],
    emptyText: string,
  ) =>
    columnFrame(
      label,
      rows.length,
      Icon,
      <>
        {rows.map((row) => {
          const lit =
            row.checked ||
            (!edit &&
              (highlightSrc
                ? highlightSrc.kind === kind && highlightSrc.key === row.key
                : row.selected));
          return (
            <div
              key={row.key}
              onClick={() => {
                if (edit) onToggleSrc(kind, row.key);
                else if (row.ownerId) onStartEdit(row.ownerId);
              }}
              className={`${ROW} hover:bg-white/60`}
              style={{
                ...(lit ? SELECTED_ROW : {}),
                opacity: row.orphan && !row.checked ? 0.55 : 1,
              }}
            >
              <span
                className="shrink-0 overflow-hidden transition-[width,margin,opacity] duration-200 ease-out"
                style={{
                  width: edit ? 15 : 0,
                  marginRight: edit ? 0 : -10,
                  opacity: edit ? 1 : 0,
                }}
              >
                <ApproveMark
                  on={row.checked}
                  round={false}
                  size={15}
                  title={row.checked ? "Detach from this idea" : "Attach to this idea"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (edit) onToggleSrc(kind, row.key);
                  }}
                />
              </span>
              <div
                className={`flex min-w-0 flex-1 items-center gap-2 transition-transform duration-150 ease-out ${
                  row.checked ? "translate-x-1" : ""
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSource(kind, row.key);
                  }}
                  title={kind === "zen" ? "Open ticket" : "Open Jira idea"}
                  className="shrink-0 font-mono text-[10.5px] font-bold text-primary hover:text-primary-hover hover:underline"
                >
                  {row.id}
                </button>
                <span
                  className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-fg-2 ${
                    row.checked ? "font-semibold" : ""
                  }`}
                >
                  {row.text}
                </span>
              </div>
              {row.parkLabel && tag(row.parkLabel)}
              {row.owners > 1 &&
                tag(
                  `${row.owners}×`,
                  true,
                  !edit && highlightSrc?.kind === kind && highlightSrc?.key === row.key,
                  {
                    onClick: (e) => {
                      if (edit) return;
                      e.stopPropagation();
                      setHighlightSrc((cur) =>
                        cur && cur.kind === kind && cur.key === row.key
                          ? null
                          : { kind, key: row.key },
                      );
                    },
                    title: edit
                      ? "Used in more than one idea"
                      : "Highlight the ideas using this source (Esc clears)",
                  },
                )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="p-4 text-xs text-fg-3">{emptyText}</div>}
      </>,
    );

  // No Jira connected (no Jira sources at all) → two columns; the board
  // widens instead of showing an empty Jira column.
  const hasJira = jiraSources.length > 0;

  return (
    <div
      className={`grid items-start gap-4 ${
        hasJira ? "grid-cols-[1fr_1fr_1.15fr]" : "grid-cols-[1fr_1.15fr]"
      }`}
    >
      {renderColumn("zen", "Zendesk", LifeBuoy, zenRows, "No Zendesk sources")}
      {hasJira && renderColumn("jira", "Jira", Layers, jiraRows, "No Jira sources")}

      {/* Final column */}
      {columnFrame(
        "Final",
        finals.length,
        Sparkles,
        <>
          {finals.map(({ idea, count }) => {
            const gone = count === 0;
            const sel = edit
              ? idea.id === selId
              : highlightSrc
                ? highlightedIdeaIds.has(idea.id)
                : idea.id === selId;
            const editing = edit != null && idea.id === edit.ideaId;
            return (
              <div
                key={idea.id}
                onClick={() => onStartEdit(idea.id)}
                className={`${ROW} hover:bg-white/60`}
                style={{
                  ...(sel && !gone ? SELECTED_ROW : {}),
                  opacity: gone ? 0.55 : 1,
                }}
              >
                {editing && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelEdit();
                      }}
                      title="Discard source changes (Esc)"
                      className="flex h-5 w-5 items-center justify-center rounded-full border border-[#c8d4e3] bg-white text-fg-muted hover:border-[#c23767] hover:text-[#c23767]"
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                    {editDirty && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSaveEdit();
                        }}
                        title="Save source changes"
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-[#17b26a] bg-[linear-gradient(180deg,#22c57a,#17b26a)] text-white shadow-[0_0_0_3px_rgba(23,178,106,.18)] hover:brightness-95"
                      >
                        <Check size={11} strokeWidth={3} />
                      </button>
                    )}
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-fg-2 ${
                    sel && !gone ? "font-semibold" : ""
                  }`}
                >
                  {idea.title}
                </span>
                {idea.products[0] && (
                  <Chip
                    className="hidden 2xl:inline-flex"
                    style={chipStyle(colorOf(productColors, idea.products[0]), PRODUCT_CHIP_DEFAULT)}
                  >
                    {idea.products[0]}
                  </Chip>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenIdea(idea.id);
                  }}
                  title="Open idea"
                  className="shrink-0 whitespace-nowrap rounded-full px-[7px] py-[2px] font-mono text-[10px] font-semibold hover:shadow-[0_0_0_2px_var(--app-accent-soft)]"
                  style={{
                    background: gone
                      ? "#f7eef1"
                      : sel
                        ? "#17b26a"
                        : count > 1
                          ? "var(--app-accent-soft)"
                          : "rgba(12,25,41,.06)",
                    color: gone ? "#a3556b" : sel ? "#ffffff" : count > 1 ? "#2a5fd0" : "#4a5b74",
                  }}
                >
                  {gone ? "Deleted" : `${count} src`}
                </button>
              </div>
            );
          })}
          {finals.length === 0 && <div className="p-4 text-xs text-fg-3">No ideas match</div>}
        </>,
      )}
    </div>
  );
}
