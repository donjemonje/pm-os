/**
 * Competitors settings per workspace (Workspace.competitorsConfig), merged
 * over these defaults. Pure data — safe for client components.
 */

export const SCAN_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ScanFrequency = (typeof SCAN_FREQUENCIES)[number];

export const DEFAULT_MAX_PAGES = 50;
export const MIN_MAX_PAGES = 5;
export const MAX_MAX_PAGES = 500;

export const DEFAULT_MANUAL_RESCANS_PER_DAY = 1;

export interface CompetitorsConfig {
  scanFrequency: ScanFrequency;
  /** Pages fetched per competitor per scan (story 2 decision: 50, no depth limit). */
  maxPagesPerScan: number;
  /** "Scan now" presses allowed per site per day (PM-OS admins are exempt). */
  manualRescansPerDay: number;
  /** Users (ids, same organization) who receive the scan notification email. */
  notifyUserIds: string[];
  /** News feed baseline: what scans found before this moment is history, not news (ISO, null = everything is news). */
  baselineUntil: string | null;
}

export const DEFAULT_COMPETITORS_CONFIG: CompetitorsConfig = {
  scanFrequency: "weekly",
  maxPagesPerScan: DEFAULT_MAX_PAGES,
  manualRescansPerDay: DEFAULT_MANUAL_RESCANS_PER_DAY,
  notifyUserIds: [],
  baselineUntil: null,
};

// ————— Scanner rules (story 2, 2026-10-26) —————
/**
 * The manual-rescan limit is a production rule; local dev scans a site as
 * often as needed. Enforced when NODE_ENV is production, or whenever
 * COMPETITORS_RESCAN_LIMIT=on (to test the limit locally).
 */
export function rescanLimitEnforced(): boolean {
  const v = process.env.COMPETITORS_RESCAN_LIMIT?.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return process.env.NODE_ENV === "production";
}
/** Pause between two requests to the same site. */
export const SCAN_PAUSE_MS = 2000;
/** robots.txt Crawl-delay is honoured up to this. */
export const CRAWL_DELAY_CAP_MS = 10_000;
/** A scan stops fetching at this age and reports "incomplete". */
export const SCAN_TIME_BUDGET_MS = 15 * 60_000;
/** Page text is kept for this many scans per site; older rows keep the hash. */
export const KEEP_TEXT_SCANS = 2;
/** A fact not seen for this many scans of its site is stale. */
export const STALE_AFTER_SCANS = 3;
/** Why a page was not read — shown to users as counts. */
export const OUTCOME_CATEGORIES = ["robots", "denied", "login", "notfound", "timeout", "cap", "policy"] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];
/** What the user sees per competitor after a scan. */
export const SCAN_BADGES = ["full", "incomplete", "blocked", "unreachable"] as const;
export type ScanBadge = (typeof SCAN_BADGES)[number];

export function isScanFrequency(v: unknown): v is ScanFrequency {
  return typeof v === "string" && (SCAN_FREQUENCIES as readonly string[]).includes(v);
}

export function mergeCompetitorsConfig(raw: unknown): CompetitorsConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const pages = typeof r.maxPagesPerScan === "number" && Number.isFinite(r.maxPagesPerScan)
    ? Math.min(MAX_MAX_PAGES, Math.max(MIN_MAX_PAGES, Math.round(r.maxPagesPerScan)))
    : DEFAULT_MAX_PAGES;
  const rescans = typeof r.manualRescansPerDay === "number" && Number.isFinite(r.manualRescansPerDay)
    ? Math.min(50, Math.max(1, Math.round(r.manualRescansPerDay)))
    : DEFAULT_MANUAL_RESCANS_PER_DAY;
  return {
    scanFrequency: isScanFrequency(r.scanFrequency) ? r.scanFrequency : DEFAULT_COMPETITORS_CONFIG.scanFrequency,
    maxPagesPerScan: pages,
    manualRescansPerDay: rescans,
    notifyUserIds: Array.isArray(r.notifyUserIds) ? [...new Set(r.notifyUserIds.filter((x): x is string => typeof x === "string"))].slice(0, 500) : [],
    baselineUntil: typeof r.baselineUntil === "string" && !Number.isNaN(Date.parse(r.baselineUntil)) ? r.baselineUntil : null,
  };
}

/** Milliseconds between scheduled scans for a frequency. */
export function frequencyMs(f: ScanFrequency): number {
  switch (f) {
    case "daily":
      return 24 * 3600_000;
    case "weekly":
      return 7 * 24 * 3600_000;
    case "monthly":
      return 30 * 24 * 3600_000;
  }
}

/** A domain's PMOS AI definition text (definition, belongs here, not here, typical phrases). */
export const MAX_DOMAIN_DESCRIPTION = 6000;

/** The org's own cell on a capability — set by PMs, never scanned. */
export const OWN_STATUS_VALUES = ["has", "partial", "missing"] as const;
export type OwnStatus = (typeof OWN_STATUS_VALUES)[number];
export function isOwnStatus(v: unknown): v is OwnStatus {
  return typeof v === "string" && (OWN_STATUS_VALUES as readonly string[]).includes(v);
}

/** Matrix cell values. */
export const STATUS_VALUES = ["has", "partial", "missing", "unknown"] as const;
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

/** Below this confidence a scanned "has"/"partial" is shown as "partial?" to confirm. */
export const LOW_CONFIDENCE = 0.6;

/**
 * Where a competitor's pages come from. The website is crawled by the
 * scanner; every other type gets its pages from a collector (an import, an
 * upload, a later connector) and runs the same pipeline. One source row per
 * type per competitor.
 */
export const SOURCE_TYPES = [
  "website",
  "documents",
  "helpcenter",
  "video",
  "archive",
  "apidocs",
  "changelog",
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

/** What a stored page text is. */
export const PAGE_KINDS = ["page", "document", "article", "transcript", "capture", "quotes"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}

/**
 * A suggestion's evidence is stored as one string, `"<quote> — <url>"` (the URL
 * is optional). Split it for display and for the status row written on accept.
 */
export function splitSuggestedQuote(raw: string | null | undefined): { quote: string; url: string | null } {
  const text = raw ?? "";
  const url = text.match(/\s—\s(https?:\/\/\S+)$/)?.[1] ?? null;
  const quote = text.replace(/\s+—\s+https?:\/\/\S+$/, "").trim();
  return { quote, url };
}
