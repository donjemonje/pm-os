import type { Prisma } from "@prisma/client";
import { db } from "../db";
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
}

const KEYS = {
  remote: "competitors.remoteScanEnabled",
  analysisOff: "competitors.analysisDisabled",
  clock: "competitors.clockOffsetMs",
  /** { at, scanId } of the last "station is off" email (one per STATION_OFF_ALERT_EVERY_MS). */
  stationOffAlert: "competitors.stationOffAlert",
  /** TEST KNOBS: a shorter time limit / a smaller storage limit for one test. Honoured only with COMPETITORS_TEST_KNOBS=on. */
  ceilingMs: "competitors.test.ceilingMs",
  storageLimit: "competitors.test.storageLimitChars",
} as const;

async function readSetting(key: string): Promise<unknown> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value;
}

async function writeSetting(key: string, value: Prisma.InputJsonValue): Promise<void> {
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getGlobalScanSettings(): Promise<GlobalScanSettings> {
  const [remote, analysisOff] = await Promise.all([readSetting(KEYS.remote), readSetting(KEYS.analysisOff)]);
  return { remoteScanEnabled: remote === true, analysisDisabled: analysisOff === true };
}

export async function setGlobalScanSettings(patch: Partial<GlobalScanSettings>): Promise<GlobalScanSettings> {
  if (patch.remoteScanEnabled !== undefined) await writeSetting(KEYS.remote, patch.remoteScanEnabled);
  if (patch.analysisDisabled !== undefined) await writeSetting(KEYS.analysisOff, patch.analysisDisabled);
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
    console.warn("[competitors] TEST KNOBS ON (COMPETITORS_TEST_KNOBS) — clock, tick, ceiling, pause, private hosts and the AI step are controllable. Never in production.");
  }
  return on;
}

/** Test knob: COMPETITORS_AI=off skips the PMOS AI step (badge from pages only, "PMOS AI skipped" in the log). */
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

/** Tests only: set or clear (null) the two limit knobs. Refused outside test environments. */
export async function setLimitKnobs(patch: { ceilingMs?: number | null; storageLimitChars?: number | null }): Promise<boolean> {
  if (!testKnobsEnabled()) return false;
  if (patch.ceilingMs !== undefined) await writeSetting(KEYS.ceilingMs, patch.ceilingMs === null ? 0 : Math.round(patch.ceilingMs));
  if (patch.storageLimitChars !== undefined) await writeSetting(KEYS.storageLimit, patch.storageLimitChars === null ? 0 : Math.round(patch.storageLimitChars));
  return true;
}
