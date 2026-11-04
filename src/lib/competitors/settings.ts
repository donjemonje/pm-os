import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { DEFAULT_RETENTION_DAYS } from "./config";

/**
 * Global competitors settings, set in Administration (AppSetting rows):
 *
 *   competitors.remoteScanEnabled  — the remote lane's ON/OFF switch, default
 *                                    OFF (Website Scanning PRD 2026-11-04: every
 *                                    scan goes to the local lane while off).
 *   competitors.retentionDays      — superseded page texts are nulled after
 *                                    this many days; hashes stay forever.
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
  retentionDays: number;
}

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

const KEYS = {
  remote: "competitors.remoteScanEnabled",
  retention: "competitors.retentionDays",
  clock: "competitors.clockOffsetMs",
} as const;

async function readSetting(key: string): Promise<unknown> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value;
}

async function writeSetting(key: string, value: Prisma.InputJsonValue): Promise<void> {
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getGlobalScanSettings(): Promise<GlobalScanSettings> {
  const [remote, retention] = await Promise.all([readSetting(KEYS.remote), readSetting(KEYS.retention)]);
  const days = typeof retention === "number" && Number.isFinite(retention) ? Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(retention))) : DEFAULT_RETENTION_DAYS;
  return { remoteScanEnabled: remote === true, retentionDays: days };
}

export async function setGlobalScanSettings(patch: Partial<GlobalScanSettings>): Promise<GlobalScanSettings> {
  if (patch.remoteScanEnabled !== undefined) await writeSetting(KEYS.remote, patch.remoteScanEnabled);
  if (patch.retentionDays !== undefined) await writeSetting(KEYS.retention, Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(patch.retentionDays))));
  return getGlobalScanSettings();
}

// ————— Clock (test knob) —————

export function testKnobsEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const v = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
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
