/**
 * Competitors settings per workspace (Workspace.competitorsConfig), merged
 * over these defaults. Pure data — safe for client components.
 */

/**
 * Per-workspace settings (Workspace.competitorsConfig). Since the Website
 * Scanning PRD (2026-11-04) the scan frequency lives per source
 * (CompetitorSource.scanEveryDays, Administration) and there is no page cap;
 * what remains here is the news baseline (the daily manual-scan limit was
 * removed, Daniel 2026-11-12; the Scan-run email and its recipients list,
 * notifyUserIds, were removed 2026-11-22 — a stored value is ignored).
 */
/** Scan frequency per source, in days (PRD: once every 2 days). */
export const DEFAULT_SCAN_EVERY_DAYS = 2;
export const MIN_SCAN_EVERY_DAYS = 1;
export const MAX_SCAN_EVERY_DAYS = 90;

export interface CompetitorsConfig {
  /** News feed baseline: what scans found before this moment is history, not news (ISO, null = everything is news). */
  baselineUntil: string | null;
  // Three older analysis settings are gone and a stored value of them is ignored: readWeakPages (whether blog and
  // news are read is the installation's setting "What the analysis reads" now — analysis/reads.ts, one source of
  // truth), minPagesForNewRow (an item of a company's list has one proof) and secondLooksPerRun (the second look asks
  // about all rows at once, per chunk). notifyUserIds (the recipients of the removed Scan-run email) is ignored too.
}

export const DEFAULT_COMPETITORS_CONFIG: CompetitorsConfig = {
  baselineUntil: null,
};

// ————— Scanner rules (Website Scanning PRD, 2026-11-04) —————
/** Pause between two requests to the same site (remote lane). Tests may set COMPETITORS_PAUSE_MS=0 (with COMPETITORS_TEST_KNOBS=on) and say so. */
export function scanPauseMs(): number {
  if (!knobsOn()) return 2000;
  const v = Number(process.env.COMPETITORS_PAUSE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
}
/** Same switch as settings.ts testKnobsEnabled (kept here so this module stays pure data + env). */
function knobsOn(): boolean {
  const v = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}
/** robots.txt Crawl-delay is honoured up to this (remote lane). */
export const CRAWL_DELAY_CAP_MS = 10_000;
/**
 * Safety limits (Daniel 2026-11-09: no page limit — a site is read whole). A scan stops after this long;
 * pages beyond are "not attempted" and the next run picks them up.
 */
export const CEILING_MS = 8 * 3600_000;
/**
 * PM-OS stores at most this much competitor page text, all organizations together (counted in characters of
 * stored text — text only for now; revisit when more than text is stored). A scan that would pass it stops
 * with the reason "storage limit"; support raises it.
 */
export const STORAGE_LIMIT_CHARS = 10 * 1024 * 1024 * 1024;
/** Test knob only (COMPETITORS_TEST_KNOBS=on): COMPETITORS_CEILING_MS lowers the time limit for the whole run. */
export function ceilingMsFromEnv(): number {
  if (!knobsOn()) return CEILING_MS;
  const ms = Number(process.env.COMPETITORS_CEILING_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : CEILING_MS;
}
/** A scan that stopped reporting for this long is stale; the next run resumes its pending pages. */
export const STALE_MS = 10 * 60_000;
/** A handed-in local scan whose processing stops reporting is processed again this many times, then failed (the station is never sent back). */
export const MAX_PROCESS_ATTEMPTS = 3;
/** Scans heartbeat this often. */
export const HEARTBEAT_MS = 30_000;
/** Remote scans in progress at once, all workspaces (global). */
export const MAX_PARALLEL_REMOTE = 8;
/** A local-scan request older than this emails support@pm-os.io once and keeps waiting. */
export const LOCAL_ALERT_MS = 24 * 3600_000;
/** The station checks in every 15 minutes: no check-in for this long (and no scan being read) means it is off. */
export const STATION_ONLINE_MS = 20 * 60_000;
/** The "station is off" email goes out when a scan starts, at most once per this long. */
export const STATION_OFF_ALERT_EVERY_MS = 3600_000;
/** A scan token stays valid this long after its scan reached a final state. */
export const SCAN_TOKEN_GRACE_MS = 15 * 60_000;
/** The poller rotates its machine key this often (no expiry; rotation is automatic). */
export const KEY_ROTATE_DAYS = 30;
/** After a rotation the previous key still works for this long (a poller mid-rotation). */
export const KEY_ROTATION_GRACE_MS = 10 * 60_000;
/** A page is "removed" after this many consecutive not-found answers. */
export const REMOVED_AFTER_NOT_FOUND = 2;
/** Retries of a page that failed with a retryable error within one scan. */
export const PAGE_RETRIES = 2;
/** A fact not seen for this many scans of its site is stale (analysis story; here only the page states feed it). */
export const STALE_AFTER_SCANS = 3;
/** Why a page was not read — shown to users as counts. */
export const OUTCOME_CATEGORIES = ["robots", "denied", "login", "notfound", "timeout", "cap", "slowdown", "storage", "unreadable"] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];
/** What the user sees per competitor after a scan. */
export const SCAN_BADGES = ["full", "incomplete", "blocked", "unreachable", "stale"] as const;
export type ScanBadge = (typeof SCAN_BADGES)[number];
/** Scan row states. */
export const SCAN_STATUSES = ["queued", "pending_local", "running", "ok", "partial", "failed", "stale", "cancelled"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
/** States a scan can still move out of on its own. */
export const ACTIVE_SCAN_STATUSES: readonly ScanStatus[] = ["queued", "pending_local", "running"];
/** States of one page of a source. */
export const PAGE_STATES = ["present", "missing", "removed", "unlinked"] as const;
export type PageState = (typeof PAGE_STATES)[number];
/** An analysis run that is still to come or in progress (analysis/engine.ts). */
export function isAnalysisActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}
/**
 * Has a finished Scan run settled — is everything it started over? Not while one of its scans is still to be read (in
 * the local lane a scan is parked and the run itself ends at once; its pages arrive when the station reads the site),
 * and not while an analysis one of its scans queued is still to finish. The Competitors page says "Scan finished" then.
 */
export function runSettled(r: { runStatus: string; scanStatuses: string[]; analysesUnfinished: number }): boolean {
  if (r.runStatus === "running") return false;
  if (r.scanStatuses.some((s) => s === "queued" || s === "pending_local" || s === "running")) return false;
  return r.analysesUnfinished === 0;
}
/** Where pages came from. */
export const SCAN_LANES = ["remote", "local", "bundle"] as const;
export type ScanLane = (typeof SCAN_LANES)[number];

export function mergeCompetitorsConfig(raw: unknown): CompetitorsConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    baselineUntil: typeof r.baselineUntil === "string" && !Number.isNaN(Date.parse(r.baselineUntil)) ? r.baselineUntil : null,
  };
}

/** A domain's PMOS AI definition text (definition, belongs here, not here, typical phrases). */
export const MAX_DOMAIN_DESCRIPTION = 6000;
/** A domain's plain summary for people (tooltip, deep dive). */
export const MAX_DOMAIN_SUMMARY = 600;
/** Who does a domain's work (roles and teams): the "Show more" line of the domain's info card. */
export const MAX_DOMAIN_DONE_BY = 300;
/** A capability's plain description (row tooltip; also in the scan prompt). */
export const MAX_CAPABILITY_DESCRIPTION = 500;
/** The text PMOS AI uses for a capability, when it is not the same as its description. */
export const MAX_CAPABILITY_AI_DEFINITION = 2000;

/** The org's own cell on a capability — set by PMs, never scanned. */
export const OWN_STATUS_VALUES = ["found", "not_found"] as const;
export type OwnStatus = (typeof OWN_STATUS_VALUES)[number];
export function isOwnStatus(v: unknown): v is OwnStatus {
  return typeof v === "string" && (OWN_STATUS_VALUES as readonly string[]).includes(v);
}

/**
 * Matrix cell values. Decided by fixed rules from the evidence (analysis/cells.ts), never by a model:
 * found = evidence on a strong page; low = evidence on weak pages only (blog, news, press); not_found = none.
 */
export const STATUS_VALUES = ["found", "low", "not_found"] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];
export function isStatusValue(v: unknown): v is StatusValue {
  return typeof v === "string" && (STATUS_VALUES as readonly string[]).includes(v);
}

/**
 * Profile fact kinds — a closed list. The first block is read off product
 * pages (story 2); the second is company facts from about/press/jobs pages,
 * each with the date the source states when it states one (the timeline).
 */
export const FACT_KINDS = [
  "tagline",
  "product",
  "pricingTier",
  "integration",
  "certification",
  "customer",
  "vertical",
  "funding",
  "headcount",
  "hiring",
  "ownership",
  "hq",
  "founded",
  "milestone",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export function isFactKind(v: unknown): v is FactKind {
  return typeof v === "string" && (FACT_KINDS as readonly string[]).includes(v);
}

/**
 * Where a competitor's pages come from. The website is crawled by the
 * scanner, and so are the company's other addresses (ADDRESS_KINDS below: a
 * help center, developer docs, release notes — several of one type are
 * possible). Every other type gets its pages from a collector (an import, an
 * upload, a later connector) and runs the same pipeline.
 */
export const SOURCE_TYPES = [
  "website",
  "documents",
  "helpcenter",
  "video",
  "archive",
  "apidocs",
  "changelog",
  "blog",
  "code",
  "social",
  "reviews",
  "marketplaces",
  "press",
  "jobs",
  "events",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export function isSourceType(v: unknown): v is SourceType {
  return typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * The kinds of OTHER ADDRESS of a company: the source types that — like the website — are an address the scanner
 * crawls (lib/competitors/addresses.ts). A company's help center, developer docs and release notes usually sit on
 * another address than its main site; each such address is a source of one of these types.
 */
export const ADDRESS_KINDS = ["helpcenter", "apidocs", "changelog"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];
export function isAddressKind(v: unknown): v is AddressKind {
  return typeof v === "string" && (ADDRESS_KINDS as readonly string[]).includes(v);
}

/** What a stored page text is. */
export const PAGE_KINDS = ["page", "document", "article", "transcript", "capture", "quotes"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}

/**
 * Limits of a collector bundle uploaded as one zip (Admin → Competitors →
 * Import pages; read by lib/competitors/bundle-zip.ts, checked on the screen
 * before the upload starts).
 *
 * The largest zip accepted: production serves the app from Cloud Run, which
 * refuses a request over 32 MB before it reaches the app; this leaves room
 * for the form around the file. next.config.ts (proxyClientMaxBodySize) lets
 * a body of this size through the proxy whole.
 */
export const MAX_ZIP_BYTES = 30 * 1024 * 1024;
/** The largest total size of a zip's files once unpacked, as the zip states it. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** The most entries (files and folders) a zip may hold. */
export const MAX_ZIP_ENTRIES = 5_000;

/**
 * Manual import of pages (Admin → Competitors → Import pages, its route, and
 * the command line `--import`). OFF: it requires testing (Daniel 2026-11-12).
 * A constant on purpose — no setting, environment variable or admin switch
 * turns it on; it is switched on in code once it has been tested.
 */
export const MANUAL_IMPORT_ENABLED: boolean = false;
export const MANUAL_IMPORT_OFF_NOTE = "Manual import is off. It requires testing.";
