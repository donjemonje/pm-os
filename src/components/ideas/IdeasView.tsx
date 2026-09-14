"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  GitMerge,
  Layers,
  PlusCircle,
  RefreshCw,
  Search,
  ThumbsUp,
  Trash2,
  Upload,
} from "lucide-react";
import { ticketsFromCsv } from "@/lib/ideas/csv";
import { type CsvMapping, DEFAULT_CSV_MAPPING } from "@/lib/ideas/csv-mapping";
import {
  badgeOf,
  compareIdeas,
  needsApproval,
  SCORING_ENABLED,
  scoreOf,
  STATUS_CHIP_TO_BATCH,
  STATUS_TONES,
} from "@/lib/ideas/idea";
import type { PushPlan, PushResult } from "@/lib/ideas/push";
import type { Idea, JiraSource, MergeEdit, ZendeskTicket } from "@/lib/ideas/types";
import { FILTER_ACCENTS, FilterPopover } from "@/components/ui/FilterPopover";
import { PmosMark } from "@/components/brand/PmosMark";
import { ApproveMark } from "@/components/ui/ApproveMark";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Pill } from "@/components/ui/Pill";
import { Ring } from "@/components/ui/Ring";
import { VoteBar } from "@/components/ui/VoteBar";
import {
  chipStyle,
  CUSTOMER_CHIP_DEFAULT,
  PRODUCT_CHIP_DEFAULT,
} from "@/lib/ideas/colors";
import { IdeaDrawer } from "./IdeaDrawer";
import { MergePage } from "./MergePage";

const MONO_LABEL =
  "font-mono text-[10px] font-semibold tracking-[0.06em] text-[#7a8aa3]";

/**
 * What the import does, in order, for the progress overlay. The PMOS step is
 * the long one (classify, split, match against existing ideas and Jira) and
 * holds until the server answers; the others are quick.
 */
const IMPORT_STEPS: { label: string; hint: string; pmos?: boolean }[] = [
  { label: "Reading your file", hint: "Checking the export's columns" },
  { label: "Checking for new tickets", hint: "Tickets already imported are skipped" },
  {
    label: "PMOS is reading each ticket",
    hint: "Telling requests from bugs and questions, then matching them to existing ideas",
    pmos: true,
  },
  { label: "Preparing ideas for review", hint: "Almost there" },
];

interface ServerState {
  tickets: ZendeskTicket[];
  jiraSources: JiraSource[];
  ideas: Idea[];
  customerCatalog?: string[];
  jiraConnected?: boolean;
  csvMapping?: CsvMapping;
}

/** Case-insensitive lookup of a catalog color by name. */
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

/** Toggle pill (scope / Pending Review): accent-filled with a glow when on. */
function chipClass(active: boolean): string {
  return active
    ? "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-primary px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_-6px_var(--app-accent)]"
    : "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-[var(--app-glass)] px-3 text-[12.5px] font-semibold text-[#3f506b] shadow-sm hover:border-primary/55 hover:bg-white";
}

export function IdeasView({
  catalogProducts = [],
  catalogPlatforms = [],
  catalogCustomers = [],
  productColors = {},
  customerColors = {},
  defaultProducts = [],
  undoEnabled = false,
}: {
  /** Catalog chip colors (palette ids) by name — see lib/ideas/colors.ts. */
  productColors?: Record<string, string>;
  customerColors?: Record<string, string>;
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
  const { confirm } = useConfirm();
  const [tickets, setTickets] = useState<ZendeskTicket[]>([]);
  const [jiraSources, setJiraSources] = useState<JiraSource[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  // Server state carries the live customer catalog so approving a suggested
  // customer flips its chips without a reload; the prop is only the first paint.
  const [customerCatalog, setCustomerCatalog] = useState<string[]>(catalogCustomers);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [csvMapping, setCsvMapping] = useState<CsvMapping>(DEFAULT_CSV_MAPPING);
  const [hydrated, setHydrated] = useState(false);

  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState<string[]>(defaultProducts);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [pendingOnly, setPendingOnly] = useState(false);

  const [page, setPage] = useState<"final" | "merge">("final");
  const [edit, setEdit] = useState<MergeEdit | null>(null);
  const [selectedFinalId, setSelectedFinalId] = useState<string | null>(null);

  /** Product-line groups the PM folded shut on the Final page ("" = unassigned). */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerSrc, setDrawerSrc] = useState<{ kind: "zen" | "jira"; key: string } | null>(null);
  /** Drawer views left behind by in-drawer navigation (ticket → idea); Back pops one. */
  const [drawerHistory, setDrawerHistory] = useState<
    { ideaId: string | null; src: { kind: "zen" | "jira"; key: string } | null }[]
  >([]);
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
  /** Transient confirmation of an action (auto-dismisses). */
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const [importing, setImporting] = useState(false);
  /** Index into IMPORT_STEPS while the import overlay is up; null = closed. */
  const [importStep, setImportStep] = useState<number | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const applyState = (state: ServerState) => {
    setTickets(state.tickets);
    setJiraSources(state.jiraSources);
    setIdeas(state.ideas);
    if (state.customerCatalog) setCustomerCatalog(state.customerCatalog);
    if (state.jiraConnected !== undefined) setJiraConnected(state.jiraConnected);
    if (state.csvMapping) setCsvMapping(state.csvMapping);
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
      if (typeof data.notice === "string" && data.notice) setToast(data.notice);
      return true;
    } catch {
      setError("Update failed — is the dev server running?");
      return false;
    }
  };

  const ticketsByKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
  const ideasById = useMemo(() => new Map(ideas.map((i) => [i.id, i])), [ideas]);
  const jiraByKey = useMemo(() => new Map(jiraSources.map((s) => [s.key, s])), [jiraSources]);
  // Catalog names first, in the admin's manual order (their casing also wins
  // over idea-derived duplicates); names only found on ideas trail after,
  // alphabetically.
  const allProducts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of catalogProducts) {
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    const extras = new Map<string, string>();
    for (const name of ideas.flatMap((i) => i.products)) {
      const key = name.toLowerCase();
      if (!seen.has(key) && !extras.has(key)) extras.set(key, name);
    }
    return [
      ...seen.values(),
      ...Array.from(extras.values()).sort((a, b) => a.localeCompare(b)),
    ];
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
      const result = ticketsFromCsv(text, csvMapping);
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
      // The KPI panel and the grouped list tell the whole story — no
      // summary line.
      applyState(data.state);
      setNote("");
    } catch {
      setError("Import failed — is the dev server running?");
    } finally {
      setImporting(false);
      setImportStep(null);
    }
  };

  const clearAll = async () => {
    if (
      !(await confirm({
        title: "Are you sure?",
        message: "This removes every imported ticket and idea from this workspace.",
        confirmLabel: "Remove all",
        tone: "danger",
      }))
    )
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
    setSelectedFinalId(null);
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
        ? `${idea.undoable.jiraKey} will be permanently deleted in Jira — comments and edits made there are lost.`
        : `${idea.undoable.jiraKey} goes back to how it was before the merge. Fields edited in Jira since then are left alone.`;
    if (
      !(await confirm({
        title: "Undo the last merge?",
        message,
        confirmLabel: "Undo merge",
        tone: idea.undoable.action === "create" ? "danger" : "default",
      }))
    )
      return;
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

  // Opening the merge page selects nothing unless a specific idea was asked
  // for — the PM picks where to start.
  const gotoMerge = (id: string | null) => {
    const target = id != null ? (ideas.find((i) => i.id === id) ?? null) : null;
    setPage("merge");
    setDrawerId(null);
    setDrawerSrc(null);
    setEdit(target ? { ideaId: target.id, zen: [...target.zen], jira: [...target.jira] } : null);
    setSelectedFinalId(target ? target.id : null);
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
  // Partial export: the button opens as soon as anything is approved — the
  // all-reviewed gate applies per selected product line inside the modal.
  // No Jira integration → no export, whatever the review state.
  const injectDisabled = !jiraConnected || reviewed === 0;
  const injectHint = !jiraConnected
    ? "Connect Jira in Settings → Integrations to export"
    : reviewed === 0
      ? pending > 0
        ? `Approve ideas to enable exporting — ${pending} awaiting review`
        : "All changes already exported to Jira"
      : `Export approved changes to Jira`;

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
    if (statusFilter.includes("All")) {
      // "All" shows every idea, the unchanged Jira backlog included.
    } else if (statusFilter.length > 0) {
      if (!statusFilter.some((s) => STATUS_CHIP_TO_BATCH[s] === i.batch)) return false;
    } else if (i.batch === "unchanged") {
      // The Jira backlog dwarfs a Zendesk batch and is mostly unchanged —
      // unchanged ideas need no review, so they show only via their chip.
      return false;
    }
    if (pendingOnly && i.decision !== "pending") return false;
    return true;
  };

  const visible = ideas.filter(matches).sort(compareIdeas);

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
          : `${okCount} merged, ${failCount} failed — reopen Jira Merge to retry`
      );
    } catch {
      setMergeError("Merge failed — is the dev server running?");
    } finally {
      setPushing(false);
    }
  };

  const clearAllFilters = () => {
    setQuery("");
    setProductFilter([]);
    setPlatformFilter([]);
    setCustomerFilter([]);
    setStatusFilter([]);
    setPendingOnly(false);
  };

  const hasChipRow =
    productFilter.length > 0 ||
    platformFilter.length > 0 ||
    customerFilter.length > 0 ||
    pendingOnly;

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

  // Esc discards the merge edit (standing rule: Esc = cancel). The merge
  // modal's own Esc handler wins while it is open.
  useEffect(() => {
    if (!edit || confirmOpen || drawerId || drawerSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, confirmOpen, drawerId, drawerSrc]);

  // ——— Direction B view data ———
  const parked = tickets.filter((t) => t.catalog && t.catalog.kind !== "fr").length;
  const reviewedPct = total ? Math.round(((total - pending) / total) * 100) : 0;
  const allReviewed = total > 0 && pending === 0;
  // Votes that landed on Updated ideas this import (New ideas' votes are new
  // ideas, not momentum — they belong to the New card).
  const updatedVotes = live
    .filter((i) => i.batch === "updated")
    .reduce((a, i) => a + i.newVotes, 0);
  const pendingIn = (batch: Idea["batch"]) =>
    approvable.filter((i) => i.batch === batch && i.decision === "pending").length;
  // Who asks for the most: ideas per customer, top three, bars relative to the leader.
  const topCustomers = (() => {
    const m = new Map<string, number>();
    for (const i of live) for (const c of i.customers ?? []) m.set(c, (m.get(c) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  })();
  const maxVotes = Math.max(1, ...visible.map((i) => i.existingVotes + i.newVotes));
  // Rows grouped by first product line, in the catalog's manual order;
  // names outside the catalog follow alphabetically, "Unassigned" last.
  const groups = (() => {
    const m = new Map<string, Idea[]>();
    for (const i of visible) {
      const k = i.products[0] ?? "";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(i);
    }
    const rank = (name: string) => {
      if (!name) return Number.MAX_SAFE_INTEGER;
      const idx = allProducts.findIndex((p) => p.toLowerCase() === name.toLowerCase());
      return idx === -1 ? Number.MAX_SAFE_INTEGER - 1 : idx;
    };
    return [...m.entries()].sort(
      (a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])
    );
  })();
  const editedIdea = edit ? ideas.find((i) => i.id === edit.ideaId) : undefined;
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const editDirty =
    edit != null &&
    editedIdea != null &&
    !(sameSet(edit.zen, editedIdea.zen) && sameSet(edit.jira, editedIdea.jira));
  const editCount = edit ? edit.zen.length + edit.jira.length : 0;

  const productChip = (p: string, dot?: boolean) => {
    // Flag names the model returned that aren't in the Settings → Ideas
    // catalog ("Other" is a reserved value, not a miss) — observed, not corrected.
    const offCatalog =
      p !== "Other" && !catalogProducts.some((c) => c.toLowerCase() === p.toLowerCase());
    return offCatalog ? (
      <Chip key={p} kind="suggested" title="Not in the product-line catalog">
        {p} ⚑
      </Chip>
    ) : (
      <Chip key={p} dot={dot} style={chipStyle(colorOf(productColors, p), PRODUCT_CHIP_DEFAULT)}>
        {p}
      </Chip>
    );
  };
  const customerChip = (c: string) => {
    // Off-catalog names are suggestions awaiting PM review in the drawer —
    // flagged, never hidden.
    const offCatalog = !customerCatalog.some((k) => k.toLowerCase() === c.toLowerCase());
    return offCatalog ? (
      <Chip key={`customer-${c}`} kind="suggested" title="Suggested customer — review in the idea">
        {c} ⚑
      </Chip>
    ) : (
      <Chip
        key={`customer-${c}`}
        kind="customer"
        style={chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
      >
        {c}
      </Chip>
    );
  };

  const segment = (label: "Merge" | "Final", on: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      className={`font-title inline-flex h-8 items-center whitespace-nowrap rounded-control border px-4 text-[13px] font-semibold transition-[background,box-shadow] ${
        on
          ? "border-transparent bg-primary text-white shadow-[0_6px_18px_-6px_rgba(36,87,245,.8)]"
          : "border-border bg-[var(--app-glass)] text-fg-3 shadow-sm hover:border-primary/55 hover:bg-white"
      }`}
    >
      {label}
    </button>
  );

  const statCard = (key: "new" | "updated" | "archive", n: number, sub: string) => {
    const tone = STATUS_TONES[key];
    const label = key === "new" ? "New" : key === "updated" ? "Updated" : "Archive";
    return (
      <div className="relative flex flex-1 flex-col gap-0.5 overflow-hidden rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
        <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: tone.solid }} />
        <span className="flex items-baseline gap-2">
          <span className="font-title text-2xl font-bold leading-none">{n}</span>
          <span
            className="font-mono text-[10px] font-medium tracking-[0.04em]"
            style={{ color: tone.fg }}
          >
            {label}
          </span>
        </span>
        <span className="mt-1 text-[11.5px] text-fg-muted">{sub}</span>
      </div>
    );
  };

  const votesOf = (idea: Idea, size = 13) =>
    idea.existingVotes === 0 && idea.newVotes === 0 ? (
      <span className="text-fg-disabled" style={{ fontSize: size }}>
        —
      </span>
    ) : (
      <span
        className="inline-flex items-center gap-1 font-semibold text-fg-2"
        style={{ fontSize: size }}
      >
        <ThumbsUp size={size} className="text-fg-faint" />
        {idea.existingVotes > 0 && <span>{idea.existingVotes}</span>}
        {idea.newVotes > 0 && (
          <span className="text-success">
            {idea.existingVotes > 0 ? `(+${idea.newVotes})` : `+${idea.newVotes}`}
          </span>
        )}
      </span>
    );

  return (
    <div className="app-canvas font-title min-h-full">
      <div className="mx-auto w-full max-w-[1680px] px-7 pb-24 pt-6">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />

        {/* Header */}
        <div className="mb-4 flex items-center gap-3.5">
          <div>
            <div className="eyebrow mb-1 text-primary">Zendesk → Ideas → Jira</div>
            <h1 className="font-title m-0 text-[26px] font-bold leading-none tracking-[-0.02em]">
              Ideas
            </h1>
          </div>
          {ideas.length > 0 && (
            <div className="ml-5 flex items-center gap-1.5">
              {segment("Merge", page === "merge", () => gotoMerge(null))}
              <ArrowRight size={13} className="text-fg-faint" />
              {segment("Final", page === "final", () => {
                setPage("final");
                cancelEdit();
              })}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {tickets.length > 0 && (
              <Button variant="ghost" onClick={clearAll}>
                <Trash2 size={13} />
                Clear import
              </Button>
            )}
            <Button onClick={() => fileRef.current?.click()} disabled={importing}>
              <Upload size={13} />
              {importing ? "Importing…" : "Upload Zendesk CSV"}
            </Button>
            {ideas.length > 0 && (
              <span title={injectHint} className="inline-flex">
                <Button variant="primary" glow disabled={injectDisabled} onClick={openMerge}>
                  <GitMerge size={13} strokeWidth={2.25} />
                  Jira Merge
                </Button>
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-4 py-2.5 text-[13px] text-[#c94266]">
            {error}
          </div>
        )}
        {note && (
          <div className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#0f7a47]">
            <Check size={12} strokeWidth={2.5} />
            {note}
          </div>
        )}

        {!hydrated ? null : ideas.length === 0 ? (
          /* Empty state */
          <div className="glass rounded-card px-10 py-16 text-center">
            <div className="font-title mb-1 text-[16px] font-bold">No ideas yet</div>
            <div className="mx-auto mb-5 max-w-[440px] text-[13px] leading-relaxed text-fg-3">
              Upload a Zendesk ticket export (CSV) to create the first idea batch. Each ticket
              becomes a New idea you can review, edit and approve.
            </div>
            <Button variant="primary" glow onClick={() => fileRef.current?.click()} disabled={importing}>
              <Upload size={14} />
              {importing ? "Importing…" : "Upload Zendesk CSV"}
            </Button>
          </div>
        ) : (
          <>
            {/* KPI panel: review ring, batch stat cards, most-requested-by */}
            <div className="glass-weak mb-4 flex items-stretch gap-3 rounded-card p-3">
              <div className="flex min-w-[280px] items-center gap-3.5 py-1.5 pl-1.5 pr-3.5">
                <Ring value={reviewedPct} color={allReviewed ? "#17b26a" : "var(--app-accent)"} />
                <div>
                  <div className="font-title text-[15px] font-bold">
                    {allReviewed ? "Review complete" : "Review in Progress"}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-fg-3">
                    {allReviewed ? (
                      <span className="font-semibold text-[#0f7a47]">
                        All {total} idea{total === 1 ? "" : "s"} approved
                      </span>
                    ) : (
                      `${pending} of ${total} awaiting review`
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-fg-faint">
                    {tickets.length} ticket{tickets.length === 1 ? "" : "s"} · {parked} parked ·{" "}
                    {counts.unchanged} unchanged
                  </div>
                </div>
              </div>
              {statCard(
                "new",
                counts.new,
                pendingIn("new") > 0 ? `${pendingIn("new")} pending` : counts.new > 0 ? "All reviewed" : "None this import"
              )}
              {statCard(
                "updated",
                counts.updated,
                counts.updated === 0
                  ? "None this import"
                  : updatedVotes > 0
                    ? `+${updatedVotes} vote${updatedVotes === 1 ? "" : "s"} this import`
                    : "Details enriched"
              )}
              {statCard(
                "archive",
                counts.archive,
                pendingIn("archive") > 0 ? `${pendingIn("archive")} to decide` : counts.archive > 0 ? "All reviewed" : "Nothing proposed"
              )}
              <div className="flex flex-[1.1] flex-col gap-1.5 rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
                <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">
                  Most Requested By
                </span>
                {topCustomers.length === 0 ? (
                  <span className="text-[12px] text-fg-faint">No customers named yet</span>
                ) : (
                  topCustomers.map(([name, n]) => (
                    <span key={name} className="flex items-center gap-2 text-[12px]">
                      <Avatar
                        name={name}
                        size={16}
                        style={chipStyle(colorOf(customerColors, name), CUSTOMER_CHIP_DEFAULT)}
                      />
                      <span className="min-w-0 flex-1 truncate text-fg-2">{name}</span>
                      <span className="inline-flex h-1 w-[54px] overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                        <span
                          className="block h-full bg-primary"
                          style={{ width: `${Math.round((n / topCustomers[0][1]) * 100)}%` }}
                        />
                      </span>
                      <span className="w-4 text-right font-mono text-[10.5px] text-fg-muted">{n}</span>
                    </span>
                  ))
                )}
              </div>
            </div>

            {/* Filters — one toolbar row; active-value chips appear below only when set */}
            <div className="mb-3.5 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-[250px]">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search ideas…"
                    className="h-8 w-full rounded-control border border-border bg-[var(--app-glass)] pl-9 pr-3 text-[13px] shadow-sm outline-none placeholder:text-fg-faint focus:border-primary focus:bg-white focus:shadow-[0_0_0_2px_var(--app-accent-soft)]"
                  />
                </div>

                {allProducts.length > 0 && (
                  <FilterPopover
                    label="Product Line"
                    options={allProducts}
                    selected={productFilter}
                    onToggle={(o) =>
                      setProductFilter((prev) =>
                        prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]
                      )
                    }
                    emptyText="No matching product line"
                  />
                )}
                {catalogPlatforms.length > 0 && (
                  <FilterPopover
                    label="Platform"
                    accent="platform"
                    options={catalogPlatforms}
                    selected={platformFilter}
                    onToggle={(o) =>
                      setPlatformFilter((prev) =>
                        prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]
                      )
                    }
                    emptyText="No matching platform"
                  />
                )}
                {allCustomers.length > 0 && (
                  <FilterPopover
                    label="Customer"
                    accent="customer"
                    options={allCustomers}
                    selected={customerFilter}
                    onToggle={(o) =>
                      setCustomerFilter((prev) =>
                        prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]
                      )
                    }
                    emptyText="No matching customer"
                  />
                )}
                <FilterPopover
                  single
                  label="Status"
                  accent="status"
                  options={["All", ...Object.keys(STATUS_CHIP_TO_BATCH)]}
                  selected={statusFilter}
                  onToggle={(o) => setStatusFilter((prev) => (prev.includes(o) ? [] : [o]))}
                />
                <span className="mx-1 h-5 w-px bg-border" />
                <button onClick={() => setPendingOnly((v) => !v)} className={chipClass(pendingOnly)}>
                  Pending Review
                  {pendingOnly && <Check size={12} strokeWidth={3} />}
                </button>

                <div className="ml-auto flex shrink-0 items-center gap-2.5">
                  {page === "final" && (
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-3">
                      <Layers size={13} className="text-primary" />
                      Grouped by <b className="font-semibold text-fg-2">Product line</b>
                    </span>
                  )}
                  {page === "final" && (
                    <span title={pending > 0 ? `${pending} awaiting review` : "All approved"}>
                      <Button
                        size="sm"
                        onClick={() => {
                          setNote("");
                          void callMutate({ type: "approveAll" });
                        }}
                      >
                        <CheckCheck size={13} strokeWidth={2.25} />
                        {pending > 0 ? "Approve all" : "Undo approve all"}
                      </Button>
                    </span>
                  )}
                </div>
              </div>

              {hasChipRow && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`${MONO_LABEL} mr-1`}>Filters</span>
                  {productFilter.map((option) => (
                    <button
                      key={`p-${option}`}
                      onClick={() => setProductFilter((prev) => prev.filter((x) => x !== option))}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-mono text-[11px] font-semibold text-white ${FILTER_ACCENTS.product.chip}`}
                    >
                      {option} ✕
                    </button>
                  ))}
                  {platformFilter.map((option) => (
                    <button
                      key={`pl-${option}`}
                      onClick={() => setPlatformFilter((prev) => prev.filter((x) => x !== option))}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-mono text-[11px] font-semibold text-white ${FILTER_ACCENTS.platform.chip}`}
                    >
                      {option} ✕
                    </button>
                  ))}
                  {customerFilter.map((option) => (
                    <button
                      key={`c-${option}`}
                      onClick={() => setCustomerFilter((prev) => prev.filter((x) => x !== option))}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-mono text-[11px] font-semibold text-white ${FILTER_ACCENTS.customer.chip}`}
                    >
                      {option} ✕
                    </button>
                  ))}
                  {pendingOnly && (
                    <button
                      onClick={() => setPendingOnly(false)}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-mono text-[11px] font-semibold text-white ${FILTER_ACCENTS.status.chip}`}
                    >
                      Pending Review ✕
                    </button>
                  )}
                  <button
                    onClick={clearAllFilters}
                    className="ml-1 text-[12px] font-semibold text-primary hover:underline"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>

            {/* Body: merge board or grouped idea rows */}
            {page === "merge" ? (
              <div className="flex flex-col gap-3">
                {edit && editedIdea ? (
                  <div className="flex items-center gap-2.5 rounded-inner border border-[rgba(23,178,106,.35)] bg-[rgba(23,178,106,.12)] px-3.5 py-2.5 text-[13px] text-[#0f7a47]">
                    <GitMerge size={15} strokeWidth={2.25} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      Editing <b className="font-semibold">{editedIdea.title}</b> —{" "}
                      {editCount} source{editCount === 1 ? "" : "s"} selected. Tick a Zendesk or Jira
                      row to attach it; ✓ on the idea saves, ✕ or Esc discards.
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-fg-3">
                    <GitMerge size={14} className="text-primary" />
                    Pick an idea in Final to edit its sources · a source's N× shows every idea it backs
                  </div>
                )}
                <MergePage
                  ideas={ideas}
                  tickets={tickets}
                  jiraSources={jiraSources}
                  query={query}
                  productFilter={productFilter}
                  platformFilter={platformFilter}
                  customerFilter={customerFilter}
                  pendingOnly={pendingOnly}
                  statusFilter={statusFilter}
                  productColors={productColors}
                  edit={edit}
                  selectedFinalId={selectedFinalId}
                  onStartEdit={startEdit}
                  onSaveEdit={saveEdit}
                  onCancelEdit={cancelEdit}
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
              </div>
            ) : (
              <div className="flex flex-col gap-3.5">
                {groups.map(([groupName, list]) => {
                  const name = groupName || "Unassigned";
                  const color = groupName
                    ? chipStyle(colorOf(productColors, groupName), PRODUCT_CHIP_DEFAULT)
                    : { background: "var(--app-hairline)", color: "var(--app-fg-muted)" };
                  const votes = list.reduce((a, i) => a + i.existingVotes + i.newVotes, 0);
                  const groupPending = list.filter(
                    (i) => needsApproval(i) && i.decision === "pending"
                  ).length;
                  const open = !collapsedGroups.includes(groupName);
                  return (
                    <section key={groupName || "__unassigned"} className="glass overflow-hidden rounded-card">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedGroups((prev) =>
                            prev.includes(groupName)
                              ? prev.filter((g) => g !== groupName)
                              : [...prev, groupName]
                          )
                        }
                        aria-expanded={open}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
                        style={{
                          borderBottom: open ? "1px solid var(--app-hairline)" : "none",
                          background: `linear-gradient(90deg, color-mix(in srgb, ${color.color} 14%, white), rgba(255,255,255,0) 60%)`,
                        }}
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                          style={{
                            background: color.color,
                            boxShadow: `0 0 10px color-mix(in srgb, ${color.color} 60%, transparent)`,
                          }}
                        />
                        <span className="font-title text-[14px] font-bold">{name}</span>
                        <span className="font-mono text-[11px] text-fg-muted">
                          {list.length} idea{list.length === 1 ? "" : "s"}
                        </span>
                        <span className="ml-auto flex items-center gap-[18px] text-[12px] text-fg-3">
                          <span className="inline-flex items-center gap-1.5">
                            <ThumbsUp size={12} className="text-fg-faint" />
                            <b className="font-title font-bold text-foreground">{votes}</b> votes
                          </span>
                          {groupPending > 0 ? (
                            <span className="font-semibold text-[#c98a00]">{groupPending} pending</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-[#0f7a47]">
                              <Check size={12} strokeWidth={3} />
                              All reviewed
                            </span>
                          )}
                          <ChevronDown
                            size={14}
                            className={`text-fg-faint transition-transform ${open ? "" : "-rotate-90"}`}
                          />
                        </span>
                      </button>
                      {open &&
                        list.map((idea) => {
                          const badge = badgeOf(idea);
                          const score = SCORING_ENABLED ? scoreOf(idea) : null;
                          const isOpen = drawerId === idea.id;
                          const blocked =
                            idea.decision === "pending" && unresolvedSuggested(idea).length > 0;
                          const firstTicket = idea.zen[0] ? ticketsByKey.get(idea.zen[0]) : undefined;
                          const customers = idea.customers ?? [];
                          return (
                            <div
                              key={idea.id}
                              onClick={() => setDrawerId(idea.id)}
                              className="flex h-[58px] cursor-pointer items-center gap-3.5 border-b border-hairline px-4 transition-colors last:border-b-0 hover:bg-white/70"
                              style={
                                isOpen
                                  ? {
                                      background: "var(--app-accent-soft)",
                                      boxShadow: "inset 3px 0 0 var(--app-accent)",
                                    }
                                  : undefined
                              }
                            >
                              {needsApproval(idea) ? (
                                <ApproveMark
                                  on={idea.decision !== "pending"}
                                  blocked={blocked}
                                  title={
                                    blocked
                                      ? "Approve or dismiss the suggested customers first"
                                      : idea.decision === "pending"
                                        ? "Mark reviewed"
                                        : "Mark unreviewed"
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleApprove(idea.id);
                                  }}
                                />
                              ) : (
                                <span className="h-5 w-5 shrink-0" aria-hidden />
                              )}
                              <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-[13.5px] font-semibold text-foreground">
                                    {idea.title}
                                  </span>
                                  {score && score.value != null && (
                                    <span className="font-mono text-[10.5px] font-semibold text-fg-muted">
                                      {score.value}
                                    </span>
                                  )}
                                </span>
                                <span className="flex items-center gap-1.5 overflow-hidden text-[11.5px] text-fg-muted">
                                  {firstTicket ? (
                                    <span className="shrink-0 font-mono font-semibold">
                                      {firstTicket.id}
                                      {idea.zen.length > 1 ? ` +${idea.zen.length - 1}` : ""}
                                    </span>
                                  ) : null}
                                  {idea.jira[0] && (
                                    <span className="shrink-0 font-mono font-semibold text-[#2a5fd0]">
                                      {idea.jira[0]}
                                    </span>
                                  )}
                                  {(firstTicket || idea.jira[0]) &&
                                    (idea.products.length > 1 ||
                                      (idea.platforms ?? []).length > 0 ||
                                      customers.length > 0 ||
                                      idea.affectsAllCustomers) && <span>·</span>}
                                  {idea.products.slice(1).map((p) => productChip(p))}
                                  {(idea.platforms ?? []).map((p) => (
                                    <Chip key={`platform-${p}`} kind="platform">
                                      {p}
                                    </Chip>
                                  ))}
                                  {idea.affectsAllCustomers && (
                                    <Chip
                                      kind="all"
                                      title="A supporting ticket marks this as affecting all customers"
                                    >
                                      All customers
                                    </Chip>
                                  )}
                                  {customers.slice(0, 2).map(customerChip)}
                                  {customers.length > 2 && (
                                    <span className="shrink-0">+{customers.length - 2}</span>
                                  )}
                                </span>
                              </div>
                              <span className="flex w-24 shrink-0 items-center">
                                {customers.slice(0, 3).map((c, k) => (
                                  <Avatar
                                    key={c}
                                    name={c}
                                    size={26}
                                    className={k ? "-ml-2" : ""}
                                    style={chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
                                  />
                                ))}
                                {customers.length === 0 && (
                                  <span className="text-[11.5px] text-fg-disabled">Internal</span>
                                )}
                              </span>
                              {/* Votes — the "+N" jumps to the Merge page with this idea selected */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (idea.newVotes > 0) gotoMerge(idea.id);
                                }}
                                title={idea.newVotes > 0 ? "Show merge sources" : undefined}
                                className={`flex w-[84px] shrink-0 flex-col items-end gap-[3px] rounded-control border border-transparent px-1.5 py-1 ${
                                  idea.newVotes > 0
                                    ? "cursor-pointer hover:border-border hover:bg-white"
                                    : "cursor-default"
                                }`}
                              >
                                {votesOf(idea)}
                                <VoteBar
                                  existing={idea.existingVotes}
                                  added={idea.newVotes}
                                  max={maxVotes}
                                />
                              </button>
                              <span className="flex w-[84px] shrink-0 justify-end">
                                {badge && (
                                  <Pill
                                    badge={badge}
                                    title={
                                      idea.batch === "updated" && (idea.batchChanges ?? []).length > 0
                                        ? (idea.batchChanges ?? []).join("\n")
                                        : undefined
                                    }
                                  />
                                )}
                              </span>
                            </div>
                          );
                        })}
                    </section>
                  );
                })}
                {visible.length === 0 && (
                  <div className="glass rounded-card p-10 text-center text-sm text-fg-3">
                    No ideas match.{" "}
                    {hasFilters && (
                      <button onClick={clearAllFilters} className="font-semibold text-primary hover:underline">
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Item details drawer */}
      {(drawerIdea || drawerSrc) && (
        <IdeaDrawer
          key={drawerIdea ? drawerIdea.id : `src:${drawerSrc?.kind}:${drawerSrc?.key}`}
          idea={drawerIdea ?? null}
          initialSource={drawerSrc}
          ticketsByKey={ticketsByKey}
          jiraByKey={jiraByKey}
          csvMapping={csvMapping}
          ideasById={ideasById}
          catalogProducts={catalogProducts}
          catalogPlatforms={catalogPlatforms}
          productColors={productColors}
          customerColors={customerColors}
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
            setDrawerHistory([]);
          }}
          onBack={
            drawerHistory.length > 0
              ? () => {
                  const prev = drawerHistory[drawerHistory.length - 1];
                  setDrawerHistory((h) => h.slice(0, -1));
                  setDrawerId(prev.ideaId);
                  setDrawerSrc(prev.src);
                }
              : undefined
          }
          onOpenIdea={(id, from) => {
            if (!ideasById.has(id)) return;
            setDrawerHistory((h) => [...h, { ideaId: drawerIdea?.id ?? null, src: from.source }]);
            setDrawerId(id);
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

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-inner bg-[#0b1430] px-4 py-2.5 text-[13px] font-medium text-white shadow-[0_12px_32px_rgba(10,22,40,.3)]"
        >
          {toast}
        </div>
      )}

      {/* Import progress overlay */}
      {importStep !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]">
          <div className="glass-strong flex w-[440px] max-w-full flex-col gap-5 overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]">
            <div className="h-[3px] bg-[linear-gradient(90deg,var(--app-accent),#17b26a)]" />
            <div className="flex flex-col gap-5 px-6 pb-6">
              <div>
                <div className="eyebrow mb-1.5 text-primary">Zendesk → Ideas</div>
                <div className="font-title text-[20px] font-bold">Importing tickets</div>
                <div className="mt-1 text-[13px] text-fg-3">
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
                      className={`flex items-start gap-3 rounded-control px-2.5 py-2 transition-colors ${
                        active ? "bg-[var(--app-accent-soft)]" : ""
                      }`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center pt-px">
                        {done ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(23,178,106,.16)]">
                            <Check size={12} strokeWidth={3} className="text-[#0f7a47]" />
                          </span>
                        ) : active ? (
                          <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-[#c9d4e4]" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`inline-flex items-center gap-1.5 text-[13px] ${
                            active ? "font-semibold text-foreground" : done ? "text-fg-3" : "text-fg-faint"
                          }`}
                        >
                          {step.pmos && <PmosMark size={17} />}
                          {step.label}
                        </span>
                        {active && <span className="text-[11.5px] text-fg-3">{step.hint}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Merge-to-Jira modal: scope → preview → execute → results */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]"
          onClick={closeMerge}
        >
          <div
            className="glass-strong flex w-[640px] max-w-full flex-col overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-[3px] bg-[linear-gradient(90deg,var(--app-accent),#17b26a)]" />
            {pushResults ? (
              <>
                <div className="flex flex-col gap-4 px-[26px] pb-5 pt-[22px]">
                  <div>
                    <div className="eyebrow mb-1.5 text-primary">Jira Merge · Result</div>
                    <h2 className="font-title m-0 text-[22px] font-bold">
                      {pushResults.every((r) => r.ok) ? "Merged to Jira" : "Merge finished with errors"}
                    </h2>
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-fg-3">
                      {pushResults.filter((r) => r.ok).length} of {pushResults.length} change
                      {pushResults.length === 1 ? "" : "s"} written. Failed ideas stay approved —
                      run Jira Merge again to retry just those.
                    </p>
                  </div>
                  <div className="flex max-h-80 flex-col overflow-y-auto rounded-inner border border-border">
                    {pushResults.map((r, k) => (
                      <div
                        key={r.ideaId}
                        className={`flex items-start gap-3 px-3 py-2 ${k ? "border-t border-hairline" : ""}`}
                      >
                        <span
                          className={`mt-0.5 shrink-0 text-[13px] font-semibold ${r.ok ? "text-[#0f7a47]" : "text-[#c23767]"}`}
                        >
                          {r.ok ? "✓" : "✕"}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-medium text-fg-2">{r.title}</span>
                          {r.ok ? (
                            <span className="text-[11.5px] text-fg-muted">
                              {r.action === "create"
                                ? `Created ${r.jiraKey}`
                                : r.action === "update"
                                  ? `Updated ${r.jiraKey}`
                                  : `${r.jiraKey} already up to date`}
                            </span>
                          ) : (
                            <span className="text-[11.5px] text-[#c23767]">{r.error}</span>
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
                </div>
                <div className="flex justify-end gap-2 border-t border-border bg-[rgba(247,250,253,.8)] px-[26px] py-3.5">
                  <Button variant="primary" glow onClick={closeMerge}>
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-4 px-[26px] pb-5 pt-[22px]">
                  <div>
                    <div className="eyebrow mb-1.5 text-primary">
                      {plan ? "Jira Merge · Preview" : "Zendesk → Jira"}
                    </div>
                    <h2 className="font-title m-0 text-[22px] font-bold">Jira Merge</h2>
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-fg-3">
                      Pick the product lines to merge. Only approved ideas are written — anything
                      still pending stays here for a later merge.
                    </p>
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
                        {scopeSel.includes(p) && <Check size={11} strokeWidth={3} />}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-fg-3">{previewHint}</div>

                  {/* Preview */}
                  {plan && (
                    <>
                      <div className="grid grid-cols-2 gap-2.5">
                        {(
                          [
                            ["Create", plan.items.filter((i) => i.action === "create").length, "#17b26a", PlusCircle],
                            ["Update", plan.items.filter((i) => i.action !== "create").length, "#3b7cf6", RefreshCw],
                          ] as const
                        ).map(([label, n, c, Icon]) => (
                          <div
                            key={label}
                            className="flex items-center gap-3 rounded-inner px-3.5 py-3"
                            style={{
                              background: `color-mix(in srgb, ${c} 10%, white)`,
                              border: `1px solid color-mix(in srgb, ${c} 35%, white)`,
                            }}
                          >
                            <Icon size={18} style={{ color: c }} />
                            <span>
                              <span className="font-title block text-[22px] font-bold leading-none">{n}</span>
                              <span className="eyebrow text-[9.5px]" style={{ color: c }}>
                                {label} in Jira
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="flex max-h-72 flex-col overflow-y-auto rounded-inner border border-border">
                        {plan.blockers.map((b) => (
                          <div
                            key={b}
                            className="border-b border-hairline bg-[#fdeef2] px-3 py-2 text-[12.5px] text-[#c23767]"
                          >
                            {b}
                          </div>
                        ))}
                        {plan.items.map((item, k) => (
                          <div
                            key={item.ideaId}
                            className={`flex flex-col gap-1 px-3 py-2 ${k ? "border-t border-hairline" : ""}`}
                          >
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-14 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold"
                                style={{
                                  background: item.action === "create" ? STATUS_TONES.new.soft : STATUS_TONES.updated.soft,
                                  color: item.action === "create" ? STATUS_TONES.new.fg : STATUS_TONES.updated.fg,
                                }}
                              >
                                {item.action === "create" ? "New" : "Update"}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-2">
                                {item.title}
                              </span>
                              <span className="shrink-0 font-mono text-[10.5px] text-fg-muted">
                                {item.action === "create" ? "→ new issue" : item.jiraKey}
                              </span>
                            </div>
                            <span className="pl-[66px] text-[11.5px] text-fg-muted">
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
                            className="border-t border-hairline bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
                          >
                            {w}
                          </div>
                        ))}
                        {plan.skipped.map((s) => (
                          <div key={s.ideaId} className="border-t border-hairline px-3 py-1.5 text-[11.5px] text-fg-muted">
                            Skipped “{s.title}” — {s.reason}
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {mergeError && (
                    <div className="rounded-inner border border-[#f3c9d5] bg-[#fdeef2] px-3 py-2 text-[12.5px] text-[#c23767]">
                      {mergeError}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-border bg-[rgba(247,250,253,.8)] px-[26px] py-3.5">
                  <Button onClick={closeMerge}>Cancel</Button>
                  {!plan ? (
                    <span title={previewHint} className="inline-flex">
                      <Button variant="primary" glow disabled={previewDisabled || planLoading} onClick={loadPlan}>
                        {planLoading ? "Checking Jira…" : "Preview changes"}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="primary"
                      glow
                      disabled={pushing || plan.blockers.length > 0 || plan.items.length === 0}
                      onClick={runPush}
                    >
                      <GitMerge size={13} strokeWidth={2.25} />
                      {pushing ? "Merging…" : `Confirm merge (${plan.items.length})`}
                    </Button>
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
