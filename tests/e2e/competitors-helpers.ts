import { expect, type APIRequestContext } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeSite, type FakeSite } from "../fixtures/fake-site/fake-site";
import { withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

/**
 * Shared by the Competitors scan specs (competitors-scanning.spec.ts WS- rows,
 * competitors-decisions.spec.ts CA- rows): the fake competitor site, the real
 * station poller run once, the knobs route, scan waits and the parking of
 * other organizations' sources for the length of a run.
 *
 * Moved here from competitors-scanning.spec.ts on 2026-11-10 without changing
 * what they do; each helper takes the state it used to read from that file
 * (workspace id, admin API context, key file) as an argument.
 */

export const SITE_HOST = "localtest.me";
export const POLLER = join(__dirname, "../../scripts/pmos-local-scan/poller.mjs");
/** One scratch dir for both specs: a run that died in either is repaired by the next start of either. */
export const SCRATCH = join(tmpdir(), "pmos-qa-ws");
export const SNAPSHOT = join(SCRATCH, "isolation-snapshot.json");
export const FAR_FUTURE = new Date("2126-01-01T00:00:00Z");
export const FINAL = /^(ok|partial|failed|stale|cancelled)$/;

// ————— Shared-clone isolation —————

interface Snapshot {
  sources: { id: string; lastScanAt: string | null }[];
  requests: { id: string; state: string }[];
}

/**
 * The tick and the station check-in are GLOBAL (every organization). Other organizations' due sources and waiting
 * requests are parked for the run (restored byte-exact by restoreOtherOrgs; the snapshot lives in the OS temp dir and
 * is re-applied at the next start if a run died). Nothing of theirs is scanned, deleted or emailed.
 */
export async function isolateOtherOrgs(db: PrismaClient, ownWorkspaceIds: string[]): Promise<void> {
  await restoreOtherOrgs(db); // a previous run that died mid-way
  const sources = await db.competitorSource.findMany({ where: { type: "website", workspaceId: { notIn: ownWorkspaceIds } }, select: { id: true, lastScanAt: true } });
  const requests = await db.localScanRequest.findMany({ where: { workspaceId: { notIn: ownWorkspaceIds }, state: "waiting" }, select: { id: true, state: true } });
  const snap: Snapshot = { sources: sources.map((s) => ({ id: s.id, lastScanAt: s.lastScanAt?.toISOString() ?? null })), requests };
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2));
  await db.competitorSource.updateMany({ where: { id: { in: sources.map((s) => s.id) } }, data: { lastScanAt: FAR_FUTURE } });
  await db.localScanRequest.updateMany({ where: { id: { in: requests.map((r) => r.id) } }, data: { state: "qa_parked" } });
}

export async function restoreOtherOrgs(db: PrismaClient): Promise<void> {
  if (!existsSync(SNAPSHOT)) return;
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  for (const s of snap.sources) await db.competitorSource.updateMany({ where: { id: s.id }, data: { lastScanAt: s.lastScanAt ? new Date(s.lastScanAt) : null } });
  for (const r of snap.requests) await db.localScanRequest.updateMany({ where: { id: r.id }, data: { state: r.state } });
  rmSync(SNAPSHOT, { force: true });
}

// ————— API knobs —————

/** POST /api/admin/competitors/knobs as a PM-OS admin (COMPETITORS_TEST_KNOBS=on). */
export async function postKnob(adminApi: APIRequestContext, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await adminApi.post("/api/admin/competitors/knobs", { data: body });
  expect(res.status(), `knobs ${JSON.stringify(body)}: ${await res.text()}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Enroll a station key through Administration's route; the secret is written to a 0600 file for the poller. */
export async function createStationKey(adminApi: APIRequestContext, label: string): Promise<{ id: string; secret: string; file: string }> {
  const res = await adminApi.post("/api/admin/competitors/keys", { data: { label } });
  expect(res.status(), await res.text()).toBe(201);
  const json = (await res.json()) as { id: string; secret: string };
  mkdirSync(SCRATCH, { recursive: true });
  const file = join(SCRATCH, `key-${json.id}`);
  writeFileSync(file, json.secret, { mode: 0o600 });
  return { ...json, file };
}

// ————— Sites and competitors —————

/**
 * A fixture site on a free port. Host "localtest.me" (public DNS → 127.0.0.1,
 * wildcard subdomains): the site rule wants a dotted host — plain "localhost"
 * is refused by normalizeWebsite even with COMPETITORS_ALLOW_PRIVATE_HOSTS=on —
 * and app.localtest.me gives WS-23 a real subdomain. The site is pushed onto
 * `openSites` so the caller's afterEach / afterAll stops it.
 */
export async function startSite(openSites: FakeSite[]): Promise<FakeSite> {
  const site = await startFakeSite({ port: 0, host: SITE_HOST });
  openSites.push(site);
  return site;
}

export interface Cmp {
  id: string;
  sourceId: string;
  name: string;
  site: FakeSite;
}

/** Add a competitor through the API (the UI form is exercised in WS-01). The first scan starts on add. */
export async function addCompetitor(api: APIRequestContext, site: FakeSite, name: string): Promise<Cmp> {
  const res = await api.post("/api/competitors", { data: { website: site.url, name } });
  expect(res.status(), `add ${name}: ${await res.text()}`).toBe(201);
  const state = ((await res.json()) as { state: { competitors: { id: string; name: string; source: { id: string } | null }[] } }).state;
  const c = state.competitors.find((x) => x.name === name);
  expect(c, `competitor ${name} in the state`).toBeTruthy();
  return { id: c!.id, sourceId: c!.source!.id, name, site };
}

export async function scanNow(api: APIRequestContext, competitorId: string) {
  return api.post("/api/competitors/scan", { data: { competitorId } });
}

// ————— DB reads —————

export const scanRow = (scanId: string) => withTestDb((db) => db.competitorScan.findUniqueOrThrow({ where: { id: scanId } }));
export const scansOf = (sourceId: string) => withTestDb((db) => db.competitorScan.findMany({ where: { sourceId }, orderBy: { startedAt: "asc" } }));
export const pagesOf = (sourceId: string) => withTestDb((db) => db.sourcePage.findMany({ where: { sourceId }, orderBy: { url: "asc" } }));
export const requestOf = (scanId: string) => withTestDb((db) => db.localScanRequest.findUniqueOrThrow({ where: { scanId } }));
export const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

/** The newest scan of a source once it has reached `status` (the add route starts the first scan fire-and-forget). */
export async function waitForScanWithStatus(sourceId: string, status: string, timeout = 30_000) {
  let found: Awaited<ReturnType<typeof scansOf>>[number] | undefined;
  await expect.poll(async () => {
    const list = await scansOf(sourceId);
    found = [...list].reverse().find((s) => s.status === status);
    return found?.id ?? null;
  }, { timeout, intervals: [250, 500] }).not.toBeNull();
  return found!;
}

export async function waitForScanEnd(scanId: string, timeout = 120_000) {
  await expect.poll(async () => (await scanRow(scanId)).status, { timeout, intervals: [500] }).toMatch(FINAL);
  return scanRow(scanId);
}

// ————— The poller —————

export interface PollerOpts {
  stateDir?: string;
  pauseMs?: number;
  /** Time knob: the station's own stop, in minutes (fractions allowed). */
  maxMinutes?: number;
  /** The station key file. */
  key?: string;
}

export function pollerArgs(o: PollerOpts & { key: string }): string[] {
  return [
    POLLER, "--app-url", LOCAL_BASE_URL, "--key-file", o.key, "--state-dir", o.stateDir ?? freshStateDir(),
    "--runner", "fetch", "--pause-ms", String(o.pauseMs ?? 0),
    ...(o.maxMinutes ? ["--max-minutes", String(o.maxMinutes)] : []),
  ];
}

export function freshStateDir(): string {
  const dir = join(SCRATCH, `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One check-in ("run once"): the real poller, fetch runner. Waiting scans start without asking. */
export function runStationPoller(o: PollerOpts & { key: string }, timeoutMs = 150_000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile("node", pollerArgs(o), { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      if (err && (err as { killed?: boolean }).killed) return reject(new Error(`poller timed out after ${timeoutMs} ms\n${out}`));
      resolve({ stdout: out, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

export function spawnStationPoller(o: PollerOpts & { key: string }): ChildProcess {
  return spawn("node", pollerArgs(o), { stdio: ["ignore", "pipe", "pipe"] });
}

// ————— Cleanup —————

/** Soft-delete a workspace's competitors and end their scans so the next row starts clean (no tick leftovers). */
export async function cleanupCompetitorsOf(workspaceId: string): Promise<void> {
  await withTestDb(async (db) => {
    const t = new Date();
    await db.localScanRequest.updateMany({ where: { workspaceId, state: { in: ["waiting", "running"] } }, data: { state: "cancelled", finishedAt: t } });
    await db.competitorScan.updateMany({ where: { workspaceId, status: { in: ["queued", "pending_local", "running"] } }, data: { status: "cancelled", finishedAt: t, error: "QA cleanup" } });
    await db.competitor.updateMany({ where: { workspaceId, deletedAt: null }, data: { deletedAt: t } });
  });
}
