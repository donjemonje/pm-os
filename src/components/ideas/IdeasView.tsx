"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { jiraHealthMessage, jiraHealthTitle, type JiraHealthStatus } from "@/lib/jira-health-copy";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Layers,
  PlusCircle,
  RefreshCw,
  Search,
  ThumbsUp,
  Trash2,
  Upload,
  ExternalLink,
  Undo2,
  Share2,
  Flag,
  Plus,
} from "lucide-react";
import { LazyIdeaDetailsEditor } from "@/components/ideas/LazyIdeaDetailsEditor";
import { ticketsFromCsv } from "@/lib/ideas/csv";
import { track } from "@/lib/analytics/track";
import { type CsvMapping, DEFAULT_CSV_MAPPING } from "@/lib/ideas/csv-mapping";
import {
  badgeOf,
  compareIdeas,
  needsApproval,
  SCORING_ENABLED,
  scoreOf,
  STATUS_CHIP_TO_BATCH,
  STATUS_TONES,
  zenLabel,
} from "@/lib/ideas/idea";
import type { IdeaSyncPreview, PushPlan, PushResult } from "@/lib/ideas/push";
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
import {
  chipStyle,
  CUSTOMER_CHIP_DEFAULT,
  paletteColorFor,
  PRODUCT_CHIP_DEFAULT,
} from "@/lib/ideas/colors";
import { IdeaDrawer } from "./IdeaDrawer";
import { MergePage } from "./MergePage";
import { NewIdeaDrawer } from "./NewIdeaDrawer";

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
    hint: "Classifying, splitting, matching and ideating",
    pmos: true,
  },
  { label: "Preparing ideas for review", hint: "Almost there" },
];

const WarmDetailsEditor = LazyIdeaDetailsEditor;

interface ServerState {
  tickets: ZendeskTicket[];
  jiraSources: JiraSource[];
  ideas: Idea[];
  customerCatalog?: string[];
  jiraConnected?: boolean;
  jiraEnabled?: boolean;
  jiraHealth?: JiraHealthStatus;
  csvMapping?: CsvMapping;
  jiraSiteUrl?: string | null;
  jiraProductLineField?: string;
}

/** Case-insensitive lookup of a catalog color by name. */
function colorOf(map: Record<string, string>, name: string): string | undefined {
  if (map[name]) return map[name];
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

/** Sync scope sentinel: the user cleared every product line (vs. [] = all). */
const SCOPE_NONE = "__none__";
/** Jira statuses that mean "shipped" — hidden by default when nothing asks for them. */
function isJiraDoneStatus(status: string): boolean {
  return /^(done|closed|resolved|released|shipped)$/i.test(status.trim());
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
  const router = useRouter();
  const [tickets, setTickets] = useState<ZendeskTicket[]>([]);
  const [jiraSources, setJiraSources] = useState<JiraSource[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  // Server state carries the live customer catalog so approving a suggested
  // customer flips its chips without a reload; the prop is only the first paint.
  const [customerCatalog, setCustomerCatalog] = useState<string[]>(catalogCustomers);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraEnabled, setJiraEnabled] = useState(false);
  const [jiraHealth, setJiraHealth] = useState<JiraHealthStatus>("ok");
  const [jiraSiteUrl, setJiraSiteUrl] = useState<string | null>(null);
  const [jiraProductLineField, setJiraProductLineField] = useState("Product line");
  const [csvMapping, setCsvMapping] = useState<CsvMapping>(DEFAULT_CSV_MAPPING);
  const [hydrated, setHydrated] = useState(false);

  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState<string[]>(defaultProducts);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  /** Jira status filter (the issue's own workflow status, e.g. Backlog / Done). */
  const [jiraStatusFilter, setJiraStatusFilter] = useState<string[]>([]);
  const [pendingOnly, setPendingOnly] = useState(false);

  const [page, setPageState] = useState<"final" | "merge">("final");
  const setPage = (p: "final" | "merge") => {
    track("page_toggle", { to: p });
    setPageState(p);
  };
  const [edit, setEdit] = useState<MergeEdit | null>(null);
  const [selectedFinalId, setSelectedFinalId] = useState<string | null>(null);

  /** Product-line groups the PM folded shut on the Final page ("" = unassigned). */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  /** "New idea" — a PM writes one from scratch (origin "manual"). */
  const [newIdeaOpen, setNewIdeaOpen] = useState(false);
  /** "Changes to sync" for every Jira-backed idea, prefetched in the
   *  background on load and after every change (one plan run, ~1 s), so the
   *  drawer opens with its section already in hand. */
  const [previews, setPreviews] = useState<Record<string, IdeaSyncPreview>>({});
  const [stateVersion, setStateVersion] = useState(0);
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
  /** A PMOS AI call started from the drawer (rewrite / create from ticket):
   *  shown as a full-screen wait owned by the page, so closing the drawer
   *  neither hides it nor looks like it stopped. */
  const [aiWait, setAiWait] = useState<{ title: string; what: string } | null>(null);
  const withAiWait = async (title: string, what: string, run: () => Promise<boolean>) => {
    setAiWait({ title, what });
    try {
      return await run();
    } finally {
      setAiWait(null);
    }
  };

  const fileRef = useRef<HTMLInputElement>(null);

  const applyState = (state: ServerState, opts: { refreshShell?: boolean } = { refreshShell: true }) => {
    setStateVersion((v) => v + 1);
    setTickets(state.tickets);
    setJiraSources(state.jiraSources);
    setIdeas(state.ideas);
    if (state.customerCatalog) setCustomerCatalog(state.customerCatalog);
    if (state.jiraConnected !== undefined) setJiraConnected(state.jiraConnected);
    if (state.jiraEnabled !== undefined) setJiraEnabled(state.jiraEnabled);
    if (state.jiraHealth !== undefined) setJiraHealth(state.jiraHealth);
    if (state.jiraSiteUrl !== undefined) setJiraSiteUrl(state.jiraSiteUrl);
    if (state.jiraProductLineField) setJiraProductLineField(state.jiraProductLineField);
    if (state.csvMapping) setCsvMapping(state.csvMapping);
    // The sidebar's pending badge is rendered by the root layout on the
    // server; a mutation here must re-render it (client state survives).
    if (opts.refreshShell) router.refresh();
  };

  // The drawer's text editor (Tiptap) pays a one-time cost the first time it
  // mounts in a page: chunk fetch (and compile in dev), schema and extension
  // setup, first layout. A hidden instance mounts right after the page is up
  // and goes away a moment later, so the first real edit is as instant as
  // the second (Daniel, 2026-10-19).
  const [warmEditor, setWarmEditor] = useState(true);
  useEffect(() => {
    track("page_view", { name: "ideas" });
  }, []);
  // Searches: one event per settled query (not per keystroke).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(() => track("search", { query: q.slice(0, 80), page }), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => {
    const t = setTimeout(() => setWarmEditor(false), 4000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ideas");
        if (res.ok) {
          applyState(await res.json(), { refreshShell: false });
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

  useEffect(() => {
    if (!jiraConnected || ideas.length === 0) {
      setPreviews({});
      return;
    }
    // Debounced: a burst of state applies (import steps, quick clicks) runs
    // one prefetch; a newer version cancels an older in-flight one.
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/ideas/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "previewAll" }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.previews) setPreviews(d.previews);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // stateVersion bumps on every server state apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateVersion, jiraConnected, ideas.length > 0]);
  const ideasById = useMemo(() => new Map(ideas.map((i) => [i.id, i])), [ideas]);
  // Issues a sync created exist in Jira but not in the snapshot until the next
  // import — they get a stand-in source (idea title, browse link) so the drawer
  // and the Merge page link them like any other Jira issue.
  const jiraByKey = useMemo(() => {
    const map = new Map(jiraSources.map((s) => [s.key, s]));
    if (jiraSiteUrl) {
      for (const idea of ideas) {
        for (const key of idea.jira) {
          if (!map.has(key)) {
            map.set(key, {
              key,
              id: key,
              title: idea.title,
              body: "",
              url: `${jiraSiteUrl}/browse/${key}`,
              products: idea.products,
            });
          }
        }
      }
    }
    return map;
  }, [jiraSources, ideas, jiraSiteUrl]);
  /** Distinct Jira statuses in the pulled backlog — the Jira status filter's options. */
  const jiraStatuses = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of jiraSources) {
      if (s.status && !seen.has(s.status.toLowerCase())) seen.set(s.status.toLowerCase(), s.status);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [jiraSources]);
  /** The idea's Jira status: the status of its first linked issue (ideas hold one). */
  const jiraStatusOf = (i: Idea): string | undefined =>
    i.jira.map((k) => jiraByKey.get(k)?.status).find(Boolean);
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
    track("import_start", { bytes: file.size });
    const importStarted = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const text = await file.text();
      const result = ticketsFromCsv(text, csvMapping);
      if (result.errors.length > 0) {
        setError(result.errors[0]);
        return;
      }
      // Jira is expected for this org: probe the connection right now (a
      // fresh check, not the cached one) and let the user decide — import
      // Zendesk only (no matching against the backlog) or stop. Nothing to
      // fix on their side: a dead connection is PM-OS support's to replace.
      let skipJira = false;
      if (jiraEnabled) {
        const health = await fetch("/api/jira/health?fresh=1")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const status: JiraHealthStatus = health?.status ?? "unavailable";
        setJiraHealth(status);
        if (status !== "ok") {
          setImporting(false);
          setImportStep(null);
          const proceed = await confirm({
            title: jiraHealthTitle(status),
            message: `${jiraHealthMessage(status)} You can import Zendesk only — tickets will not be matched against your Jira backlog.`,
            confirmLabel: "Import without Jira",
            cancelLabel: "Cancel",
          });
          if (!proceed) return;
          skipJira = true;
          setImporting(true);
          setImportStep(0);
        }
      }
      // The overlay steps are a high-level narration of one server call; the
      // AI-review step holds until the response lands (it dominates the wait).
      await sleep(600);
      setImportStep(1);
      const resPromise = fetch("/api/ideas/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickets: result.tickets, skipJira }),
      });
      await sleep(900);
      setImportStep(2);
      const res = await resPromise;
      const data = await res.json();
      if (!res.ok) {
        setError(`Import failed: ${data.error ?? res.statusText}`);
        track("import_failed", { ms: Date.now() - importStarted });
        return;
      }
      setImportStep(3);
      track("import_done", { ms: Date.now() - importStarted, tickets: result.tickets.length, skipJira });
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
    setDrawerHistory([]);
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
        : `${idea.undoable.jiraKey} goes back to how it was before the sync. Fields edited in Jira since then are left alone.`;
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
    const approving = idea.decision === "pending";
    void callMutate({
      type: "decision",
      ideaId: id,
      decision: approving ? "reviewed" : "pending",
    }).then((ok) => {
      if (ok) setToast(approving ? `Approved “${idea.title}”` : `“${idea.title}” marked unreviewed`);
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
    setDrawerHistory([]);
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
    // Nothing stays highlighted after a save (Daniel, 2026-10-19): the board
    // returns to its plain state, the saved sources speak for themselves.
    setSelectedFinalId(null);
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
    ? "Jira is not connected for your organization"
    : reviewed === 0
      ? pending > 0
        ? `Approve ideas to enable exporting — ${pending} awaiting review`
        : "All changes already synced to Jira"
      : `Sync approved changes to Jira`;

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
    const jiraStatus = jiraStatusOf(i);
    if (jiraStatusFilter.length > 0) {
      const wanted = jiraStatusFilter.map((s) => s.toLowerCase());
      if (!jiraStatus || !wanted.includes(jiraStatus.toLowerCase())) return false;
    } else if (jiraStatus && isJiraDoneStatus(jiraStatus) && i.zen.length === 0) {
      // Shipped in Jira and no ticket asks for it: hidden by default. Once a
      // ticket is matched to it ("already shipped"), the PM wants to see it.
      return false;
    }
    if (pendingOnly && i.decision !== "pending") return false;
    return true;
  };

  const visible = ideas.filter(matches).sort(compareIdeas);

  const drawerIdea = drawerId ? ideas.find((i) => i.id === drawerId) : undefined;

  // ——— Sync-to-Jira modal (scope → preview → execute → results) ———
  // Scope: [] = every product line; SCOPE_NONE = nothing selected (after "Clear").
  const scope = scopeSel.includes(SCOPE_NONE) ? [SCOPE_NONE] : scopeSel.length > 0 ? scopeSel : null;
  const inMergeScope = (i: Idea): boolean =>
    !scope || i.products.some((p) => scope.some((s) => s.toLowerCase() === p.toLowerCase()));
  const scopedPending = approvable.filter(
    (i) => i.decision === "pending" && inMergeScope(i)
  ).length;
  // Archive proposals are never written to Jira, so they don't count as ready.
  const scopedReviewed = live.filter(
    (i) => i.decision === "reviewed" && i.batch !== "archive" && inMergeScope(i)
  ).length;
  // One approved idea is enough to sync — pending ideas never block, they
  // simply stay behind for a later sync.
  const previewDisabled = scopedReviewed === 0;
  /** What each product line has ready: approved ideas (will sync) and pending ones (stay). */
  const productSyncStats = allProducts.map((name) => {
    const has = (i: Idea) => i.products.some((p) => p.toLowerCase() === name.toLowerCase());
    return {
      name,
      approved: live.filter((i) => i.decision === "reviewed" && i.batch !== "archive" && has(i)).length,
      pending: approvable.filter((i) => i.decision === "pending" && has(i)).length,
    };
  });
  const previewHint =
    scopedReviewed === 0
      ? "Nothing approved in the selected product lines"
      : `${scopedReviewed} approved change${scopedReviewed === 1 ? "" : "s"} will sync${
          scopedPending > 0
            ? ` — ${scopedPending} still pending stay${scopedPending === 1 ? "s" : ""} here`
            : ""
        }`;

  const openMerge = () => {
    track("sync_open");
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
        setMergeError(data.error ?? "Sync failed");
        return;
      }
      applyState(data.state as ServerState);
      const results = data.results as PushResult[];
      setPushResults(results);
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      setNote(
        failCount === 0
          ? `${okCount} change${okCount === 1 ? "" : "s"} synced to Jira`
          : `${okCount} synced, ${failCount} failed — reopen Sync to Jira to retry`
      );
    } catch {
      setMergeError("Sync failed — is the dev server running?");
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
    setJiraStatusFilter([]);
    setPendingOnly(false);
  };

  const hasChipRow =
    productFilter.length > 0 ||
    platformFilter.length > 0 ||
    customerFilter.length > 0 ||
    jiraStatusFilter.length > 0 ||
    pendingOnly;

  const hasFilters =
    query !== "" ||
    productFilter.length > 0 ||
    platformFilter.length > 0 ||
    customerFilter.length > 0 ||
    statusFilter.length > 0 ||
    jiraStatusFilter.length > 0 ||
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
  // Busiest product lines: ideas per line, top three.
  const topProducts = (() => {
    const m = new Map<string, number>();
    // "Other" is the unmapped bucket, not a product.
    for (const i of live) for (const p of i.products) if (p !== "Other") m.set(p, (m.get(p) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  })();
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
  const editAdded =
    edit && editedIdea
      ? edit.zen.filter((k) => !editedIdea.zen.includes(k)).length +
        edit.jira.filter((k) => !editedIdea.jira.includes(k)).length
      : 0;
  const editRemoved =
    edit && editedIdea
      ? editedIdea.zen.filter((k) => !edit.zen.includes(k)).length +
        editedIdea.jira.filter((k) => !edit.jira.includes(k)).length
      : 0;

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
  // Long customer names are cut after 26 characters ("Ostara Financial
  // Pension &…"); the full name is the hover hint.
  const CHIP_MAX = 26;
  const shortName = (name: string) =>
    name.length > CHIP_MAX ? `${name.slice(0, CHIP_MAX).trimEnd()}…` : name;
  const customerChip = (c: string) => {
    // Off-catalog names are suggestions awaiting PM review in the drawer —
    // flagged, never hidden.
    const offCatalog = !customerCatalog.some((k) => k.toLowerCase() === c.toLowerCase());
    const cut = shortName(c) !== c;
    return offCatalog ? (
      <Chip
        key={`customer-${c}`}
        kind="suggested"
        title={`${cut ? `${c} — ` : ""}Suggested customer — review in the idea`}
      >
        {shortName(c)} ⚑
      </Chip>
    ) : (
      <Chip
        key={`customer-${c}`}
        kind="customer"
        title={cut ? c : undefined}
        style={chipStyle(colorOf(customerColors, c), CUSTOMER_CHIP_DEFAULT)}
      >
        {shortName(c)}
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
      <div className="relative flex min-w-[132px] flex-[0.55] flex-col gap-0.5 overflow-hidden rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
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
    <>
      {warmEditor && (
        <div
          aria-hidden
          style={{ position: "fixed", left: -10000, top: 0, width: 600, visibility: "hidden", pointerEvents: "none" }}
        >
          <WarmDetailsEditor defaultValue={"## Warm-up\n\n- one\n"} onChange={() => {}} />
        </div>
      )}
    <div className="app-canvas font-title min-h-full">
      <div className="mx-auto w-full max-w-[1680px] px-7 pb-24 pt-6">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />

        {/* Header */}
        <div className="mb-4 flex items-center gap-3.5">
          <div>
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
                  <RefreshCw size={13} strokeWidth={2.25} />
                  Sync to Jira
                </Button>
              </span>
            )}
          </div>
        </div>

        {jiraEnabled && jiraHealth !== "ok" && (
          <div className="mb-4 rounded-inner border border-[#f3dcb0] bg-[#fdf6e7] px-4 py-2.5 text-[13px] text-[#8a5a00]">
            {jiraHealthMessage(jiraHealth)}
          </div>
        )}
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
              <div className="flex flex-1 flex-col gap-1.5 rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
                <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">
                  Requests by Product
                </span>
                {topProducts.length === 0 ? (
                  <span className="text-[12px] text-fg-faint">No product lines yet</span>
                ) : (
                  topProducts.map(([name, n]) => {
                    const c = chipStyle(colorOf(productColors, name), PRODUCT_CHIP_DEFAULT);
                    return (
                      <span key={name} className="flex items-center gap-2 text-[12px]">
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px]"
                          style={{ background: c.background }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-fg-2" title={shortName(name) !== name ? name : undefined}>
                          {shortName(name)}
                        </span>
                        <span className="inline-flex h-1 w-[54px] overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]">
                          <span
                            className="block h-full bg-primary"
                            style={{ width: `${Math.round((n / topProducts[0][1]) * 100)}%` }}
                          />
                        </span>
                        <span className="w-4 text-right font-mono text-[10.5px] text-fg-muted">{n}</span>
                      </span>
                    );
                  })
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1.5 rounded-inner border border-border bg-[rgba(255,255,255,.72)] px-3.5 pb-2.5 pt-3">
                <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">
                  Requests by Customer
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
                      <span className="min-w-0 flex-1 truncate text-fg-2" title={shortName(name) !== name ? name : undefined}>
                        {shortName(name)}
                      </span>
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
                    placeholder={edit ? "Search tickets and Jira issues…" : "Search ideas…"}
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
                {jiraStatuses.length > 0 && (
                  <FilterPopover
                    label="Jira Status"
                    accent="status"
                    options={jiraStatuses}
                    selected={jiraStatusFilter}
                    onToggle={(o) =>
                      setJiraStatusFilter((prev) =>
                        prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]
                      )
                    }
                    emptyText="No matching Jira status"
                  />
                )}
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
                  {/* A PM writes an idea from scratch — next to the review controls. */}
                  {page === "final" && (
                    <Button size="sm" onClick={() => setNewIdeaOpen(true)} disabled={importing}>
                      <Plus size={13} strokeWidth={2.25} />
                      New idea
                    </Button>
                  )}
                  {/* Approve all while anything is pending; Undo while anything is
                      approved — both when the batch is mixed (e.g. ideas skipped for
                      an open suggestion), so an approve is always reversible. */}
                  {page === "final" && (pending > 0 || reviewed > 0) && (
                    <span className="inline-flex items-center gap-1">
                      {pending > 0 ? (
                        <span title={`${pending} awaiting review`}>
                          <Button
                            size="sm"
                            onClick={() => {
                              setNote("");
                              void callMutate({ type: "approveAll", revert: false });
                            }}
                          >
                            <CheckCheck size={13} strokeWidth={2.25} />
                            Approve all
                          </Button>
                        </span>
                      ) : (
                        <span title="Every idea is approved — back to pending">
                          <Button
                            size="sm"
                            onClick={() => {
                              setNote("");
                              void callMutate({ type: "approveAll", revert: true });
                            }}
                          >
                            <Undo2 size={13} strokeWidth={2.25} />
                            Undo approve all
                          </Button>
                        </span>
                      )}
                      {/* Mixed batch: a compact undo next to Approve all, no second line. */}
                      {pending > 0 && reviewed > 0 && (
                        <button
                          type="button"
                          title={`Undo: ${reviewed} approved back to pending`}
                          aria-label="Undo approve all"
                          onClick={() => {
                            setNote("");
                            void callMutate({ type: "approveAll", revert: true });
                          }}
                          className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-control border border-border bg-[var(--app-glass)] text-fg-2 shadow-sm hover:border-primary/60 hover:bg-white"
                        >
                          <Undo2 size={13} strokeWidth={2.25} />
                        </button>
                      )}
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
                  {jiraStatusFilter.map((option) => (
                    <button
                      key={`js-${option}`}
                      onClick={() => setJiraStatusFilter((prev) => prev.filter((x) => x !== option))}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-mono text-[11px] font-semibold text-white ${FILTER_ACCENTS.status.chip}`}
                    >
                      Jira: {option} ✕
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
                  // Two states the PM can tell apart at a glance: untouched
                  // (neutral, nothing to save) and changed (green, with the
                  // delta — ✓ saves, ✕ / Esc discards).
                  <div
                    className={`flex items-center gap-2.5 rounded-inner border px-3.5 py-2.5 text-[13px] ${
                      editDirty
                        ? "border-[rgba(23,178,106,.35)] bg-[rgba(23,178,106,.12)] text-[#0f7a47]"
                        : "border-border bg-[var(--app-glass)] text-fg-2"
                    }`}
                  >
                    <Share2 size={15} strokeWidth={2.25} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {editDirty ? (
                        <>
                          <b className="font-semibold">
                            {editAdded > 0 ? `Added ${editAdded} source${editAdded === 1 ? "" : "s"}` : ""}
                            {editAdded > 0 && editRemoved > 0 ? ", " : ""}
                            {editRemoved > 0
                              ? `${editAdded > 0 ? "removed" : "Removed"} ${editRemoved} source${editRemoved === 1 ? "" : "s"}`
                              : ""}
                          </b>
                          . ✓ saves, ✕ or Esc discards.
                        </>
                      ) : (
                        <>
                          <b className="font-semibold">No changes</b>. Tick a Zendesk or Jira row to add it,
                          untick to remove.
                        </>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-fg-3">
                    <Share2 size={14} className="text-primary" />
                    Click an idea src chip to edit its sources
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
                    setDrawerHistory([]);
                    setDrawerId(id);
                    setDrawerSrc(null);
                  }}
                  onOpenSource={(kind, key) => {
                    track("source_open", { kind, from: "merge" });
                    setDrawerHistory([]);
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
                            idea.decision === "pending" &&
                            (unresolvedSuggested(idea).length > 0 || !!idea.sourcesChanged);
                          const firstTicket = idea.zen[0] ? ticketsByKey.get(idea.zen[0]) : undefined;
                          const customers = idea.customers ?? [];
                          return (
                            <div
                              key={idea.id}
                              onClick={() => {
                                track("drawer_open", { from: "final", ideaId: idea.id });
                                setDrawerHistory([]);
                                setDrawerId(idea.id);
                              }}
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
                                      ? idea.sourcesChanged
                                        ? "Sources changed — rewrite or keep the text first"
                                        : "Approve or dismiss the suggested customers first"
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
                                      {zenLabel(firstTicket.id)}
                                      {idea.zen.length > 1 ? ` +${idea.zen.length - 1}` : ""}
                                    </span>
                                  ) : null}
                                  {idea.jira[0] && (
                                    <span className="shrink-0 font-mono font-semibold text-[#2a5fd0]">
                                      {idea.jira[0]}
                                    </span>
                                  )}
                                  {jiraStatusOf(idea) && (
                                    <span
                                      className="shrink-0 rounded bg-[#eef3fb] px-1.5 py-px text-[10.5px] font-medium text-[#2a5fd0]"
                                      title="Status in Jira"
                                    >
                                      {jiraStatusOf(idea)}
                                    </span>
                                  )}
                                  {(firstTicket || idea.jira[0]) && <span>·</span>}
                                  {idea.sourcesChanged && (
                                    <span
                                      title="Sources changed by a PM — rewrite or keep the text before approving"
                                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--app-warn)] bg-[var(--app-warn-bg)] px-[6px] py-px font-mono text-[9.5px] font-semibold text-[var(--app-warn-fg)]"
                                    >
                                      <Flag size={9} /> sources changed
                                    </span>
                                  )}
                                  {idea.products.slice(1).map((p) => productChip(p))}
                                  {(idea.platforms ?? []).map((p) => (
                                    <Chip key={`platform-${p}`} kind="platform">
                                      {p}
                                    </Chip>
                                  ))}
                                  {customers.slice(0, 2).map(customerChip)}
                                  {customers.length > 2 && (
                                    <span className="shrink-0">+{customers.length - 2}</span>
                                  )}
                                </span>
                              </div>
                              {/* Reporters — who filed the supporting tickets */}
                              <span
                                className="flex w-[84px] shrink-0 items-center justify-end"
                                title={
                                  (idea.reporters ?? []).length > 0
                                    ? `Reported by ${(idea.reporters ?? []).join(", ")}`
                                    : undefined
                                }
                              >
                                {(idea.reporters ?? []).slice(0, 3).map((r, k) => {
                                  const c = paletteColorFor(r);
                                  return (
                                    <Avatar
                                      key={r}
                                      name={r}
                                      size={26}
                                      className={k ? "-ml-2" : ""}
                                      style={{ background: c.bg, color: c.fg }}
                                    />
                                  );
                                })}
                                {(idea.reporters ?? []).length > 3 && (
                                  <span className="ml-1 text-[11px] text-fg-muted">
                                    +{(idea.reporters ?? []).length - 3}
                                  </span>
                                )}
                              </span>
                              {/* Votes — the "+N" jumps to the Merge page with this idea selected */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (idea.newVotes > 0) gotoMerge(idea.id);
                                }}
                                title={idea.newVotes > 0 ? "Show merge sources" : undefined}
                                className={`flex w-[72px] shrink-0 items-center justify-center rounded-control border border-transparent px-1.5 py-1 ${
                                  idea.newVotes > 0
                                    ? "cursor-pointer hover:border-border hover:bg-white"
                                    : "cursor-default"
                                }`}
                              >
                                {votesOf(idea)}
                              </button>
                              {/* Votes sit centred in a fixed box, so the gap to the reporters on
                                  the left equals the gap to the status pill on the right. */}
                              <span className="flex w-[84px] shrink-0 justify-start">
                                {badge && (
                                  <Pill
                                    badge={badge}
                                    title={undefined}
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
          jiraProductLineLabel={jiraProductLineField}
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
          onRewrite={
            drawerIdea
              ? () =>
                  withAiWait(drawerIdea.title, "Rewriting the idea from its current sources", () =>
                    callMutate({ type: "rewrite", ideaId: drawerIdea.id }),
                  )
              : undefined
          }
          onKeepText={drawerIdea ? () => callMutate({ type: "keepText", ideaId: drawerIdea.id }) : undefined}
          syncPreview={
            drawerIdea && drawerIdea.jira.length > 0 && jiraConnected
              ? previews[drawerIdea.id] ?? "loading"
              : null
          }
          onCreateIdeaFromTicket={(ticketKey) =>
            withAiWait(
              ticketsByKey.get(ticketKey)?.subject ?? ticketKey,
              "Reading the ticket and writing an idea",
              () => callMutate({ type: "createIdeaFromTicket", ticketKey }),
            )
          }
        />
      )}

      {newIdeaOpen && (
        <NewIdeaDrawer
          catalogProducts={catalogProducts}
          catalogPlatforms={catalogPlatforms}
          customerCatalog={customerCatalog}
          productColors={productColors}
          customerColors={customerColors}
          // Tickets that back no live idea — orphans on the merge board and
          // parked ones — are the only sources a hand-written idea can take.
          freeTickets={tickets.filter((t) => !ideas.some((i) => i.batch !== "deleted" && i.zen.includes(t.key)))}
          freeJira={jiraSources.filter((s) => !ideas.some((i) => i.batch !== "deleted" && i.jira.includes(s.key)))}
          onClose={() => setNewIdeaOpen(false)}
          onCreate={async (draft) => {
            const ok = await callMutate({ type: "createIdea", ...draft });
            if (ok) setNewIdeaOpen(false);
            return ok;
          }}
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

      {/* PMOS AI wait (rewrite / create from ticket) — blocks the page until the call returns. */}
      {aiWait && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]">
          <div className="glass-strong flex w-[440px] max-w-full flex-col gap-5 overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]">
            <div className="h-[3px] bg-[linear-gradient(90deg,var(--app-accent),#17b26a)]" />
            <div className="flex flex-col gap-4 px-6 pb-6">
              <div>
                <div className="eyebrow mb-1.5 inline-flex items-center gap-1.5 text-primary">
                  <PmosMark size={18} />
                  PMOS AI
                </div>
                <div className="font-title text-[20px] font-bold">{aiWait.what}…</div>
                <div className="mt-1 truncate text-[13px] text-fg-3" title={aiWait.title}>
                  {aiWait.title}
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-control bg-[var(--app-accent-soft)] px-3 py-2.5 text-[13px] text-foreground">
                <span className="h-[18px] w-[18px] shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                One call — usually a few seconds.
              </div>
            </div>
          </div>
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
                          {step.pmos && <PmosMark size={21} />}
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

      {/* Sync-to-Jira modal: scope → preview → execute → results */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]"
          onClick={closeMerge}
        >
          <div
            className="glass-strong flex max-h-[calc(100vh-80px)] w-[880px] max-w-full flex-col overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-[3px] bg-[linear-gradient(90deg,var(--app-accent),#17b26a)]" />
            {pushResults ? (
              <>
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-[26px] pb-5 pt-[22px]">
                  <div>
                    <div className="eyebrow mb-1.5 text-primary">Sync to Jira · Result</div>
                    <h2 className="font-title m-0 text-[22px] font-bold">
                      {pushResults.every((r) => r.ok) ? "Synced to Jira" : "Sync finished with errors"}
                    </h2>
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-fg-3">
                      {pushResults.filter((r) => r.ok).length} of {pushResults.length} change
                      {pushResults.length === 1 ? "" : "s"} written.
                      {pushResults.some((r) => !r.ok) &&
                        " Failed ideas stay approved — Retry writes just those."}
                    </p>
                  </div>
                  <div className="flex min-h-0 flex-col overflow-y-auto rounded-inner border border-border">
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
                        {r.jiraKey && (r.url || jiraSiteUrl) && (
                          <a
                            href={r.url ?? `${jiraSiteUrl}/browse/${r.jiraKey}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open in Jira"
                            className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                          >
                            {r.jiraKey}
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-border bg-[rgba(247,250,253,.8)] px-[26px] py-3.5">
                  {pushResults.some((r) => !r.ok) && (
                    <Button disabled={pushing} onClick={runPush}>
                      <RefreshCw size={13} strokeWidth={2.25} />
                      {pushing
                        ? "Retrying…"
                        : `Retry failed (${pushResults.filter((r) => !r.ok).length})`}
                    </Button>
                  )}
                  <Button variant="primary" glow onClick={closeMerge}>
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-[26px] pb-5 pt-[22px]">
                  <div>
                    <div className="eyebrow mb-1.5 text-primary">
                      {plan ? "Sync to Jira · Preview" : "Zendesk → Jira"}
                    </div>
                    <h2 className="font-title m-0 text-[22px] font-bold">Sync to Jira</h2>
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-fg-3">
                      Pick the product lines to sync. Only approved ideas are written — anything
                      still pending stays here for a later sync.
                    </p>
                  </div>

                  {/* Scope: product lines with something approved, then the ones with nothing */}
                  {(() => {
                    const ready = productSyncStats.filter((r) => r.approved > 0);
                    const idle = productSyncStats.filter((r) => r.approved === 0);
                    const allSelected =
                      !scopeSel.includes(SCOPE_NONE) &&
                      (scopeSel.length === 0 ||
                        (ready.length > 0 && ready.every((r) => scopeSel.includes(r.name))));
                    const row = (r: (typeof productSyncStats)[number], disabled: boolean) => {
                      const on = !disabled && (scopeSel.length === 0 || scopeSel.includes(r.name));
                      return (
                        <button
                          key={r.name}
                          disabled={disabled}
                          onClick={() => {
                            // Explicit picks: "all" (empty scope) becomes the full ready list minus this one.
                            setPlan(null);
                            setMergeError("");
                            setScopeSel((prev) => {
                              const picked = prev.filter((x) => x !== SCOPE_NONE);
                              const base = prev.length === 0 ? ready.map((x) => x.name) : picked;
                              const next = base.includes(r.name) ? base.filter((x) => x !== r.name) : [...base, r.name];
                              return next.length === 0 ? [SCOPE_NONE] : next;
                            });
                          }}
                          className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-[rgba(247,250,253,.9)] disabled:cursor-default disabled:hover:bg-transparent ${
                            on ? "bg-[var(--app-accent-soft)]" : ""
                          }`}
                        >
                          {!disabled && (
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                on ? "border-primary bg-primary text-white" : "border-border bg-white"
                              }`}
                            >
                              {on && <Check size={11} strokeWidth={3} />}
                            </span>
                          )}
                          <span className={`flex-1 ${disabled ? "opacity-50" : ""}`}>{productChip(r.name)}</span>
                          <span className="font-mono text-[11px] text-fg-muted">
                            {disabled
                              ? r.pending > 0
                                ? `${r.pending} pending`
                                : "no changes"
                              : `${r.approved} approved${r.pending > 0 ? ` · ${r.pending} pending` : ""}`}
                          </span>
                        </button>
                      );
                    };
                    return (
                      <div className="overflow-hidden rounded-inner border border-border">
                        <div className="flex items-center justify-between bg-[rgba(247,250,253,.9)] px-3 py-1.5">
                          <span className="eyebrow text-[10px] text-fg-muted">
                            Ready to sync · {ready.length}
                          </span>
                          {ready.length > 1 && (
                            <button
                              onClick={() => {
                                setPlan(null);
                                setMergeError("");
                                setScopeSel(allSelected ? [SCOPE_NONE] : []);
                              }}
                              className="text-[11.5px] font-semibold text-primary hover:underline"
                            >
                              {allSelected ? "Clear" : "Select all"}
                            </button>
                          )}
                        </div>
                          {ready.length === 0 && (
                            <div className="px-3 py-2 text-[12.5px] text-fg-muted">
                              Nothing approved yet.
                            </div>
                          )}
                          {ready.map((r) => row(r, false))}
                        {idle.length > 0 && (
                          <>
                            <div className="flex items-center justify-between border-t border-border bg-[rgba(247,250,253,.9)] px-3 py-1.5">
                              <span className="eyebrow text-[10px] text-fg-muted">
                                Nothing to sync · {idle.length}
                              </span>
                            </div>
                            {idle.map((r) => row(r, true))}
                          </>
                        )}
                      </div>
                    );
                  })()}
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
                              {item.action === "create" || !item.jiraKey ? (
                                <span className="shrink-0 font-mono text-[10.5px] text-fg-muted">→ new issue</span>
                              ) : (
                                <a
                                  href={item.url ?? `${jiraSiteUrl ?? ""}/browse/${item.jiraKey}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  title="Open in Jira"
                                  className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-primary hover:underline"
                                >
                                  {item.jiraKey}
                                  <ExternalLink size={10} />
                                </a>
                              )}
                            </div>
                            <span className="pl-[66px] text-[11.5px] text-fg-muted">
                              {item.noop
                                ? "Already up to date in Jira — will be marked merged"
                                : item.changes.map((c) => c.label).join(", ")}
                              {item.votes > 0 ? ` · ${item.votes} vote${item.votes === 1 ? "" : "s"}` : ""}
                            </span>
                          </div>
                        ))}
                        {plan.notes.map((n) => (
                          <div
                            key={n}
                            className="border-t border-hairline bg-[rgba(59,124,246,.06)] px-3 py-2 text-[12.5px] text-[#2a5fd0]"
                          >
                            {n}
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
                      <RefreshCw size={13} strokeWidth={2.25} />
                      {pushing ? "Syncing…" : `Confirm sync (${plan.items.length})`}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
