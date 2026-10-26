/**
 * Competitors settings per workspace (Workspace.competitorsConfig), merged
 * over these defaults. Pure data — safe for client components.
 */

export const SCAN_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ScanFrequency = (typeof SCAN_FREQUENCIES)[number];

export const DEFAULT_MAX_PAGES = 50;
export const MIN_MAX_PAGES = 5;
export const MAX_MAX_PAGES = 500;

export interface CompetitorsConfig {
  scanFrequency: ScanFrequency;
  /** Pages fetched per competitor per scan (story 2 decision: 50, no depth limit). */
  maxPagesPerScan: number;
}

export const DEFAULT_COMPETITORS_CONFIG: CompetitorsConfig = {
  scanFrequency: "weekly",
  maxPagesPerScan: DEFAULT_MAX_PAGES,
};

export function isScanFrequency(v: unknown): v is ScanFrequency {
  return typeof v === "string" && (SCAN_FREQUENCIES as readonly string[]).includes(v);
}

export function mergeCompetitorsConfig(raw: unknown): CompetitorsConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const pages = typeof r.maxPagesPerScan === "number" && Number.isFinite(r.maxPagesPerScan)
    ? Math.min(MAX_MAX_PAGES, Math.max(MIN_MAX_PAGES, Math.round(r.maxPagesPerScan)))
    : DEFAULT_MAX_PAGES;
  return {
    scanFrequency: isScanFrequency(r.scanFrequency) ? r.scanFrequency : DEFAULT_COMPETITORS_CONFIG.scanFrequency,
    maxPagesPerScan: pages,
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

/** Lean-profile fact kinds — a closed list for story 2. */
export const FACT_KINDS = [
  "tagline",
  "product",
  "pricingTier",
  "integration",
  "certification",
  "customer",
  "vertical",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export function isFactKind(v: unknown): v is FactKind {
  return typeof v === "string" && (FACT_KINDS as readonly string[]).includes(v);
}

/** Below this confidence a scanned "has"/"partial" is shown as "partial?" to confirm. */
export const LOW_CONFIDENCE = 0.6;
