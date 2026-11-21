import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { analysisTokenBudgetOf } from "./analysis/budget";
import { readSettingOf, storedReadSetting, type ReadSetting } from "./analysis/reads";
import { STORAGE_LIMIT_CHARS, ceilingMsFromEnv } from "./config";

/**
 * Global competitors settings, set in Administration (AppSetting rows):
 *
 *   competitors.remoteScanEnabled  — the remote lane's ON/OFF switch, default
 *                                    OFF (Website Scanning PRD 2026-11-04: every
 *                                    scan goes to the local lane while off).
 *   competitors.analysisDisabled   — "Disable analysis", default OFF (Daniel
 *                                    2026-11-11). While ON a scan ends after its
 *                                    pages are saved: page states and the badge
 *                                    are set, PMOS AI is not called.
 *   competitors.analysisTokenBudget — "Analysis token budget per competitor,
 *                                    per run", default 10,000,000 (Daniel
 *                                    2026-11-12; analysis/budget.ts). One
 *                                    number for the installation.
 *   competitors.clockOffsetMs      — TEST KNOB. Honoured only when
 *                                    COMPETITORS_TEST_KNOBS=on (never in
 *                                    production): shifts "now" for everything
 *                                    time-based (due scans, stale, 24-hour
 *                                    alert, retention, token validity, the
 *                                    daily rescan limit) so a test sets time
 *                                    instead of waiting for it.
 */

export interface GlobalScanSettings {
  remoteScanEnabled: boolean;
  /** "Disable analysis": a scan ends after saving its pages, PMOS AI is not called. Default false. */
  analysisDisabled: boolean;
  /** The most tokens one analysis run of one competitor may use (analysis/budget.ts). Default 10,000,000. */
  analysisTokenBudget: number;
}

const KEYS = {
  remote: "competitors.remoteScanEnabled",
  analysisOff: "competitors.analysisDisabled",
  analysisBudget: "competitors.analysisTokenBudget",
  clock: "competitors.clockOffsetMs",
  /** { at, scanId } of the last "station is off" email (one per STATION_OFF_ALERT_EVERY_MS). */
  stationOffAlert: "competitors.stationOffAlert",
  /** TEST KNOBS: a shorter time limit / a smaller storage limit for one test. Honoured only with COMPETITORS_TEST_KNOBS=on. */
  ceilingMs: "competitors.test.ceilingMs",
  storageLimit: "competitors.test.storageLimitChars",
  /** "What the analysis reads": one switch per kind of content, for the installation (analysis/reads.ts) — { kinds: { help: false, … } }. */
  analysisReads: "competitors.analysisReads",
  /** TEST KNOB: the model's raw answers for one competitor's analysis runs, { competitorId: TestAiAnswers }. */
  aiAnswers: "competitors.test.aiAnswers",
} as const;

async function readSetting(key: string): Promise<unknown> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value;
}

async function writeSetting(key: string, value: Prisma.InputJsonValue): Promise<void> {
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getGlobalScanSettings(): Promise<GlobalScanSettings> {
  const [remote, analysisOff, budget] = await Promise.all([readSetting(KEYS.remote), readSetting(KEYS.analysisOff), readSetting(KEYS.analysisBudget)]);
  return { remoteScanEnabled: remote === true, analysisDisabled: analysisOff === true, analysisTokenBudget: analysisTokenBudgetOf(budget) };
}

/** "What the analysis reads" (analysis/reads.ts), read by a run once, at its claim: a kind never stored has its default. */
export async function analysisReads(): Promise<ReadSetting> {
  return readSettingOf(await readSetting(KEYS.analysisReads));
}

/** Turn kinds on or off; the kinds not named keep what they have. Returns the setting before and after. */
export async function setAnalysisReads(patch: Partial<ReadSetting>): Promise<{ before: ReadSetting; after: ReadSetting }> {
  const before = await analysisReads();
  const after = { ...before, ...patch };
  await writeSetting(KEYS.analysisReads, storedReadSetting(after));
  return { before, after };
}

/** The token budget of one analysis run, read by the run once, at its claim. */
export async function analysisTokenBudget(): Promise<number> {
  return analysisTokenBudgetOf(await readSetting(KEYS.analysisBudget));
}

export async function setGlobalScanSettings(patch: Partial<GlobalScanSettings>): Promise<GlobalScanSettings> {
  if (patch.remoteScanEnabled !== undefined) await writeSetting(KEYS.remote, patch.remoteScanEnabled);
  if (patch.analysisDisabled !== undefined) await writeSetting(KEYS.analysisOff, patch.analysisDisabled);
  // The caller validated it (analysis/budget.ts checkAnalysisTokenBudget); a value that is not a valid budget reads as the default.
  if (patch.analysisTokenBudget !== undefined) await writeSetting(KEYS.analysisBudget, patch.analysisTokenBudget);
  return getGlobalScanSettings();
}

/** The last "the local station is off" email: when it went out and for which scan. */
export async function lastStationOffAlert(): Promise<{ at: Date; scanId: string } | null> {
  const v = (await readSetting(KEYS.stationOffAlert)) as { at?: unknown; scanId?: unknown } | null | undefined;
  if (!v || typeof v.at !== "string" || typeof v.scanId !== "string") return null;
  const at = new Date(v.at);
  return Number.isNaN(at.getTime()) ? null : { at, scanId: v.scanId };
}

export async function noteStationOffAlert(at: Date, scanId: string): Promise<void> {
  await writeSetting(KEYS.stationOffAlert, { at: at.toISOString(), scanId });
}

// ————— Clock (test knob) —————

/**
 * The one switch for every test knob. Deliberately NOT guarded by NODE_ENV:
 * `next build` inlines NODE_ENV=production into the e2e build in CI too, so
 * the guard is "the variable is set", which prod (apphosting.yaml) never does
 * — see office/versions_prod_changes.md. A warning is logged once when on.
 */
let warned = false;
export function testKnobsEnabled(): boolean {
  const v = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  const on = v === "on" || v === "true" || v === "1";
  if (on && !warned) {
    warned = true;
    console.warn("[competitors] TEST KNOBS ON (COMPETITORS_TEST_KNOBS) — clock, tick, ceiling, pause, private hosts and the PMOS AI answers of the analysis are controllable. Never in production.");
  }
  return on;
}

/**
 * Test knob: COMPETITORS_AI=off — nothing automatic reaches PMOS AI. A finished scan, a catalog change and the kicks
 * (server start, timer, tick) queue and start no analysis. A run asked for by hand (trigger "manual") and a run with
 * injected answers still run (analysis/gate.ts). Local dev sets it; production never does.
 */
export function aiStepEnabled(): boolean {
  if (!testKnobsEnabled()) return true;
  const v = process.env.COMPETITORS_AI?.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
}

let clockCache: { at: number; offset: number } | null = null;

/** The offset the tests set, in ms; 0 outside test environments. Cached for 2 s. */
export async function clockOffsetMs(): Promise<number> {
  if (!testKnobsEnabled()) return 0;
  if (clockCache && Date.now() - clockCache.at < 2000) return clockCache.offset;
  const v = await readSetting(KEYS.clock);
  const offset = typeof v === "number" && Number.isFinite(v) ? v : 0;
  clockCache = { at: Date.now(), offset };
  return offset;
}

/** "Now" as the scanner sees it — the wall clock plus the test offset, if any. */
export async function now(): Promise<Date> {
  return new Date(Date.now() + (await clockOffsetMs()));
}

/** Tests only: move the scanner's clock. Refused outside test environments. */
export async function setClockOffsetMs(offset: number): Promise<boolean> {
  if (!testKnobsEnabled()) return false;
  await writeSetting(KEYS.clock, Math.round(offset));
  clockCache = null;
  return true;
}

// ————— Limits (Daniel 2026-11-09: no page limit; 8 h per scan; 10 GB of page text in all) —————

/** How long one scan may run. Test knob (knobs on): the AppSetting set through the knobs route, else COMPETITORS_CEILING_MS. */
export async function scanTimeLimitMs(): Promise<number> {
  if (testKnobsEnabled()) {
    const v = await readSetting(KEYS.ceilingMs);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return ceilingMsFromEnv();
}

/** The most competitor page text PM-OS keeps, all organizations together (characters). Test knob (knobs on): the AppSetting. */
export async function storageLimitChars(): Promise<number> {
  if (testKnobsEnabled()) {
    const v = await readSetting(KEYS.storageLimit);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return STORAGE_LIMIT_CHARS;
}

/**
 * Characters of page text stored right now, every source of every organization (SourcePage.chars; previous texts not counted).
 * The full-table SUM runs at most once a minute per process; the page store reports what it writes in between
 * (noteStoredChars), so a scan sees its own pages count at once. Another process's writes show within the minute.
 */
const STORED_CACHE_MS = 60_000;
let storedCache: { at: number; value: number } | null = null;
export async function storedTextChars(): Promise<number> {
  if (storedCache && Date.now() - storedCache.at < STORED_CACHE_MS) return storedCache.value;
  const r = await db.sourcePage.aggregate({ _sum: { chars: true }, where: { text: { not: null } } });
  storedCache = { at: Date.now(), value: r._sum.chars ?? 0 };
  return storedCache.value;
}

/** The page store wrote `delta` characters of text (negative when text was dropped): keeps the cached sum current. */
export function noteStoredChars(delta: number): void {
  if (storedCache) storedCache.value = Math.max(0, storedCache.value + delta);
}

/** True when the store is at or past its limit: the scan stops here, the rest is "not attempted — storage limit". */
export async function storageFull(): Promise<boolean> {
  const [used, limit] = await Promise.all([storedTextChars(), storageLimitChars()]);
  return used >= limit;
}

/**
 * The raw model answers a test injected for one competitor's analysis runs (TEST KNOB, see ai.ts callTool).
 * Every value is the JSON text the model would have answered; it goes through callTool's `injected` parameter, so
 * the parser, the quote check, the merge, the placement through decisions.ts, the cell rules and every write run
 * unchanged. Nothing but the model call is replaced.
 */
export interface TestAiAnswers {
  /**
   * Map: the label of a section, by its address — the full prefix ("acme.example/blog") or its path ("/blog"); "*" =
   * every other section. A section no entry names is "product" (it is read). The values are label words, not JSON:
   * the JSON answer is built from them per call (analysis/prompts.ts injectedMapAnswer) and goes through the same
   * parser — a word outside the closed set of labels fails the run, as a real answer would.
   */
  map?: Record<string, string>;
  /**
   * Map, page by page: the pages of help-center and blog sections that are release notes — full addresses or paths
   * ("/blog/changelog-may"). A page no entry names is not one. Addresses, not JSON: the answer is built from them per
   * call (analysis/prompts.ts injectedMapPagesAnswer) and goes through the same parser.
   */
  releaseNotes?: string[];
  /**
   * The reading: the answer of the n-th reading request of this company in a run (one request per chunk of pages).
   * The first request of a company answers with its list ({"capabilities": […], "unexplained": […]}), a later one with
   * what its pages change ({"new_capabilities", "new_features", "corrections", "removed", "unexplained"}). Missing →
   * an answer that lists or changes nothing. Quotes name pages by their code in the request (P1 … in reading order).
   */
  reading?: string[];
  /** Match: the answer of the n-th match call of a run. Missing while items still need a match → the run FAILS: a test states what it expects. */
  match?: string[];
  /** Second look: the answer of the n-th second-look request of this company in a run (one per chunk). Missing → {"found": []}. */
  secondLook?: string[];
  /**
   * A setup run only, read from the answers of the organization's OWN source (analysis/setup.ts) — every company of
   * an injected setup run must have answers of its own for its map, reading and second looks:
   *   unify         — the answer of the n-th unify call about capabilities. Missing while one still needs a row → the run FAILS.
   *   unifyReview   — the answer of the review call (made only when the capabilities took more than one call). Missing → {"merge": []}.
   *   unifyFeatures — the answer of the n-th unify call about features (an injected run makes them one at a time, in
   *                   table order). Missing while a feature still needs a row → the run FAILS.
   *   domains       — the answer of the n-th domains call. Missing while rows still need a domain → the run FAILS.
   */
  unify?: string[];
  unifyReview?: string;
  unifyFeatures?: string[];
  domains?: string[];
  /** Capacity answers: after `afterCalls` successful calls of the run, the next `times` calls answer "no capacity". */
  rateLimit?: { afterCalls: number; times: number };
  /**
   * The search for the company's other addresses (address-search.ts), not an analysis run: what a candidate address
   * is, by its host ("support.acme.example" → "helpcenter" | "apidocs" | "changelog" | "skip"); "*" = every other
   * candidate. A candidate no entry names is "skip". Kind words, not JSON: the answer is built from them
   * (addresses.ts injectedAddressPick) and goes through the same parser — a word outside the closed set is an
   * unusable answer, as a real one would be.
   */
  addresses?: Record<string, string>;
}

const isJson = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
};

/** The knob's value as given by a test, checked: every answer must be JSON text. Returns what is wrong, or the answers. */
export function readTestAiAnswers(raw: unknown): TestAiAnswers | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "answers must be an object" };
  const r = raw as Record<string, unknown>;
  if ("classify" in r) return { error: "the classify / facts shape is gone: use map, releaseNotes, reading, match, secondLook, rateLimit" };
  if ("facts" in r) return { error: "the profile-facts step is gone: a run makes no facts call, so it takes no facts answer" };
  if ("research" in r || "merge" in r) return { error: "the per-page research and the merge are gone: use reading (the answer of each reading request, in order)" };
  const out: TestAiAnswers = {};
  if (r.map !== undefined) {
    const m = r.map;
    if (!m || typeof m !== "object" || Array.isArray(m) || !Object.values(m).every((v) => typeof v === "string")) return { error: "map must be an object of section address → label" };
    out.map = m as Record<string, string>;
  }
  if (r.addresses !== undefined) {
    const m = r.addresses;
    if (!m || typeof m !== "object" || Array.isArray(m) || !Object.values(m).every((v) => typeof v === "string")) return { error: "addresses must be an object of address host → kind" };
    out.addresses = m as Record<string, string>;
  }
  if (r.releaseNotes !== undefined) {
    if (!Array.isArray(r.releaseNotes) || !r.releaseNotes.every((v) => typeof v === "string")) return { error: "releaseNotes must be a list of page addresses" };
    out.releaseNotes = r.releaseNotes as string[];
  }
  for (const key of ["reading", "match", "secondLook", "unify", "unifyFeatures", "domains"] as const) {
    if (r[key] === undefined) continue;
    if (!Array.isArray(r[key]) || !(r[key] as unknown[]).every(isJson)) return { error: `${key} must be a list of JSON texts` };
    out[key] = r[key] as string[];
  }
  if (r.unifyReview !== undefined) {
    if (!isJson(r.unifyReview)) return { error: "unifyReview must be JSON text" };
    out.unifyReview = r.unifyReview;
  }
  if (r.rateLimit !== undefined) {
    const l = r.rateLimit as Record<string, unknown> | null;
    const ok = l && typeof l === "object" && Number.isInteger(l.afterCalls) && Number.isInteger(l.times) && (l.afterCalls as number) >= 0 && (l.times as number) >= 0;
    if (!ok) return { error: "rateLimit must be { afterCalls, times } with whole numbers" };
    out.rateLimit = { afterCalls: l.afterCalls as number, times: l.times as number };
  }
  return out;
}

/**
 * TEST KNOB: the answers injected for this competitor, or null. Keyed by competitor, so one test's answers never
 * reach another test, another organization or another competitor. Null whenever the knobs are off — production
 * never reads the setting. The analysis engine reads it ONCE per run, at the claim.
 */
export async function testAiAnswers(competitorId: string): Promise<TestAiAnswers | null> {
  if (!testKnobsEnabled()) return null;
  const all = await readSetting(KEYS.aiAnswers);
  if (!all || typeof all !== "object" || Array.isArray(all)) return null;
  const entry = (all as Record<string, unknown>)[competitorId];
  if (!entry) return null;
  const answers = readTestAiAnswers(entry);
  return "error" in answers ? null : answers;
}

/** Tests only: set or clear (null) the injected answers of one competitor. Refused outside test environments. */
export async function setTestAiAnswers(competitorId: string, answers: TestAiAnswers | null): Promise<boolean> {
  if (!testKnobsEnabled()) return false;
  const all = await readSetting(KEYS.aiAnswers);
  const next: Record<string, unknown> = all && typeof all === "object" && !Array.isArray(all) ? { ...(all as Record<string, unknown>) } : {};
  if (answers === null) delete next[competitorId];
  else next[competitorId] = answers;
  await writeSetting(KEYS.aiAnswers, next as Prisma.InputJsonValue);
  return true;
}

/** Tests only: set or clear (null) the two limit knobs. Refused outside test environments. */
export async function setLimitKnobs(patch: { ceilingMs?: number | null; storageLimitChars?: number | null }): Promise<boolean> {
  if (!testKnobsEnabled()) return false;
  if (patch.ceilingMs !== undefined) await writeSetting(KEYS.ceilingMs, patch.ceilingMs === null ? 0 : Math.round(patch.ceilingMs));
  if (patch.storageLimitChars !== undefined) await writeSetting(KEYS.storageLimit, patch.storageLimitChars === null ? 0 : Math.round(patch.storageLimitChars));
  return true;
}
