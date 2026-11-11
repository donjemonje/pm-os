import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { STORAGE_LIMIT_CHARS, ceilingMsFromEnv } from "./config";

/**
 * Global competitors settings, set in Administration (AppSetting rows):
 *
 *   competitors.remoteScanEnabled  — the remote lane's ON/OFF switch, default
 *                                    OFF (Website Scanning PRD 2026-11-04: every
 *                                    scan goes to the local lane while off).
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
}

const KEYS = {
  remote: "competitors.remoteScanEnabled",
  clock: "competitors.clockOffsetMs",
  /** TEST KNOBS: a shorter time limit / a smaller storage limit for one test. Honoured only with COMPETITORS_TEST_KNOBS=on. */
  ceilingMs: "competitors.test.ceilingMs",
  storageLimit: "competitors.test.storageLimitChars",
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
  const remote = await readSetting(KEYS.remote);
  return { remoteScanEnabled: remote === true };
}

export async function setGlobalScanSettings(patch: Partial<GlobalScanSettings>): Promise<GlobalScanSettings> {
  if (patch.remoteScanEnabled !== undefined) await writeSetting(KEYS.remote, patch.remoteScanEnabled);
  return getGlobalScanSettings();
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
  /** Research: the answer for a page, by its address; "*" = every page not listed. A page with no answer gets {"capabilities": []}. */
  research?: Record<string, string>;
  /** Merge: the answer of the n-th merge call of a run. Missing → {"groups": []}. */
  merge?: string[];
  /** Match: the answer of the n-th match call of a run. Missing while items still need a match → the run FAILS: a test states what it expects. */
  match?: string[];
  /** Second look: by our capability's name; "*" = every other one. Missing → {"found": false, …}. */
  secondLook?: Record<string, string>;
  /** Facts: every chunk gets this answer. Missing → {"facts": []}. */
  facts?: string;
  /** Capacity answers: after `afterCalls` successful calls of the run, the next `times` calls answer "no capacity". */
  rateLimit?: { afterCalls: number; times: number };
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
  if ("classify" in r) return { error: "the classify / facts shape is gone: use research, merge, match, secondLook, facts, rateLimit" };
  const out: TestAiAnswers = {};
  for (const key of ["research", "secondLook"] as const) {
    if (r[key] === undefined) continue;
    const m = r[key];
    if (!m || typeof m !== "object" || Array.isArray(m) || !Object.values(m).every(isJson)) return { error: `${key} must be an object of JSON texts` };
    out[key] = m as Record<string, string>;
  }
  for (const key of ["merge", "match"] as const) {
    if (r[key] === undefined) continue;
    if (!Array.isArray(r[key]) || !(r[key] as unknown[]).every(isJson)) return { error: `${key} must be a list of JSON texts` };
    out[key] = r[key] as string[];
  }
  if (r.facts !== undefined) {
    if (!isJson(r.facts)) return { error: "facts must be JSON text" };
    out.facts = r.facts;
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
