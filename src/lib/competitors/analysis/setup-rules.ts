import { emptyCounters, readCounters, sumCounters, type Counters } from "./counters";

/**
 * The rules of THE SETUP RUN — the first run of an organization (Capability Analysis, "The setup run").
 *
 * Domains used to be typed in by hand before anything was known, and a new domain was suggested for one capability
 * at a time. An organization's first run is different: it has no domain and no capability, and it produces both —
 * from its own site and its competitors' sites together. This file holds what can be decided without a database:
 * when a workspace counts as set up, why a setup run is refused, the order of the companies, and the shape of the
 * progress the run records. The database side is analysis/setup.ts.
 *
 * Pure: no database, no network.
 */

// ————— "Set up" —————

/**
 * - not_set_up: the workspace has NO domain and NO capability, in any state, and no setup run is on its way.
 * - in_setup:   a setup run exists and did not finish (queued, running, waiting, failed, cancelled). The catalog may
 *               be half built; the same run is continued from the CLI.
 * - set_up:     everything else — a catalog exists (typed by hand, or built by a setup run that finished).
 *
 * There is no built-in "No Domain" row in PM-OS: a workspace with no domain has no CompetitorDomain row at all, so
 * the count is exact. A domain or capability a PM removed still counts (state any): the team has worked on a catalog.
 */
export type SetupState = "not_set_up" | "in_setup" | "set_up";

export interface SetupFacts {
  /** CompetitorDomain rows of the workspace, any state. */
  domains: number;
  /** Capability rows of the workspace, any state. */
  capabilities: number;
  /** The status of the workspace's latest setup run; null = it never had one. */
  lastSetupStatus: string | null;
}

export function setupStateOf(f: SetupFacts): SetupState {
  if (f.lastSetupStatus != null && f.lastSetupStatus !== "done") return "in_setup";
  return f.domains + f.capabilities > 0 ? "set_up" : "not_set_up";
}

/**
 * May an analysis run create rows and fill cells? Only in a workspace that is set up. Anywhere else a run does the
 * map, the research and the clean-up (merge) and stops: nothing lands in a catalog that has no domains.
 */
export function analysisFillsTable(state: SetupState): boolean {
  return state === "set_up";
}

// ————— Refusals —————

export type SetupRefusal = "set_up" | "active" | "no_own_source" | "scan_active" | "no_pages";

export interface SetupRequest extends SetupFacts {
  /** The workspace has an own source (own.ts) that was not removed. */
  hasOwnSource: boolean;
  /** Scans of the own source or of any competitor of the workspace that are queued, running or pending — with the company's name. */
  activeScans: Array<{ company: string; status: string }>;
  /** Competitors (never the own source) that have at least one stored page that is there. */
  competitorsWithPages: number;
}

/**
 * Why a setup run is refused — nothing is written — or null: it may be queued. In this order:
 *   1. a setup run of the workspace is queued or in progress;
 *   2. the workspace is already set up;
 *   3. it has no own source;
 *   4. a scan of the own source or of a competitor is still queued, running or pending;
 *   5. no competitor has stored pages.
 * A setup run that failed or was cancelled is not a refusal: it is continued (see setupStateOf "in_setup").
 */
export function setupRefusal(r: SetupRequest): { reason: SetupRefusal; message: string } | null {
  if (r.lastSetupStatus === "queued" || r.lastSetupStatus === "running" || r.lastSetupStatus === "waiting") {
    return { reason: "active", message: `a setup run of this organization is already ${r.lastSetupStatus === "queued" ? "queued" : "in progress"}` };
  }
  if (setupStateOf(r) === "set_up") {
    return { reason: "set_up", message: `this organization is already set up (${r.domains} domain${r.domains === 1 ? "" : "s"}, ${r.capabilities} capabilit${r.capabilities === 1 ? "y" : "ies"}) — the setup run is the first run only` };
  }
  if (!r.hasOwnSource) return { reason: "no_own_source", message: "this organization has no own site yet — add it first: --own-site <workspaceId> <url>" };
  if (r.activeScans.length) {
    const names = r.activeScans.slice(0, 5).map((s) => `${s.company} (${s.status.replace("_", " ")})`).join(", ");
    return { reason: "scan_active", message: `${r.activeScans.length} scan${r.activeScans.length === 1 ? " is" : "s are"} still queued, running or pending: ${names}${r.activeScans.length > 5 ? ", …" : ""} — run the setup when they have ended` };
  }
  if (r.competitorsWithPages === 0) return { reason: "no_pages", message: "no competitor of this organization has stored pages — scan at least one competitor first" };
  return null;
}

// ————— The companies of a setup run —————

export interface SetupCompany {
  id: string;
  name: string;
  host: string;
  websiteUrl: string;
  isOwn: boolean;
  position: number;
  /** Stored pages that are there (state not "removed"). */
  pages: number;
}

/**
 * The fixed order of a setup run: the own source first, then the competitors by position, then by name, then by id.
 * Everything that depends on an order — the unify batches, the row codes, the order of the rows in the table —
 * follows from it, so the result does not depend on chance.
 */
export function orderCompanies<T extends Pick<SetupCompany, "id" | "name" | "isOwn" | "position">>(companies: T[]): T[] {
  return [...companies].sort(
    (a, b) => Number(b.isOwn) - Number(a.isOwn) || a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The companies a setup run works on: the own source always (its product lines are material even when its site has
 * no stored page), and every competitor that has stored pages. A competitor with no stored page was never scanned:
 * it gets no cell from the setup run — its first scan queues an ordinary analysis.
 */
export function companiesInSetup<T extends SetupCompany>(companies: T[]): { work: T[]; skipped: T[] } {
  const ordered = orderCompanies(companies);
  return { work: ordered.filter((c) => c.isOwn || c.pages > 0), skipped: ordered.filter((c) => !c.isOwn && c.pages === 0) };
}

// ————— Progress (CompetitorAnalysis.setup) —————

/** Where one company is in the setup run. */
export type SetupStage = "waiting" | "map" | "research" | "merge" | "unify" | "match" | "second_look" | "apply" | "facts" | "done";

export interface SetupCompanyProgress {
  competitorId: string;
  name: string;
  own: boolean;
  stage: SetupStage;
  pagesTotal: number;
  pagesDone: number;
  /** When its cells were filled (ISO); null before. */
  appliedAt: string | null;
  counters: Counters;
}

export interface SetupProgress {
  companies: SetupCompanyProgress[];
  /** The calls that belong to no company: unify, domains. */
  shared: Counters;
  /** What the run made: capability rows, domains, feature rows. */
  rows: number;
  domains: number;
  features: number;
}

export function emptySetupProgress(): SetupProgress {
  return { companies: [], shared: emptyCounters(), rows: 0, domains: 0, features: 0 };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const STAGES: readonly string[] = ["waiting", "map", "research", "merge", "unify", "match", "second_look", "apply", "facts", "done"];

/** The stored progress (a Json column), checked field by field: anything that is not progress reads as empty. */
export function readSetupProgress(raw: unknown): SetupProgress {
  const out = emptySetupProgress();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.shared = readCounters(r.shared);
  out.rows = num(r.rows);
  out.domains = num(r.domains);
  out.features = num(r.features);
  for (const c of Array.isArray(r.companies) ? r.companies : []) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.competitorId !== "string" || !o.competitorId) continue;
    out.companies.push({
      competitorId: o.competitorId,
      name: typeof o.name === "string" ? o.name : "",
      own: o.own === true,
      stage: (typeof o.stage === "string" && STAGES.includes(o.stage) ? o.stage : "waiting") as SetupStage,
      pagesTotal: num(o.pagesTotal),
      pagesDone: num(o.pagesDone),
      appliedAt: typeof o.appliedAt === "string" ? o.appliedAt : null,
      counters: readCounters(o.counters),
    });
  }
  return out;
}

/** The run's own counters and page progress: the sum of its companies and of the shared calls. */
export function setupTotals(p: SetupProgress): { counters: Counters; pagesTotal: number; pagesDone: number } {
  return {
    counters: sumCounters([...p.companies.map((c) => c.counters), p.shared]),
    pagesTotal: p.companies.reduce((n, c) => n + c.pagesTotal, 0),
    pagesDone: p.companies.reduce((n, c) => n + c.pagesDone, 0),
  };
}
