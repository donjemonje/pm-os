import type { Prisma } from "@prisma/client";
import { db } from "../db";

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
