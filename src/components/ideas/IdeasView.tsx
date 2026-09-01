"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Search, ThumbsUp, Trash2, Upload } from "lucide-react";
import { ticketsFromCsv } from "@/lib/ideas/csv";
import { badgeOf, needsApproval, scoreOf } from "@/lib/ideas/idea";
import type { PushPlan, PushResult } from "@/lib/ideas/push";
import type { Idea, JiraSource, MergeEdit, ZendeskTicket } from "@/lib/ideas/types";
import { IdeaDrawer } from "./IdeaDrawer";
import { MergePage } from "./MergePage";

const MONO_LABEL =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7a8aa3]";

/** High-level narration of the import for the progress overlay. */
const IMPORT_STEPS: { label: string; hint: string }[] = [
  { label: "Reading your file", hint: "Parsing the Zendesk export" },
  { label: "Checking for new tickets", hint: "Skipping anything already imported" },
  { label: "AI is reviewing each ticket", hint: "Spotting feature requests and where they belong" },
  { label: "Preparing ideas for review", hint: "Almost there" },
];

const STATUS_CHIP_TO_BATCH: Record<string, Idea["batch"]> = {
  New: "new",
  Updated: "updated",
  Archive: "archive",
  Unchanged: "unchanged",
};

interface ServerState {
  tickets: ZendeskTicket[];
  jiraSources: JiraSource[];
  ideas: Idea[];
  customerCatalog?: string[];
}

interface ImportSummary {
  imported: number;
  frs: number;
  matched: number;
  bugs: number;
  needsDetails: number;
  duplicates: number;
  jiraConnected: boolean;
  jiraCount: number;
}

function chipClass(active: boolean): string {
  return active
    ? "whitespace-nowrap rounded-full border border-transparent bg-primary px-3 py-1 text-[12.5px] font-medium text-white"
    : "whitespace-nowrap rounded-full border border-border bg-white px-3 py-1 text-[12.5px] font-medium text-[#3f506b] hover:border-primary/55";
}

/** Labeled multi-select filter row: searchable dropdown + selected chips. */
function FilterRow({
  label,
  placeholder,
  emptyText,
  options,
  selected,
  setSelected,
  accent = "product",
}: {
  label: string;
  placeholder: string;
  emptyText: string;
  options: string[];
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  /** Platform rows purple, customer rows teal, product rows the primary blue — per the design. */
  accent?: "product" | "platform" | "customer";
}) {
  const accents = {
    product: {
      focus: "focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]",
      selected: "bg-[rgba(122,167,255,.12)] text-[#3b6fd4]",
      chip: "bg-primary hover:bg-primary-hover",
    },
    platform: {
      focus: "focus:border-[#9d7ce8] focus:shadow-[0_0_0_1px_rgba(169,140,255,.35)]",
      selected: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]",
      chip: "bg-[#7f5be0] hover:bg-[#6c48cd]",
    },
    customer: {
      focus: "focus:border-[#3aa48f] focus:shadow-[0_0_0_1px_rgba(47,160,143,.3)]",
      selected: "bg-[rgba(47,160,143,.14)] text-[#0f7a6a]",
      chip: "bg-[#189179] hover:bg-[#127d67]",
    },
  }[accent];
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const shown = options.filter(
    (o) => !query.trim() || o.toLowerCase().startsWith(query.trim().toLowerCase())
  );

  return (
    <div className="flex items-start gap-2">
      <span className={`${MONO_LABEL} w-24 shrink-0 pt-2`}>{label}</span>
      <div className="relative shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className={`w-[220px] rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px] outline-none ${accents.focus}`}
        />
        {open && (
          <>
            <div className="fixed inset-0 z-[24]" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-[calc(100%+4px)] z-[25] max-h-60 w-[250px] overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
              {shown.map((option) => {
                const isSelected = selected.includes(option);
                return (
                  <button
                    key={option}
                    onClick={() =>
                      setSelected((prev) =>
                        isSelected ? prev.filter((x) => x !== option) : [...prev, option]
                      )
                    }
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[11.5px] font-medium hover:bg-background ${
                      isSelected ? accents.selected : "text-[#3f506b]"
                    }`}
                  >
                    {option}
                    {isSelected && <Check size={12} strokeWidth={2.5} />}
                  </button>
                );
              })}
              {shown.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted">{emptyText}</div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-[3px]">
        {selected.map((option) => (
          <button
            key={option}
            onClick={() => setSelected((prev) => prev.filter((x) => x !== option))}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[11px] font-medium text-white ${accents.chip}`}
          >
            {option} ✕
          </button>
        ))}
      </div>
    </div>
  );
}

export function IdeasView({
  catalogProducts = [],
  catalogPlatforms = [],
  catalogCustomers = [],
  defaultProducts = [],
  undoEnabled = false,
}: {
  /** Product-line names from the settings catalog, merged into the filter options. */
  catalogProducts?: string[];
  /** Platform names from the settings catalog; the Platform filter's options. */
  catalogPlatforms?: string[];
  /** Customer names from the settings catalog, merged into the filter options. */
  catalogCustomers?: string[];
  /** The signed-in user's own product lines — pre-applied as the filter and merge scope. */
  defaultProducts?: string[];
  /** "ideasUndo" org flag: per-idea undo of the last merge in the drawer. */
  undoEnabled?: boolean;
}) {
  const [tickets, setTickets] = useState<ZendeskTicket[]>([]);
  const [jiraSources, setJiraSources] = useState<JiraSource[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  // Server state carries the live customer catalog so approving a suggested
  // customer flips its chips without a reload; the prop is only the first paint.
  const [customerCatalog, setCustomerCatalog] = useState<string[]>(catalogCustomers);
  const [hydrated, setHydrated] = useState(false);

  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState<string[]>(defaultProducts);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [pendingOnly, setPendingOnly] = useState(false);
  /** Bumped by "Clear filters" to remount the FilterRows, wiping their local search text. */
  const [filterResetKey, setFilterResetKey] = useState(0);

  const [page, setPage] = useState<"final" | "merge">("final");
  const [mergeFilter, setMergeFilter] = useState<"Merge" | "Single" | "Unchanged">("Merge");
  const [edit, setEdit] = useState<MergeEdit | null>(null);
  const [selectedFinalId, setSelectedFinalId] = useState<string | "auto" | null>("auto");

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [popId, setPopId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerSrc, setDrawerSrc] = useState<{ kind: "zen" | "jira"; key: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Merge scope: selected product lines; empty = all. */
  const [scopeSel, setScopeSel] = useState<string[]>([]);
  const [plan, setPlan] = useState<PushPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  /** Index into IMPORT_STEPS while the import overlay is up; null = closed. */
  const [importStep, setImportStep] = useState<number | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const applyState = (state: ServerState) => {
    setTickets(state.tickets);
    setJiraSources(state.jiraSources);
    setIdeas(state.ideas);
    if (state.customerCatalog) setCustomerCatalog(state.customerCatalog);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ideas");
        if (res.ok) {
          applyState(await res.json());
        } else {
          const data = await res.json().catch(() => ({ error: undefined }));
          setError(data.error ?? "Failed to load ideas");
        }
      } catch {
        setError("Failed to load ideas — is the dev server running?");
      }
      setHydrated(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run a server mutation and adopt the returned state. */
  const callMutate = async (mutation: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch("/api/ideas/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mutation),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Update failed");
        return false;
      }
      applyState(data.state);
      return true;
    } catch {
      setError("Update failed — is the dev server running?");
      return false;
    }
  };

  const ticketsByKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
  const jiraByKey = useMemo(() => new Map(jiraSources.map((s) => [s.key, s])), [jiraSources]);
  // Catalog names first so their casing wins over idea-derived duplicates.
  const allProducts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of [...catalogProducts, ...ideas.flatMap((i) => i.products)]) {
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [catalogProducts, ideas]);
  const allCustomers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of [...customerCatalog, ...ideas.flatMap((i) => i.customers ?? [])]) {
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [customerCatalog, ideas]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setImporting(true);
    setImportStep(0);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const text = await file.text();
      const result = ticketsFromCsv(text);
      if (result.errors.length > 0) {
        setError(result.errors[0]);
        return;
      }
      // The overlay steps are a high-level narration of one server call; the
      // AI-review step holds until the response lands (it dominates the wait).
      await sleep(600);
      setImportStep(1);
      const resPromise = fetch("/api/ideas/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickets: result.tickets }),
      });
      await sleep(900);
      setImportStep(2);
      const res = await resPromise;
      const data = await res.json();
      if (!res.ok) {
        setError(`Import failed: ${data.error ?? res.statusText}`);
        return;
      }
      setImportStep(3);
      await sleep(800);
      applyState(data.state);
      const s = data.summary as ImportSummary;

      const parts = [
        `Imported ${s.imported} ticket${s.imported === 1 ? "" : "s"} from ${file.name}`,
      ];
      if (s.imported > 0) parts.push(`${s.frs} FR${s.frs === 1 ? "" : "s"} → ideas`);
      if (s.matched > 0)
        parts.push(`${s.matched} matched to existing Jira idea${s.matched === 1 ? "" : "s"}`);
      if (s.bugs > 0) parts.push(`${s.bugs} bug${s.bugs === 1 ? "" : "s"} parked`);
      if (s.needsDetails > 0)
        parts.push(`${s.needsDetails} need${s.needsDetails === 1 ? "s" : ""} more details`);
      if (s.duplicates > 0) parts.push(`${s.duplicates} already imported`);
      if (result.skipped > 0)
        parts.push(`${result.skipped} empty row${result.skipped === 1 ? "" : "s"} skipped`);
      if (s.jiraConnected)
        parts.push(`${s.jiraCount} Jira idea${s.jiraCount === 1 ? "" : "s"} synced`);
      setNote(parts.join(" · "));
    } catch {
      setError("Import failed — is the dev server running?");
    } finally {
      setImporting(false);
      setImportStep(null);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("Remove all imported tickets and ideas? (The verdict ledger is kept.)"))
      return;
    try {
      const res = await fetch("/api/ideas", { method: "DELETE" });
      if (!res.ok) {
        setError("Clear failed");
        return;
      }
      applyState(await res.json());
    } catch {
      setError("Clear failed — is the dev server running?");
      return;
    }
    setDrawerId(null);
    setDrawerSrc(null);
    setPage("final");
    setEdit(null);
    setSelectedFinalId("auto");
    setNote("");
    setError("");
  };

  // Suggested metadata still awaiting review on an idea — customers outside
  // the catalog (dismissed ones are already subtracted server-side). An idea
  // with any of these cannot be approved; mirrors the server gate in
  // mutateIdeas, which refuses the decision outright.
  const unresolvedSuggested = (idea: Idea): string[] =>
    (idea.customers ?? []).filter(
      (c) => !customerCatalog.some((n) => n.toLowerCase() === c.toLowerCase())
    );

  // Per-idea undo of the last merge (behind the "ideasUndo" org flag). A
  // created issue is deleted in Jira — permanent, hence the hard confirm.
  const undoPush = async (idea: Idea) => {
    if (!idea.undoable) return;
    const message =
      idea.undoable.action === "create"
        ? `Undo will permanently DELETE ${idea.undoable.jiraKey} in Jira — comments and edits made there are lost. Continue?`
        : `Undo restores ${idea.undoable.jiraKey} to its pre-merge state. Fields edited in Jira since the merge are left alone. Continue?`;
    if (!window.confirm(message)) return;
    setError("");
    try {
      const res = await fetch("/api/ideas/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Undo failed");
        return;
      }
      applyState(data.state);
      if (data.warnings?.length > 0) setError(data.warnings.join(" · "));
    } catch {
      setError("Undo failed — is the dev server running?");
    }
  };

  const toggleApprove = (id: string) => {
    const idea = ideas.find((i) => i.id === id);
    if (!idea || idea.decision === "injected") return;
    if (idea.decision === "pending" && unresolvedSuggested(idea).length > 0) return;
    setNote("");
    void callMutate({
      type: "decision",
      ideaId: id,
      decision: idea.decision === "pending" ? "reviewed" : "pending",
    });
  };

  // ——— Merge page ———
  const srcCount = (i: Idea) => i.zen.length + i.jira.length;

  const gotoMerge = (id: string | null) => {
    const withSources = [...ideas]
      .filter((i) => srcCount(i) > 0)
      .sort((a, b) => srcCount(b) - srcCount(a));
    const target = (id != null ? ideas.find((i) => i.id === id) : null) ?? withSources[0] ?? null;
    setPage("merge");
    setDrawerId(null);
    setDrawerSrc(null);
    setMergeFilter(target && srcCount(target) === 1 ? "Single" : "Merge");
    setEdit(target ? { ideaId: target.id, zen: [...target.zen], jira: [...target.jira] } : null);
    setSelectedFinalId(target ? target.id : "auto");
  };

  const startEdit = (id: string) => {
    if (edit && edit.ideaId === id) {
      setEdit(null);
      setSelectedFinalId(null);
      return;
    }
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return;
    setEdit({ ideaId: id, zen: [...idea.zen], jira: [...idea.jira] });
    setSelectedFinalId(id);
  };

  const toggleSrc = (kind: "zen" | "jira", key: string) =>
    setEdit((e) => {
      if (!e) return e;
      const arr = e[kind];
      return {
        ...e,
        [kind]: arr.includes(key) ? arr.filter((k) => k !== key) : [...arr, key],
      };
    });

  const cancelEdit = () => {
    setEdit(null);
    setSelectedFinalId(null);
  };

  const saveEdit = async () => {
    if (!edit) return;
    // The server rewrites the source links and recomputes batch statuses
    // (no sources → Deleted; Jira idea with ticket evidence → Updated; etc.)
    const ok = await callMutate({
      type: "reassign",
      ideaId: edit.ideaId,
      zen: edit.zen,
      jira: edit.jira,
    });
    if (!ok) return;
    setEdit(null);
    // Keep the edited idea selected so the saved reassignment stays visible.
    setSelectedFinalId(edit.ideaId);
    setNote("");
  };

  // ——— Derived batch numbers ———
  const live = ideas.filter((i) => i.batch !== "deleted");
  const approvable = live.filter(needsApproval);
  const pending = approvable.filter((i) => i.decision === "pending").length;
  const reviewed = live.filter((i) => i.decision === "reviewed").length;
  const total = approvable.length;
  const counts = {
    new: ideas.filter((i) => i.batch === "new").length,
    updated: ideas.filter((i) => i.batch === "updated").length,
    unchanged: ideas.filter((i) => i.batch === "unchanged").length,
    archive: ideas.filter((i) => i.batch === "archive").length,
  };
  // Partial merge: the button opens as soon as anything is approved — the
  // all-reviewed gate applies per selected product line inside the modal.
  const injectDisabled = reviewed === 0;
  const injectHint =
    reviewed === 0
      ? pending > 0
        ? `Approve ideas to enable merging — ${pending} awaiting review`
        : "All changes already merged to Jira"
      : `Merge approved changes to Jira`;

  const matches = (i: Idea): boolean => {
    if (i.batch === "deleted") return false;
    const q = query.trim().toLowerCase();
    if (q && !i.title.toLowerCase().includes(q)) return false;
    if (productFilter.length > 0) {
      const wanted = productFilter.map((p) => p.toLowerCase());
      if (!i.products.some((p) => wanted.includes(p.toLowerCase()))) return false;
    }
    if (platformFilter.length > 0) {
      const wanted = platformFilter.map((p) => p.toLowerCase());
      if (!(i.platforms ?? []).some((p) => wanted.includes(p.toLowerCase()))) return false;
    }
    if (customerFilter.length > 0) {
      const wanted = customerFilter.map((c) => c.toLowerCase());
      if (!(i.customers ?? []).some((c) => wanted.includes(c.toLowerCase()))) return false;
    }
    if (statusFilter.length > 0) {
      if (!statusFilter.some((s) => STATUS_CHIP_TO_BATCH[s] === i.batch)) return false;
    } else if (i.batch === "unchanged") {
      // The Jira backlog dwarfs a Zendesk batch and is mostly unchanged —
      // unchanged ideas need no review, so they show only via their chip.
      return false;
    }
    if (pendingOnly && i.decision !== "pending") return false;
    return true;
  };

  const visible = ideas.filter(matches).sort((a, b) => {
    const av = scoreOf(a).value;
    const bv = scoreOf(b).value;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  const drawerIdea = drawerId ? ideas.find((i) => i.id === drawerId) : undefined;

  // ——— Merge-to-Jira modal (scope → preview → execute → results) ———
  const scope = scopeSel.length > 0 ? scopeSel : null;
  const inMergeScope = (i: Idea): boolean =>
    !scope || i.products.some((p) => scope.some((s) => s.toLowerCase() === p.toLowerCase()));
  const scopedPending = approvable.filter(
    (i) => i.decision === "pending" && inMergeScope(i)
  ).length;
  const scopedReviewed = live.filter(
    (i) => i.decision === "reviewed" && inMergeScope(i)
  ).length;
  // One approved idea is enough to merge — pending ideas never block, they
  // simply stay behind for a later merge.
  const previewDisabled = scopedReviewed === 0;
  const previewHint =
    scopedReviewed === 0
      ? "Nothing approved in the selected product lines"
      : `${scopedReviewed} approved change${scopedReviewed === 1 ? "" : "s"} will merge${
          scopedPending > 0
            ? ` — ${scopedPending} still pending stay${scopedPending === 1 ? "s" : ""} here`
            : ""
        }`;

  const openMerge = () => {
    // Default the scope to the PM's own product lines when they have any.
    setScopeSel(defaultProducts.filter((p) => allProducts.some((a) => a.toLowerCase() === p.toLowerCase())));
    setPlan(null);
    setPushResults(null);
    setMergeError("");
    setConfirmOpen(true);
  };

  const closeMerge = () => {
    if (pushing) return;
    setConfirmOpen(false);
    setPlan(null);
    setPushResults(null);
    setMergeError("");
  };

  const toggleScope = (name: string) => {
    setPlan(null); // a changed scope must be re-previewed before it can run
    setMergeError("");
    setScopeSel((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  };

  const loadPlan = async () => {
    setPlanLoading(true);
    setMergeError("");
    try {
      const res = await fetch("/api/ideas/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", productLines: scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMergeError(data.error ?? "Preview failed");
        return;
      }
      setPlan(data.plan as PushPlan);
    } catch {
      setMergeError("Preview failed — is the dev server running?");
    } finally {
      setPlanLoading(false);
    }
  };

  const runPush = async () => {
    setPushing(true);
    setMergeError("");
    try {
      const res = await fetch("/api/ideas/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "execute", productLines: scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMergeError(data.error ?? "Merge failed");
        return;
      }
      applyState(data.state as ServerState);
      const results = data.results as PushResult[];
      setPushResults(results);
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      setNote(
        failCount === 0
          ? `${okCount} change${okCount === 1 ? "" : "s"} merged to Jira`
          : `${okCount} merged, ${failCount} failed — reopen Merge to Jira to retry`
      );
    } catch {
      setMergeError("Merge failed — is the dev server running?");
    } finally {
      setPushing(false);
    }
  };

  const hasFilters =
    query !== "" ||
    productFilter.length > 0 ||
    platformFilter.length > 0 ||
    customerFilter.length > 0 ||
    statusFilter.length > 0 ||
    pendingOnly;

  // Esc closes the merge modal (never mid-write). Enter is deliberately not
  // bound here — a Jira write should always be an explicit click.
  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pushing) {
        setConfirmOpen(false);
        setPlan(null);
        setPushResults(null);
        setMergeError("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, pushing]);

  return (
    <div className="mx-auto max-w-[1120px] px-10 pb-24 pt-8">
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />

      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-4">
        <h1 className="font-title m-0 text-2xl font-bold tracking-tight">Ideas</h1>
        <div className="flex items-center gap-2">
          {tickets.length > 0 && (
            <button
              onClick={clearAll}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-white hover:text-foreground"
            >
              <Trash2 size={13} />
              Clear import
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            <Upload size={13} />
            {importing ? "Importing…" : "Upload Zendesk CSV"}
          </button>
        </div>
      </div>

      {ideas.length > 0 && (
        <div className="mb-5 flex items-center gap-2">
          <button
            onClick={() => gotoMerge(null)}
            className={`font-title whitespace-nowrap rounded-full border px-4 py-1.5 text-[13px] font-semibold hover:border-primary/55 ${
              page === "merge"
                ? "border-transparent bg-primary text-white"
                : "border-border bg-white text-[#3f506b]"
            }`}
          >
            Merge
          </button>
          <ArrowRight size={14} className="text-[#7a8aa3]" />
          <button
            onClick={() => {
              setPage("final");
              cancelEdit();
            }}
            className={`font-title whitespace-nowrap rounded-full border px-4 py-1.5 text-[13px] font-semibold hover:border-primary/55 ${
              page === "final"
                ? "border-transparent bg-primary text-white"
                : "border-border bg-white text-[#3f506b]"
            }`}
          >
            Final
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">
          {error}
        </div>
      )}
      {note && (
        <div className="mb-4 inline-flex items-center gap-1.5 text-xs text-[#1f8a53]">
          <Check size={12} strokeWidth={2.5} />
          {note}
        </div>
      )}

      {!hydrated ? null : ideas.length === 0 ? (
        /* Empty state */
        <div className="rounded-xl border border-dashed border-border bg-white px-10 py-16 text-center">
          <div className="font-title mb-1 text-[15px] font-semibold">No ideas yet</div>
          <div className="mx-auto mb-5 max-w-[440px] text-[13px] leading-relaxed text-muted">
            Upload a Zendesk ticket export (CSV) to create the first idea batch. Each ticket
            becomes a New idea you can review, edit and approve.
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            <Upload size={14} />
            {importing ? "Importing…" : "Upload Zendesk CSV"}
          </button>
          <div className="mt-5 font-mono text-[10.5px] text-[#9aa8be]">
            Expected columns: external_id, subject, description · optional: requester_name, tags,
            created_at, product_line, affected_customers
          </div>
        </div>
      ) : (
        <>
          {/* Batch status card */}
          <div className="mb-5 flex items-center gap-6 rounded-xl border border-border bg-white px-5 py-[18px]">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="font-title text-[15px] font-semibold">Import in Progress</span>
                <span className="text-[13px] text-[#4a5b74]">
                  {counts.new} new · {counts.updated} updated · {counts.unchanged} unchanged ·{" "}
                  {counts.archive} archive proposed
                </span>
              </div>
              <div className="h-1.5 max-w-[420px] overflow-hidden rounded-full bg-[#e4ecf6]">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${total ? Math.round(((total - pending) / total) * 100) : 0}%` }}
                />
              </div>
              <span className="text-xs text-muted">
                {pending} of {total} awaiting review
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span title={injectHint} className="inline-flex">
                <button
                  disabled={injectDisabled}
                  onClick={openMerge}
                  className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Merge to Jira
                </button>
              </span>
            </div>
          </div>

          {/* Search + filters */}
          <div className="mb-5 flex flex-col gap-3">
            <div className="relative max-w-[360px]">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7a8aa3]"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search ideas…"
                className="w-full rounded-lg border border-border bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]"
              />
            </div>

            {allProducts.length > 0 && (
              <FilterRow
                key={`products-${filterResetKey}`}
                label="Product Line"
                placeholder="All products"
                emptyText="No matching product line"
                options={allProducts}
                selected={productFilter}
                setSelected={setProductFilter}
              />
            )}

            {catalogPlatforms.length > 0 && (
              <FilterRow
                key={`platforms-${filterResetKey}`}
                label="Platform"
                placeholder="All platforms"
                emptyText="No matching platform"
                options={catalogPlatforms}
                selected={platformFilter}
                setSelected={setPlatformFilter}
                accent="platform"
              />
            )}

            {allCustomers.length > 0 && (
              <FilterRow
                key={`customers-${filterResetKey}`}
                label="Customer"
                placeholder="All customers"
                emptyText="No matching customer"
                options={allCustomers}
                selected={customerFilter}
                setSelected={setCustomerFilter}
                accent="customer"
              />
            )}

            <div className="flex flex-wrap items-start gap-2">
              <span className={`${MONO_LABEL} w-[99px] shrink-0 pt-1.5`}>Import Status</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {page === "merge"
                  ? (["Merge", "Single", "Unchanged"] as const).map((label) => (
                      <button
                        key={label}
                        onClick={() => {
                          setMergeFilter(label);
                          setSelectedFinalId("auto");
                        }}
                        className={chipClass(mergeFilter === label)}
                      >
                        {label}
                      </button>
                    ))
                  : Object.keys(STATUS_CHIP_TO_BATCH).map((label) => (
                      <button
                        key={label}
                        onClick={() =>
                          setStatusFilter((prev) => (prev.includes(label) ? [] : [label]))
                        }
                        className={chipClass(statusFilter.includes(label))}
                      >
                        {label}
                      </button>
                    ))}
                <span className="mx-1.5 w-px self-stretch bg-[#d5dfec]" />
                <button onClick={() => setPendingOnly((v) => !v)} className={chipClass(pendingOnly)}>
                  Pending Review
                </button>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2.5">
                {page === "merge" && edit ? (
                  <>
                    <span className="whitespace-nowrap text-xs text-muted">
                      {edit.zen.length + edit.jira.length} source
                      {edit.zen.length + edit.jira.length === 1 ? "" : "s"} selected
                    </span>
                    <button
                      onClick={cancelEdit}
                      className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveEdit}
                      className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover"
                    >
                      Save
                    </button>
                  </>
                ) : page === "final" ? (
                  <span title={pending > 0 ? `${pending} awaiting review` : "All approved"}>
                    <button
                      onClick={() => {
                        setNote("");
                        void callMutate({ type: "approveAll" });
                      }}
                      className="inline-flex h-8 items-center whitespace-nowrap rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                    >
                      {pending > 0 ? "Approve all" : "Undo approve all"}
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {/* Body: merge board or idea rows */}
          {page === "merge" ? (
            <MergePage
              ideas={ideas}
              tickets={tickets}
              jiraSources={jiraSources}
              query={query}
              productFilter={productFilter}
              platformFilter={platformFilter}
              customerFilter={customerFilter}
              pendingOnly={pendingOnly}
              mergeFilter={mergeFilter}
              edit={edit}
              selectedFinalId={selectedFinalId}
              onStartEdit={startEdit}
              onToggleSrc={toggleSrc}
              onOpenIdea={(id) => {
                setDrawerId(id);
                setDrawerSrc(null);
              }}
              onOpenSource={(kind, key) => {
                setDrawerSrc({ kind, key });
                setDrawerId(null);
              }}
            />
          ) : (
          <div className="flex flex-col gap-2">
            {visible.map((idea) => {
              const badge = badgeOf(idea);
              const score = scoreOf(idea);
              const hovered = hoverId === idea.id;
              const showMark = needsApproval(idea) && (idea.decision === "reviewed" || hovered);
              return (
                <div
                  key={idea.id}
                  onClick={() => setDrawerId(idea.id)}
                  onMouseEnter={() => setHoverId(idea.id)}
                  onMouseLeave={() => {
                    setHoverId((h) => (h === idea.id ? null : h));
                    setPopId((p) => (p === idea.id ? null : p));
                  }}
                  className="relative flex cursor-pointer items-center gap-4 rounded-lg border bg-white px-4 py-3"
                  style={{
                    borderColor: hovered ? "rgba(122,167,255,.5)" : "var(--border)",
                    boxShadow: hovered ? "0 4px 14px rgba(10,22,40,.08)" : "none",
                  }}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">
                      {idea.title}
                    </span>
                    {(idea.products.length > 0 ||
                      (idea.platforms ?? []).length > 0 ||
                      (idea.customers ?? []).length > 0) && (
                      <div className="flex flex-wrap items-center gap-2">
                        {idea.products.map((p) => {
                          // Flag names the model returned that aren't in the
                          // Settings → Ideas catalog ("Other" is a reserved
                          // value, not a miss) — observed, not corrected.
                          const offCatalog =
                            p !== "Other" &&
                            !catalogProducts.some((c) => c.toLowerCase() === p.toLowerCase());
                          return (
                            <span
                              key={p}
                              title={offCatalog ? "Not in the product-line catalog" : undefined}
                              className={
                                offCatalog
                                  ? "rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-700"
                                  : "rounded bg-background px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary"
                              }
                            >
                              {p}
                              {offCatalog ? " ⚑" : ""}
                            </span>
                          );
                        })}
                        {(idea.platforms ?? []).map((p) => (
                          <span
                            key={`platform-${p}`}
                            className="rounded bg-[rgba(169,140,255,.16)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#6b4bd0]"
                          >
                            {p}
                          </span>
                        ))}
                        {(idea.customers ?? []).map((c) => {
                          // Off-catalog names are suggestions awaiting PM
                          // review in the drawer — flagged, never hidden.
                          const offCatalog = !customerCatalog.some(
                            (k) => k.toLowerCase() === c.toLowerCase()
                          );
                          return (
                            <span
                              key={`customer-${c}`}
                              title={offCatalog ? "Suggested customer — review in the idea" : undefined}
                              className={
                                offCatalog
                                  ? "rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-700"
                                  : "rounded bg-[rgba(47,160,143,.14)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#0f7a6a]"
                              }
                            >
                              {c}
                              {offCatalog ? " ⚑" : ""}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Score */}
                  <div
                    className="relative flex w-[52px] shrink-0 flex-col items-center gap-px"
                    onMouseEnter={() => setPopId(idea.id)}
                    onMouseLeave={() => setPopId((p) => (p === idea.id ? null : p))}
                  >
                    <span className="font-title text-base font-bold">
                      {score.value != null ? score.value : "—"}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#9aa8be]">
                      score
                    </span>
                    {popId === idea.id && (
                      <div className="absolute bottom-[calc(100%+8px)] left-1/2 z-20 w-44 -translate-x-1/2 rounded-lg border border-border bg-white px-3.5 py-2.5 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
                        <div className="flex justify-between gap-3 py-0.5 text-[12.5px]">
                          <span className="text-muted">PM-OS score</span>
                          <span className="font-semibold">
                            {idea.pmScore != null ? idea.pmScore : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3 py-0.5 text-[12.5px]">
                          <span className="text-muted">Manual score</span>
                          <span className="font-semibold">
                            {idea.manual != null ? idea.manual : "—"}
                          </span>
                        </div>
                        <div className="mt-1.5 border-t border-[#e8eef7] pt-1.5 text-[11px] leading-snug text-[#9aa8be]">
                          {score.src}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Votes — the "+N" jumps to the Merge page with this idea selected */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (idea.newVotes > 0) gotoMerge(idea.id);
                    }}
                    title={idea.newVotes > 0 ? "Show merge sources" : undefined}
                    className={`flex w-[72px] shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 ${
                      idea.newVotes > 0
                        ? "cursor-pointer hover:border-[#d7e3f2] hover:bg-[#f2f7fd]"
                        : "cursor-default"
                    }`}
                  >
                    {(idea.existingVotes > 0 || idea.newVotes > 0) && (
                      <ThumbsUp size={13} className="shrink-0 text-[#9aa8be]" />
                    )}
                    {idea.existingVotes > 0 && (
                      <span className="text-xs font-semibold">{idea.existingVotes}</span>
                    )}
                    {idea.newVotes > 0 && (
                      <span className="text-xs font-semibold text-[#1f8a53]">
                        {idea.existingVotes > 0 ? `(+${idea.newVotes})` : `+${idea.newVotes}`}
                      </span>
                    )}
                  </button>

                  {/* Status pill — Updated carries the what-changed narration on hover */}
                  <span className="flex w-[124px] shrink-0 items-center justify-center">
                    {badge && (
                      <span
                        title={
                          idea.batch === "updated" && (idea.batchChanges ?? []).length > 0
                            ? (idea.batchChanges ?? []).join("\n")
                            : undefined
                        }
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium"
                        style={{ background: badge.bg, color: badge.fg, borderColor: badge.bd }}
                      >
                        {badge.check && <Check size={11} strokeWidth={3} />}
                        {badge.label}
                      </span>
                    )}
                  </span>

                  {/* Hover approve mark */}
                  {showMark && (() => {
                    const blocked =
                      idea.decision === "pending" && unresolvedSuggested(idea).length > 0;
                    return (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleApprove(idea.id);
                      }}
                      disabled={blocked}
                      title={
                        blocked
                          ? "Approve or dismiss the suggested customers first"
                          : idea.decision === "pending"
                            ? "Mark reviewed"
                            : "Mark unreviewed"
                      }
                      className={
                        blocked
                          ? "absolute right-2 top-1.5 flex h-4 w-4 cursor-not-allowed items-center justify-center rounded-full border p-0 opacity-40"
                          : "absolute right-2 top-1.5 flex h-4 w-4 items-center justify-center rounded-full border p-0 hover:border-[#bfe3cf] hover:bg-[#e9f7ef] hover:text-[#1f8a53]"
                      }
                      style={{
                        background: idea.decision === "reviewed" ? "#e9f7ef" : "#ffffff",
                        borderColor: idea.decision === "reviewed" ? "#bfe3cf" : "#c8d4e3",
                        color: idea.decision === "reviewed" ? "#1f8a53" : "#b3bfd0",
                      }}
                    >
                      <Check size={9} strokeWidth={3.5} />
                    </button>
                    );
                  })()}
                </div>
              );
            })}
            {visible.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-white p-10 text-center text-sm text-muted">
                No ideas match.{" "}
                {hasFilters && (
                  <button
                    onClick={() => {
                      setQuery("");
                      setProductFilter([]);
                      setPlatformFilter([]);
                      setCustomerFilter([]);
                      setStatusFilter([]);
                      setPendingOnly(false);
                      setFilterResetKey((k) => k + 1);
                    }}
                    className="text-primary hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>
          )}
        </>
      )}

      {/* Item details drawer */}
      {(drawerIdea || drawerSrc) && (
        <IdeaDrawer
          key={drawerIdea ? drawerIdea.id : `src:${drawerSrc?.kind}:${drawerSrc?.key}`}
          idea={drawerIdea ?? null}
          initialSource={drawerSrc}
          ticketsByKey={ticketsByKey}
          jiraByKey={jiraByKey}
          customerCatalog={customerCatalog}
          onCustomerAction={
            drawerIdea
              ? (action, name) =>
                  void callMutate({
                    type:
                      action === "approve"
                        ? "approveCustomer"
                        : action === "dismiss"
                          ? "dismissCustomer"
                          : "undismissCustomer",
                    ideaId: drawerIdea.id,
                    name,
                  })
              : undefined
          }
          onClose={() => {
            setDrawerId(null);
            setDrawerSrc(null);
          }}
          onToggleApprove={drawerIdea ? () => toggleApprove(drawerIdea.id) : undefined}
          onUndoPush={
            undoEnabled && drawerIdea?.undoable ? () => void undoPush(drawerIdea) : undefined
          }
          onSave={
            drawerIdea
              ? (patch) => void callMutate({ type: "edit", ideaId: drawerIdea.id, ...patch })
              : undefined
          }
          onMerge={drawerIdea ? () => gotoMerge(drawerIdea.id) : undefined}
        />
      )}

      {/* Import progress overlay */}
      {importStep !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,22,40,.35)] p-10">
          <div className="flex w-[420px] max-w-full flex-col gap-5 rounded-xl border border-border bg-white p-6 shadow-[0_16px_48px_rgba(10,22,40,.18)]">
            <div>
              <div className="font-title text-lg font-semibold">Importing tickets</div>
              <div className="mt-1 text-[13px] text-muted">
                Turning your Zendesk export into ideas — this can take a minute.
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {IMPORT_STEPS.map((step, i) => {
                const done = i < importStep;
                const active = i === importStep;
                return (
                  <div
                    key={step.label}
                    className={`flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors ${
                      active ? "bg-background" : ""
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center pt-px">
                      {done ? (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#e7f6ee]">
                          <Check size={12} strokeWidth={3} className="text-[#1e9e5a]" />
                        </span>
                      ) : active ? (
                        <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-[#c9d4e4]" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span
                        className={`text-[13px] ${
                          active
                            ? "font-medium"
                            : done
                              ? "text-muted"
                              : "text-[#9aa8be]"
                        }`}
                      >
                        {step.label}
                      </span>
                      {active && (
                        <span className="text-[11.5px] text-muted">{step.hint}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Merge-to-Jira modal: scope → preview → execute → results */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,22,40,.35)] p-10"
          onClick={closeMerge}
        >
          <div
            className="flex w-[640px] max-w-full flex-col gap-4 rounded-xl border border-border bg-white p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {pushResults ? (
              <>
                <div>
                  <div className="font-title text-lg font-semibold">
                    {pushResults.every((r) => r.ok) ? "Merged to Jira" : "Merge finished with errors"}
                  </div>
                  <div className="mt-1 text-[13px] text-muted">
                    {pushResults.filter((r) => r.ok).length} of {pushResults.length} change
                    {pushResults.length === 1 ? "" : "s"} written. Failed ideas stay approved —
                    run Merge to Jira again to retry just those.
                  </div>
                </div>
                <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
                  {pushResults.map((r) => (
                    <div
                      key={r.ideaId}
                      className="flex items-start gap-3 rounded-lg border border-[#e8eef7] bg-background px-3 py-2"
                    >
                      <span
                        className={`mt-0.5 shrink-0 text-[13px] font-semibold ${r.ok ? "text-[#1f8a53]" : "text-[#c94266]"}`}
                      >
                        {r.ok ? "✓" : "✕"}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{r.title}</span>
                        {r.ok ? (
                          <span className="text-[11.5px] text-muted">
                            {r.action === "create"
                              ? `Created ${r.jiraKey}`
                              : r.action === "update"
                                ? `Updated ${r.jiraKey}`
                                : `${r.jiraKey} already up to date`}
                          </span>
                        ) : (
                          <span className="text-[11.5px] text-[#c94266]">{r.error}</span>
                        )}
                      </div>
                      {r.url && (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 font-mono text-[11px] text-primary hover:underline"
                        >
                          {r.jiraKey}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeMerge}
                    className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="font-title text-lg font-semibold">Merge to Jira</div>
                  <div className="mt-1 text-[13px] text-muted">
                    Pick the product lines to merge. Only approved ideas are written — anything
                    still pending stays here for a later merge.
                  </div>
                </div>

                {/* Scope */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => {
                      setScopeSel([]);
                      setPlan(null);
                      setMergeError("");
                    }}
                    className={chipClass(scopeSel.length === 0)}
                  >
                    All product lines
                  </button>
                  {allProducts.map((p) => (
                    <button key={p} onClick={() => toggleScope(p)} className={chipClass(scopeSel.includes(p))}>
                      {p}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-muted">{previewHint}</div>

                {/* Preview */}
                {plan && (
                  <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
                    {plan.blockers.map((b) => (
                      <div
                        key={b}
                        className="rounded-lg border border-[#f3c9d5] bg-[#fdeef2] px-3 py-2 text-[12.5px] text-[#c94266]"
                      >
                        {b}
                      </div>
                    ))}
                    {plan.items.map((item) => (
                      <div
                        key={item.ideaId}
                        className="flex flex-col gap-1 rounded-lg border border-[#e8eef7] bg-background px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              item.action === "create"
                                ? "border-[#c4e8d2] bg-[#e9f7ef] text-[#1f8a53]"
                                : "border-[rgba(122,167,255,.4)] bg-[rgba(122,167,255,.14)] text-[#3b6fd4]"
                            }`}
                          >
                            {item.action === "create" ? "Create" : `Update ${item.jiraKey}`}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                            {item.title}
                          </span>
                        </div>
                        <span className="text-[11.5px] text-muted">
                          {item.noop
                            ? "Already up to date in Jira — will be marked merged"
                            : item.changes.map((c) => c.label).join(", ")}
                          {item.votes > 0 ? ` · ${item.votes} vote${item.votes === 1 ? "" : "s"}` : ""}
                        </span>
                      </div>
                    ))}
                    {plan.warnings.map((w) => (
                      <div
                        key={w}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
                      >
                        {w}
                      </div>
                    ))}
                    {plan.skipped.map((s) => (
                      <div key={s.ideaId} className="px-3 py-1 text-[11.5px] text-muted">
                        Skipped “{s.title}” — {s.reason}
                      </div>
                    ))}
                  </div>
                )}

                {mergeError && (
                  <div className="rounded-lg border border-[#f3c9d5] bg-[#fdeef2] px-3 py-2 text-[12.5px] text-[#c94266]">
                    {mergeError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={closeMerge}
                    className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3.5 text-[13px] font-medium hover:border-primary"
                  >
                    Cancel
                  </button>
                  {!plan ? (
                    <span title={previewHint} className="inline-flex">
                      <button
                        disabled={previewDisabled || planLoading}
                        onClick={loadPlan}
                        className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {planLoading ? "Checking Jira…" : "Preview changes"}
                      </button>
                    </span>
                  ) : (
                    <button
                      disabled={pushing || plan.blockers.length > 0 || plan.items.length === 0}
                      onClick={runPush}
                      className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {pushing
                        ? "Merging…"
                        : `Confirm merge (${plan.items.length})`}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
