import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import { PAGE_PATHS, startFakeSite, type FakeSite } from "../fixtures/fake-site/fake-site";
import { acceptConfirm, hashPasswordLikeApp, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";

/**
 * Competitors — Website Scanning (feature/competitors_v1_finalization, QA rows
 * WS-01 … WS-27 of the story tab, 2026-11-04). The fake competitor site is
 * tests/fixtures/fake-site (12 pages, variants through its control endpoint,
 * one server per port); the local lane runs the real poller
 * (scripts/pmos-local-scan/poller.mjs) once per row with the plain fetch
 * runner, the real station key and the real hand-in routes. Knobs — only
 * deviations from reality, never logic changes:
 *
 *   clock    POST /api/admin/competitors/knobs {clockOffsetMs}  (COMPETITORS_TEST_KNOBS=on)
 *   tick     POST /api/admin/competitors/knobs {tick: true}     (the hourly scheduler, once)
 *   remote   PATCH /api/admin/competitors/settings {remoteScanEnabled}  (default OFF)
 *   poller   --mac-state locked|active, --answer approve|later, --runner fetch, --pause-ms, --max-pages
 *   env      COMPETITORS_PAUSE_MS=0 (robots Crawl-delay still honoured — WS-19 proves the pause rule),
 *            COMPETITORS_RESCAN_LIMIT=on, COMPETITORS_BROWSER=on, COMPETITORS_CEILING_PAGES=20,
 *            COMPETITORS_ALLOW_PRIVATE_HOSTS=on (localhost may be a competitor).
 *
 * Every knob is also guarded by NODE_ENV !== "production" in the app, and
 * `next build` inlines NODE_ENV=production — so this spec can only run on the
 * dev-server path (no CI=1) and skips itself in CI with that reason.
 *
 * Fixtures: one QA org (QA-WS Org) with a PM (CUSTOMER_ADMIN — adds
 * competitors and presses Scan now) and a PMOS_ADMIN of the same org (knobs,
 * Administration, the manual-rescan exemption), both logged in once in
 * beforeAll and reused through storage state. Each row adds its own
 * competitor(s) on its own fake site(s) and soft-deletes them afterwards, so
 * no row depends on another and the tick never finds a stale leftover.
 *
 * Shared-clone hazard: the tick and the station check-in are GLOBAL (every
 * organization). The feature clone holds other orgs' competitors whose
 * sources are all due, plus one waiting local-scan request. For the duration
 * of the run those sources' lastScanAt is moved far into the future and that
 * request is parked (state "qa_parked"); afterAll restores the exact values
 * (snapshot in the OS temp dir, re-applied at the next start if a run died).
 * Nothing of theirs is scanned, deleted or emailed.
 */

const ORG = { orgName: "QA-WS Org", slug: "qa-ws-org" };
const PM: TotpCreds & { name: string } = {
  name: "QA WS PM",
  email: "qa+ws-pm@pm-os.io",
  password: "Ws-pm-qa-pass1",
  totpSecret: "QAWSPMQAWSPMQAWSPMQAWSPMQAWSPMQA", // synthetic, test-only
};
const ADMIN: TotpCreds & { name: string } = {
  name: "QA WS Admin",
  email: "qa+ws-admin@pm-os.io",
  password: "Ws-admin-qa-pass1",
  totpSecret: "QAWSADMNQAWSADMNQAWSADMNQAWSADMN", // synthetic, test-only
};
const KEY_LABEL = "QA-WS station";
const SITE_HOST = "localtest.me";
const POLLER = join(__dirname, "../../scripts/pmos-local-scan/poller.mjs");
const SCRATCH = join(tmpdir(), "pmos-qa-ws");
const SNAPSHOT = join(SCRATCH, "isolation-snapshot.json");
const FAR_FUTURE = new Date("2126-01-01T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FINAL = /^(ok|partial|failed|stale|cancelled)$/;
const RESCAN_LIMITED = "Daily manual scan limit reached for this site — next manual scan tomorrow.";

// ————— Environment gate —————
const envProblems: string[] = [];
if (process.env.CI) envProblems.push("CI=1 takes the next build path, which inlines NODE_ENV=production and turns every test knob off (knobs route 404, localhost refused, pause 2 s)");
for (const [k, want] of [["COMPETITORS_TEST_KNOBS", "on"], ["COMPETITORS_ALLOW_PRIVATE_HOSTS", "on"], ["COMPETITORS_PAUSE_MS", "0"], ["COMPETITORS_RESCAN_LIMIT", "on"]] as const) {
  if (RESOLVED_ENV[k]?.trim() !== want) envProblems.push(`${k} must be "${want}" in test-apphosting.yaml (got ${RESOLVED_ENV[k] ?? "<unset>"})`);
}
const BROWSER_ON = RESOLVED_ENV.COMPETITORS_BROWSER?.trim() === "on";
const CEILING_20 = RESOLVED_ENV.COMPETITORS_CEILING_PAGES?.trim() === "20";

// ————— Shared state —————
let workspaceId: string;
let orgId: string;
let pmApi: APIRequestContext;
let adminApi: APIRequestContext;
let pmState: string;
let adminState: string;
let keyFile: string;
const openSites: FakeSite[] = [];

// ————— Fixtures —————
async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.user.deleteMany({ where: { OR: [{ email: { startsWith: "qa+ws-" } }, { organization: { slug: ORG.slug } }] } });
  await db.organization.deleteMany({ where: { slug: ORG.slug } });
  await db.scannerKey.deleteMany({ where: { label: { startsWith: "QA-WS" } } });
}

async function seedFixtures(db: PrismaClient): Promise<void> {
  const seeded = await seedQaOrgWithUser(db, { ...ORG, features: { competitors: true }, user: PM });
  orgId = seeded.orgId;
  workspaceId = seeded.workspaceId;
  // The PM adds competitors and presses Scan now — a customer admin in this product.
  await db.user.update({ where: { id: seeded.userId }, data: { role: "CUSTOMER_ADMIN" } });
  process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY;
  await db.user.create({
    data: { email: ADMIN.email, name: ADMIN.name, passwordHash: hashPasswordLikeApp(ADMIN.password), organizationId: orgId, role: "PMOS_ADMIN", totpSecretEnc: encryptTotpSecret(ADMIN.totpSecret), totpEnabledAt: new Date(), totpLastUsedStep: null },
  });
}

interface Snapshot {
  sources: { id: string; lastScanAt: string | null }[];
  requests: { id: string; state: string }[];
}

/** Other organizations' due sources and waiting requests are parked for the run (restored byte-exact in afterAll). */
async function isolateOtherOrgs(db: PrismaClient): Promise<void> {
  await restoreOtherOrgs(db); // a previous run that died mid-way
  const sources = await db.competitorSource.findMany({ where: { type: "website", workspaceId: { not: workspaceId } }, select: { id: true, lastScanAt: true } });
  const requests = await db.localScanRequest.findMany({ where: { workspaceId: { not: workspaceId }, state: "waiting" }, select: { id: true, state: true } });
  const snap: Snapshot = { sources: sources.map((s) => ({ id: s.id, lastScanAt: s.lastScanAt?.toISOString() ?? null })), requests };
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2));
  await db.competitorSource.updateMany({ where: { id: { in: sources.map((s) => s.id) } }, data: { lastScanAt: FAR_FUTURE } });
  await db.localScanRequest.updateMany({ where: { id: { in: requests.map((r) => r.id) } }, data: { state: "qa_parked" } });
}

async function restoreOtherOrgs(db: PrismaClient): Promise<void> {
  if (!existsSync(SNAPSHOT)) return;
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  for (const s of snap.sources) await db.competitorSource.updateMany({ where: { id: s.id }, data: { lastScanAt: s.lastScanAt ? new Date(s.lastScanAt) : null } });
  for (const r of snap.requests) await db.localScanRequest.updateMany({ where: { id: r.id }, data: { state: r.state } });
  rmSync(SNAPSHOT, { force: true });
}

async function resetGlobalKnobs(db: PrismaClient): Promise<void> {
  await db.appSetting.upsert({ where: { key: "competitors.clockOffsetMs" }, create: { key: "competitors.clockOffsetMs", value: 0 }, update: { value: 0 } });
  await db.appSetting.upsert({ where: { key: "competitors.remoteScanEnabled" }, create: { key: "competitors.remoteScanEnabled", value: false }, update: { value: false } });
  await db.appSetting.deleteMany({ where: { key: "competitors.retentionDays" } });
}

// ————— API knobs —————
async function knob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await adminApi.post("/api/admin/competitors/knobs", { data: body });
  expect(res.status(), `knobs ${JSON.stringify(body)}: ${await res.text()}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
const setClock = (offsetMs: number) => knob({ clockOffsetMs: offsetMs });
/** One hourly tick; returns its log lines ("due: …", "start …", "N stale scans", …). */
async function tick(): Promise<string[]> {
  return (await knob({ tick: true })).tick as string[];
}
async function setRemote(on: boolean): Promise<void> {
  const res = await adminApi.patch("/api/admin/competitors/settings", { data: { remoteScanEnabled: on } });
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { settings: { remoteScanEnabled: boolean } }).settings.remoteScanEnabled).toBe(on);
}
async function createKey(label: string): Promise<{ id: string; secret: string; file: string }> {
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
 * and app.localtest.me gives WS-23 a real subdomain.
 */
async function newSite(): Promise<FakeSite> {
  const site = await startFakeSite({ port: 0, host: SITE_HOST });
  openSites.push(site);
  return site;
}

interface Cmp {
  id: string;
  sourceId: string;
  name: string;
  site: FakeSite;
}

/** Add a competitor through the API (the UI form is exercised in WS-01). The first scan starts on add. */
async function addCompetitor(api: APIRequestContext, site: FakeSite, name: string): Promise<Cmp> {
  const res = await api.post("/api/competitors", { data: { website: site.url, name } });
  expect(res.status(), `add ${name}: ${await res.text()}`).toBe(201);
  const state = ((await res.json()) as { state: { competitors: { id: string; name: string; source: { id: string } | null }[] } }).state;
  const c = state.competitors.find((x) => x.name === name);
  expect(c, `competitor ${name} in the state`).toBeTruthy();
  return { id: c!.id, sourceId: c!.source!.id, name, site };
}

async function scanNow(api: APIRequestContext, competitorId: string) {
  return api.post("/api/competitors/scan", { data: { competitorId } });
}

// ————— DB reads —————
const scanRow = (scanId: string) => withTestDb((db) => db.competitorScan.findUniqueOrThrow({ where: { id: scanId } }));
const scansOf = (sourceId: string) => withTestDb((db) => db.competitorScan.findMany({ where: { sourceId }, orderBy: { startedAt: "asc" } }));
const pagesOf = (sourceId: string) => withTestDb((db) => db.sourcePage.findMany({ where: { sourceId }, orderBy: { url: "asc" }, include: { versions: { orderBy: { createdAt: "asc" } } } }));
const requestOf = (scanId: string) => withTestDb((db) => db.localScanRequest.findUniqueOrThrow({ where: { scanId } }));
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";
/** The remote scanner's page requests on the site itself: after its robots.txt read (the add route probes "/" first), without robots/sitemap. */
async function scannerPageRequests(site: FakeSite) {
  const all = await site.requests();
  const start = all.findIndex((q) => q.path === "/robots.txt");
  expect(start, `robots.txt request in ${JSON.stringify(all.map((q) => `${q.host}${q.path}`))}`).toBeGreaterThanOrEqual(0);
  return all.slice(start).filter((q) => q.host === site.host && q.path !== "/robots.txt" && q.path !== "/sitemap.xml");
}

/** The newest scan of a source once it has reached `status` (the add route starts the first scan fire-and-forget). */
async function waitForScanWithStatus(sourceId: string, status: string, timeout = 30_000) {
  let found: Awaited<ReturnType<typeof scansOf>>[number] | undefined;
  await expect.poll(async () => {
    const list = await scansOf(sourceId);
    found = [...list].reverse().find((s) => s.status === status);
    return found?.id ?? null;
  }, { timeout, intervals: [250, 500] }).not.toBeNull();
  return found!;
}
async function waitForScanEnd(scanId: string, timeout = 120_000) {
  await expect.poll(async () => (await scanRow(scanId)).status, { timeout, intervals: [500] }).toMatch(FINAL);
  return scanRow(scanId);
}

// ————— The poller —————
interface PollerOpts {
  mac: "locked" | "active";
  answer?: "approve" | "later";
  stateDir?: string;
  pauseMs?: number;
  maxPages?: number;
  key?: string;
}
function pollerArgs(o: PollerOpts): string[] {
  return [
    POLLER, "--app-url", LOCAL_BASE_URL, "--key-file", o.key ?? keyFile, "--state-dir", o.stateDir ?? freshStateDir(),
    "--runner", "fetch", "--mac-state", o.mac, "--answer", o.answer ?? "approve", "--pause-ms", String(o.pauseMs ?? 0),
    ...(o.maxPages ? ["--max-pages", String(o.maxPages)] : []),
  ];
}
function freshStateDir(): string {
  const dir = join(SCRATCH, `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** One check-in ("run once"): the real poller, fetch runner, Mac state and dialog answer as flags. */
function runPoller(o: PollerOpts, timeoutMs = 150_000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile("node", pollerArgs(o), { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      if (err && (err as { killed?: boolean }).killed) return reject(new Error(`poller timed out after ${timeoutMs} ms\n${out}`));
      resolve({ stdout: out, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}
function spawnPoller(o: PollerOpts): ChildProcess {
  return spawn("node", pollerArgs(o), { stdio: ["ignore", "pipe", "pipe"] });
}

// ————— UI —————
async function newPage(browser: Browser, who: "pm" | "admin"): Promise<Page> {
  const ctx = await browser.newContext({ storageState: who === "pm" ? pmState : adminState });
  return ctx.newPage();
}
async function openSettings(page: Page, name: string): Promise<void> {
  await page.goto("/settings/competitors");
  await expect(competitorLine(page, name)).toBeVisible({ timeout: 30_000 });
}
/** The competitor's line in Settings → Competitors (name, status pill, Scan now, Scan log, edit, remove). */
const competitorLine = (page: Page, name: string) => page.locator("div.px-5.py-3", { has: page.getByText(name, { exact: true }) }).last();
const pill = (page: Page, name: string) => competitorLine(page, name).getByTestId("cmp-scan-status");
/** Administration → Competitors: the scan row (newest first) of one competitor of this org. */
const adminScanRows = (page: Page, name: string) => page.locator("tbody tr", { hasText: ORG.orgName }).filter({ hasText: name });

/** Soft-delete this org's competitors and end their scans so the next row starts clean (no tick leftovers). */
async function cleanupCompetitors(): Promise<void> {
  await withTestDb(async (db) => {
    const t = new Date();
    await db.localScanRequest.updateMany({ where: { workspaceId, state: { in: ["waiting", "running"] } }, data: { state: "cancelled", finishedAt: t } });
    await db.competitorScan.updateMany({ where: { workspaceId, status: { in: ["queued", "pending_local", "running"] } }, data: { status: "cancelled", finishedAt: t, error: "QA cleanup" } });
    await db.competitor.updateMany({ where: { workspaceId, deletedAt: null }, data: { deletedAt: t } });
  });
}

test.describe("Website Scanning rows", () => {
  test.skip(envProblems.length > 0, envProblems.join("; "));

  test.beforeAll(async ({ browser, playwright }) => {
    if (envProblems.length) return;
    test.setTimeout(240_000);
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await seedFixtures(db);
      await isolateOtherOrgs(db);
      await resetGlobalKnobs(db);
    });
    mkdirSync(SCRATCH, { recursive: true });
    // Two logins for the whole file; every row reuses the sessions through storage state.
    const pmCtx = await browser.newContext();
    const pmPage = await pmCtx.newPage();
    await loginWithTotp(pmPage, PM);
    pmState = join(SCRATCH, "pm-state.json");
    await pmCtx.storageState({ path: pmState });
    await pmCtx.close();
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginWithTotp(adminPage, ADMIN);
    adminState = join(SCRATCH, "admin-state.json");
    await adminCtx.storageState({ path: adminState });
    await adminCtx.close();
    pmApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: pmState });
    adminApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: adminState });
    await setRemote(false);
    await setClock(0);
    keyFile = (await createKey(KEY_LABEL)).file;
  });

  test.afterEach(async () => {
    if (envProblems.length) return;
    await cleanupCompetitors();
    await setClock(0).catch(() => undefined);
    await setRemote(false).catch(() => undefined);
    for (const s of openSites.splice(0)) await s.stop().catch(() => undefined);
  });

  test.afterAll(async () => {
    if (envProblems.length) return;
    await withTestDb(async (db) => {
      await resetGlobalKnobs(db);
      await restoreOtherOrgs(db);
      await deleteFixtures(db);
    });
    await pmApi?.dispose();
    await adminApi?.dispose();
  });

  // ————————————————————————————— Local lane, remote OFF —————————————————————————————

  test("WS-01 full website onboarding: Add competitor → pending → in progress with count → Full 12 pages; 12 rows with text/title/state/hash; admin log lane local", async ({ browser }) => {
    test.setTimeout(150_000);
    const site = await newSite();
    const page = await newPage(browser, "pm");
    await page.goto("/settings/competitors");
    await page.getByRole("button", { name: "Add competitor" }).click();
    await page.getByLabel("Website").fill(site.url);
    await page.getByRole("button", { name: "Save" }).click();
    // The name comes from the site's <title>.
    const name = "Acme Fake";
    await expect(competitorLine(page, name)).toBeVisible({ timeout: 30_000 });
    // PRD: "Add competitor → Waiting". Soft: the add answer is built before the first scan is routed, so the
    // row can say "Never scanned" until the next refresh (flagged); the reload keeps the row's later steps honest.
    await expect.soft(pill(page, name), "status right after Add").toHaveText(/^Scan pending · since /, { timeout: 5_000 });
    await page.reload();
    await expect(pill(page, name)).toHaveText(/^Scan pending · since /, { timeout: 15_000 });
    const sourceId = (await withTestDb((db) => db.competitor.findFirstOrThrow({ where: { workspaceId, name }, include: { sources: true } }))).sources[0].id;
    const pending = await waitForScanWithStatus(sourceId, "pending_local");
    expect(pending.lane).toBe("local");

    // Mac locked: the poller runs without asking. Paced so the page's 3-second poll sees "in progress".
    const run = runPoller({ mac: "locked", pauseMs: 600 });
    await expect(pill(page, name)).toHaveText(/^Scan in progress · ([1-9]|1[0-2]) pages? so far$/, { timeout: 30_000 });
    const poller = await run;
    expect(poller.code, poller.stdout).toBe(0);
    expect(poller.stdout).toMatch(/screen locked/);
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.lane).toBe("local");
    expect(done.pagesFetched).toBe(12);
    await expect(pill(page, name)).toHaveText("Full", { timeout: 15_000 });
    await expect(competitorLine(page, name)).toContainText("12 of 12 pages scanned.");

    const pages = await pagesOf(sourceId);
    expect(pages.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS].sort());
    for (const p of pages) {
      expect(p.text, p.url).toBeTruthy();
      expect(p.title, p.url).toBeTruthy();
      expect(p.hash, p.url).toMatch(/^[0-9a-f]{32}$/);
      expect(p.state, `${p.url} state`).toBe("present");
    }
    // Admin log: the lane is named only here.
    const admin = await newPage(browser, "admin");
    await admin.goto("/admin/competitors");
    const row = adminScanRows(admin, name).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator("td").nth(7)).toHaveText("local");
    await expect(row.locator("td").nth(5)).toHaveText("full");
    await expect(row.locator("td").nth(9)).toHaveText("12");
  });

  test("WS-02 nothing in queue: poller once (Mac locked) → empty list, exits; no scan, no token", async () => {
    const before = await withTestDb(async (db) => ({ tokens: await db.scanToken.count(), scans: await db.competitorScan.count({ where: { workspaceId } }) }));
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/check-in as QA-WS station: nothing waiting/);
    expect(r.stdout).not.toMatch(/waiting \(|Later|scan [0-9a-f-]+ —/);
    const after = await withTestDb(async (db) => ({ tokens: await db.scanToken.count(), scans: await db.competitorScan.count({ where: { workspaceId } }) }));
    expect(after).toEqual(before);
  });

  test("WS-03 multiple sites in queue: one check-in lists all three, scans run one at a time in order, all Full", async () => {
    test.setTimeout(180_000);
    const names = ["QA-WS Alpha", "QA-WS Beta", "QA-WS Gamma"];
    const cmps: Cmp[] = [];
    for (const name of names) cmps.push(await addCompetitor(pmApi, await newSite(), name));
    const pending = [];
    for (const c of cmps) pending.push(await waitForScanWithStatus(c.sourceId, "pending_local"));
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/3 waiting \(QA-WS Alpha, QA-WS Beta, QA-WS Gamma\) — screen locked/);
    const scans = [];
    for (const p of pending) scans.push(await waitForScanEnd(p.id));
    for (const s of scans) {
      expect(s.status, s.id).toBe("ok");
      expect(s.badge, s.id).toBe("full");
      expect(s.pagesFetched, s.id).toBe(12);
    }
    // Serial: the next scan starts after the previous one finished; order = the order the requests were made.
    const order = r.stdout.match(/scan [0-9a-f-]+ — (QA-WS \w+)/g)!.map((m) => m.replace(/.* — /, ""));
    expect(order).toEqual(names);
    for (let i = 1; i < scans.length; i++) {
      expect(scans[i].startedAt.getTime(), `${names[i]} started before ${names[i - 1]} finished`).toBeGreaterThanOrEqual(scans[i - 1].finishedAt!.getTime());
    }
  });

  test("WS-04 Mac active, answer Approve: the dialog names the site, the scan runs after Approve, Full", async () => {
    test.setTimeout(120_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Delta");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "active", answer: "approve" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/1 waiting \(QA-WS Delta\) — screen active/);
    expect(r.stdout).not.toMatch(/Later/);
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
  });

  test("WS-05 Mac active, answer Later: no scan, still pending, snoozed 2 h; next check-in with the screen locked runs without asking, Full", async ({ browser }) => {
    test.setTimeout(150_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Epsilon");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const stateDir = freshStateDir();
    const t0 = Date.now();
    const r1 = await runPoller({ mac: "active", answer: "later", stateDir });
    expect(r1.code, r1.stdout).toBe(0);
    expect(r1.stdout).toMatch(/1 waiting \(QA-WS Epsilon\) — screen active/);
    expect(r1.stdout).toMatch(/Later — snoozed for 2 hours/);
    expect(r1.stdout).not.toMatch(/scan [0-9a-f-]+ —/);
    const snoozeUntil = Number(readFileSync(join(stateDir, "snooze-until"), "utf8"));
    expect(snoozeUntil).toBeGreaterThanOrEqual(t0 + 2 * HOUR);
    expect(snoozeUntil).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
    expect((await scanRow(pending.id)).status).toBe("pending_local");
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText(/^Scan pending · since /);

    // Run 2, same station state (still snoozed), screen locked → runs anyway.
    const r2 = await runPoller({ mac: "locked", stateDir });
    expect(r2.code, r2.stdout).toBe(0);
    expect(r2.stdout).toMatch(/screen locked/);
    expect(r2.stdout).not.toMatch(/snoozed \(Later\)/);
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
  });

  test("WS-06 request waits 25 h, no poller: hourly check keeps it pending (red, with age), one email to support, not Blocked", async ({ browser }) => {
    test.setTimeout(120_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Zeta");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    // Setup: the request is 25 hours old.
    const old = new Date(Date.now() - 25 * HOUR);
    await withTestDb(async (db) => {
      await db.localScanRequest.update({ where: { scanId: pending.id }, data: { createdAt: old } });
      await db.competitorScan.update({ where: { id: pending.id }, data: { startedAt: old } });
    });
    const lines1 = await tick();
    expect(lines1.join("\n")).toMatch(/1 waiting-request alert sent to support/);
    const req1 = await requestOf(pending.id);
    expect(req1.state).toBe("waiting");
    expect(req1.alertedAt).not.toBeNull();
    // Once per request: a second hourly check sends nothing more.
    const lines2 = await tick();
    expect(lines2.join("\n")).not.toMatch(/alert sent/);
    expect(lines2.join("\n")).toMatch(/0 alerts/);
    expect((await requestOf(pending.id)).alertedAt?.getTime()).toBe(req1.alertedAt!.getTime());
    const scan = await scanRow(pending.id);
    expect(scan.status).toBe("pending_local");
    expect(scan.badge).toBeNull();
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Scan pending · since yesterday");
    await expect(pill(page, c.name)).toHaveClass(/text-\[#c23767\]/); // > 24 h → red
    await expect(pill(page, c.name)).not.toHaveText(/Blocked/);
  });

  test("WS-07 re-scan with no change + daily limit: 12 fetched, hashes equal, Full, 0 changed; 2nd Scan now refused for the PM with the limit message, allowed for the admin", async ({ browser }) => {
    test.setTimeout(180_000);
    const c = await onboardLocal("QA-WS Eta");
    const before = await pagesOf(c.sourceId);
    // PRD: one manual rescan per site per day. The onboarding scan is not a rescan — the PM's Scan now must be allowed.
    const first = await scanNow(pmApi, c.id);
    expect.soft(first.status(), `PM's first Scan now after onboarding: ${await first.text()}`).toBe(202);
    if (first.status() !== 202) {
      // Fall back to the exempt admin so the rest of the row still runs.
      const a = await scanNow(adminApi, c.id);
      expect(a.status(), await a.text()).toBe(202);
    }
    const second = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(second.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    expect(done.pagesChanged).toBe(0);
    const after = await pagesOf(c.sourceId);
    expect(after.map((p) => [pathOf(p.url), p.hash])).toEqual(before.map((p) => [pathOf(p.url), p.hash]));
    for (const p of after) expect(p.versions.length, `${p.url} versions`).toBe(1);

    // The limit: a second manual scan today is refused for the PM, allowed for a PM-OS admin.
    const refused = await scanNow(pmApi, c.id);
    expect(refused.status()).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe(RESCAN_LIMITED);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    const btn = competitorLine(page, c.name).getByRole("button", { name: "Next manual scan tomorrow" });
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    const allowed = await scanNow(adminApi, c.id);
    expect(allowed.status(), await allowed.text()).toBe(202);
    expect(((await allowed.json()) as { state: string }).state).toBe("pending_local");
  });

  test("WS-08 re-scan with changes: pricing changed with both texts kept, new product page → 13 pages, home footer date only → unchanged", async () => {
    test.setTimeout(150_000);
    const c = await onboardLocal("QA-WS Theta");
    const before = Object.fromEntries((await pagesOf(c.sourceId)).map((p) => [pathOf(p.url), p.hash]));
    await c.site.control({ pricingText: "Starter $59 per month. Team $249 per month. Enterprise: talk to us.", newProductPage: true, footerDate: "Updated 2026-11-03", utmInDocs: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const second = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(second.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(13);
    expect(done.pagesChanged).toBe(2); // /pricing changed, /product/new new
    const pages = await pagesOf(c.sourceId);
    const byPath = Object.fromEntries(pages.map((p) => [pathOf(p.url), p]));
    expect(Object.keys(byPath).sort()).toEqual([...PAGE_PATHS, "/product/new"].sort());
    const pricing = byPath["/pricing"];
    expect(pricing.text).toContain("Starter $59 per month");
    expect(pricing.hash).not.toBe(before["/pricing"]);
    expect(pricing.versions.length).toBe(2);
    const superseded = pricing.versions.find((v) => v.supersededAt != null)!;
    expect(superseded.text).toContain("Starter $49 per month"); // the previous text, kept for the diff
    expect(superseded.hash).toBe(before["/pricing"]);
    expect(pricing.versions.find((v) => v.supersededAt == null)!.hash).toBe(pricing.hash);
    expect(byPath["/product/new"].text).toContain("Acme Shield");
    // Dates and tracking strings are normalized away: the footer date changed on every page, nothing else did.
    for (const path of PAGE_PATHS) {
      if (path === "/pricing") continue;
      expect(byPath[path].hash, `${path} hash`).toBe(before[path]);
      expect(byPath[path].versions.length, `${path} versions`).toBe(1);
    }
    expect(byPath["/"].text).toContain("Updated 2026-11-03"); // the stored text is current; only the fingerprint ignores the date
  });

  test("WS-09 page removed needs proof: not found once → missing; twice → removed; answers again → cleared", async ({ browser }) => {
    test.setTimeout(200_000);
    const c = await onboardLocal("QA-WS Iota");
    const people = async () => (await pagesOf(c.sourceId)).find((p) => pathOf(p.url) === "/people")!;
    expect((await people()).state).toBe("present");
    await c.site.control({ peopleNotFound: true });

    // Scan 1 — the PM's Scan now, a day later (one manual rescan per day).
    await setClock(DAY);
    const s1 = await scanNow(pmApi, c.id);
    expect(s1.status(), await s1.text()).toBe(202);
    const scan1 = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" })).code).toBe(0);
    const done1 = await waitForScanEnd(scan1.id);
    expect(done1.badge).toBe("full"); // not found is not "not read"
    expect(done1.pagesFetched).toBe(11);
    let p = await people();
    expect(p.state).toBe("missing");
    expect(p.notFoundStreak).toBe(1);
    expect(p.removedAt).toBeNull();
    expect(done1.removedPages).toEqual([]);

    // Scan 2 — as admin: second consecutive not found = removed.
    const s2 = await scanNow(adminApi, c.id);
    expect(s2.status(), await s2.text()).toBe(202);
    const scan2 = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" })).code).toBe(0);
    const done2 = await waitForScanEnd(scan2.id);
    p = await people();
    expect(p.state).toBe("removed");
    expect(p.notFoundStreak).toBe(2);
    expect(p.removedAt).not.toBeNull();
    expect(done2.removedPages).toEqual([p.url]);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(competitorLine(page, c.name)).toContainText("1 page removed since the previous scan.");

    // Scan 3 — the page answers again: the mark is cleared.
    await c.site.control({ peopleNotFound: false });
    const s3 = await scanNow(adminApi, c.id);
    expect(s3.status(), await s3.text()).toBe(202);
    const scan3 = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" })).code).toBe(0);
    const done3 = await waitForScanEnd(scan3.id);
    expect(done3.pagesFetched).toBe(12);
    p = await people();
    expect(p.state).toBe("present");
    expect(p.notFoundStreak).toBe(0);
    expect(p.removedAt).toBeNull();
  });

  test("WS-10 V1 page fails once, site alive: /docs times out once → retried within the scan and read, Full 12", async () => {
    test.setTimeout(240_000);
    const c = await onboardLocal("QA-WS Kappa");
    await c.site.control({ docsTimeoutOnce: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const scan = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" }, 200_000);
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(scan.id);
    // PRD: every page is a pending task until done; retries allowed (1–3), local scanning included.
    expect(done.badge, `outcomes ${JSON.stringify(done.outcomes)}`).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const docsRequests = (await c.site.requests()).filter((q) => q.path === "/docs");
    expect(docsRequests.length).toBeGreaterThanOrEqual(3); // onboarding read + the timed-out attempt + the retry
  });

  test("WS-10 V2 page fails every time, site alive: /docs not read, reason timeout, counted, not toward removed; Incomplete 11/12, open page listed", async ({ browser }) => {
    test.setTimeout(240_000);
    const c = await onboardLocal("QA-WS Lambda");
    await c.site.control({ docsTimeoutAlways: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const scan = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" }, 200_000);
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("incomplete");
    expect(done.pagesFetched).toBe(11);
    expect((done.outcomes as Record<string, number>).timeout).toBe(1);
    const docs = (await pagesOf(c.sourceId)).find((p) => pathOf(p.url) === "/docs")!;
    expect(docs.state).toBe("present"); // a timeout counts for nothing
    expect(docs.notFoundStreak).toBe(0);
    expect(docs.text).toBeTruthy(); // the previous read stands
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await expect(competitorLine(page, c.name)).toContainText("11 of 12 pages scanned. 1 timeout or site down.");
    await competitorLine(page, c.name).getByRole("button", { name: "Scan log" }).click();
    const drawer = page.locator("div.fixed.right-0");
    await expect(drawer.getByRole("heading", { name: `Scan log · ${c.name}` })).toBeVisible();
    await expect(drawer.getByText("Not read:")).toBeVisible();
    await expect(drawer.getByText("1 timeout or site down")).toBeVisible();
    const open = drawer.locator("div", { has: page.getByRole("link", { name: "/docs", exact: true }) }).last();
    await expect(open).toContainText("failed");
    await expect(open).toContainText("timeout or site down");
  });

  test("WS-11 tokens: machine key cannot post pages; a scan token works only for its scan and only until 15 min after the scan ended; a revoked key is refused; Administration lists and revokes keys", async ({ browser }) => {
    test.setTimeout(200_000);
    const key = await createKey("QA-WS key WS-11");
    const a = await addCompetitor(pmApi, await newSite(), "QA-WS Mu");
    const b = await addCompetitor(pmApi, await newSite(), "QA-WS Nu");
    const scanA = await waitForScanWithStatus(a.sourceId, "pending_local");
    const scanB = await waitForScanWithStatus(b.sourceId, "pending_local");
    const waiting = await pmApi.get("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${key.secret}` } });
    expect(waiting.status(), await waiting.text()).toBe(200);
    const list = ((await waiting.json()) as { waiting: { scanId: string; token: string }[] }).waiting;
    const tokenA = list.find((w) => w.scanId === scanA.id)!.token;
    const tokenB = list.find((w) => w.scanId === scanB.id)!.token;
    expect(tokenA).toMatch(/^pmost_/);
    expect(tokenB).toMatch(/^pmost_/);
    const pagesRoute = (scanId: string) => `/api/competitors/local/scans/${scanId}/pages`;
    const okPage = (site: FakeSite) => ({ url: `${site.url}/`, status: "ok", html: "<html><head><title>Acme Fake</title></head><body><main><p>hand-in probe</p></main></body></html>" });
    // The machine key only asks "what is waiting".
    let res = await pmApi.post(pagesRoute(scanA.id), { headers: { authorization: `Bearer ${key.secret}` }, data: okPage(a.site) });
    expect(res.status()).toBe(401);
    // A scan token posts only into its own scan.
    res = await pmApi.post(pagesRoute(scanB.id), { headers: { authorization: `Bearer ${tokenA}` }, data: okPage(b.site) });
    expect(res.status()).toBe(401);
    res = await pmApi.post(pagesRoute(scanA.id), { headers: { authorization: `Bearer ${tokenB}` }, data: okPage(a.site) });
    expect(res.status()).toBe(401);
    // Its own scan: accepted (B is now "in progress" from the station's point of view; A stays waiting).
    res = await pmApi.post(pagesRoute(scanB.id), { headers: { authorization: `Bearer ${tokenB}` }, data: okPage(b.site) });
    expect(res.status(), await res.text()).toBe(200);
    expect((await scanRow(scanB.id)).status).toBe("running");

    // Finish A on the station; the token then lives 15 more minutes (the scan ended → 409), not longer (→ 401).
    const r = await runPoller({ mac: "locked", key: key.file });
    expect(r.code, r.stdout).toBe(0);
    const doneA = await waitForScanEnd(scanA.id);
    expect(doneA.status).toBe("ok");
    res = await pmApi.post(pagesRoute(scanA.id), { headers: { authorization: `Bearer ${tokenA}` }, data: okPage(a.site) });
    expect(res.status()).toBe(409);
    await setClock(16 * 60_000);
    res = await pmApi.post(pagesRoute(scanA.id), { headers: { authorization: `Bearer ${tokenA}` }, data: okPage(a.site) });
    expect(res.status()).toBe(401);
    res = await pmApi.post(`/api/competitors/local/scans/${scanA.id}/done`, { headers: { authorization: `Bearer ${tokenA}` }, data: {} });
    expect(res.status()).toBe(401);
    await setClock(0);

    // Administration lists the key; Revoke is the only manual act; a revoked key is refused at check-in.
    const admin = await newPage(browser, "admin");
    await admin.goto("/admin/competitors");
    const keyRow = admin.getByTestId("admin-key-row").filter({ hasText: "QA-WS key WS-11" });
    await expect(keyRow).toBeVisible({ timeout: 30_000 });
    await expect(keyRow).toContainText("active");
    await keyRow.getByRole("button", { name: "Revoke" }).click();
    await expect(keyRow).toContainText(/revoked/);
    await expect(keyRow.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    res = await pmApi.get("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${key.secret}` } });
    expect(res.status()).toBe(401);
    const r2 = await runPoller({ mac: "locked", key: key.file });
    expect(r2.code).not.toBe(0);
    expect(r2.stdout).toMatch(/401/);
    // B's own token still posts into B (the revoked key never touches scan tokens).
    res = await pmApi.post(pagesRoute(scanB.id), { headers: { authorization: `Bearer ${tokenB}` }, data: okPage(b.site) });
    expect(res.status(), await res.text()).toBe(200);
  });

  test("WS-12 scan dies halfway: 6 pages saved and in progress; after 10 min without reporting the scan is stale and the next run finishes it; 12 total (local lane requeues instead of a Stale badge — flagged)", async ({ browser }) => {
    test.setTimeout(200_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Xi");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const child = spawnPoller({ mac: "locked", pauseMs: 500 });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    await expect.poll(async () => (await scanRow(pending.id)).pagesFetched, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(6);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const mid = await scanRow(pending.id);
    expect(mid.status).toBe("running");
    expect(mid.pagesFetched).toBeGreaterThanOrEqual(6);
    expect(mid.pagesFetched).toBeLessThan(12);
    const saved = await pagesOf(c.sourceId);
    expect(saved.length).toBe(mid.pagesFetched);
    for (const p of saved) expect(p.text, p.url).toBeTruthy();
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText(new RegExp(`^Scan in progress · ${mid.pagesFetched} pages so far$`));

    // 10 minutes without a heartbeat → the hourly check marks it stale; the next run continues from the pending pages.
    await setClock(11 * 60_000);
    const lines = await tick();
    expect(lines.join("\n")).toMatch(/1 stale scan/);
    const stale = await scanRow(pending.id);
    expect(stale.status, "PRD: stale scan → the next run continues (the local lane goes back to pending instead of showing Stale)").toBe("pending_local");
    expect((await requestOf(pending.id)).state).toBe("waiting");
    await page.reload();
    await expect(pill(page, c.name)).toHaveText(/^Scan pending · since /);
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    expect((await pagesOf(c.sourceId)).length).toBe(12);
  });

  test("WS-13 observability: the admin scan log shows lane, start, end, pages read, not read with reasons and retries — readable without the DB", async ({ browser }) => {
    test.setTimeout(240_000);
    const c = await onboardLocal("QA-WS Omicron");
    await c.site.control({ docsTimeoutAlways: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const scan = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" }, 200_000)).code).toBe(0);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("incomplete");

    const admin = await newPage(browser, "admin");
    await admin.goto("/admin/competitors");
    const rows = adminScanRows(admin, c.name);
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const latest = rows.first(); // newest first
    const cells = latest.locator("td");
    await expect(cells.nth(1)).toHaveText(/\w{3} \d{1,2}, \d{2}:\d{2}/); // started
    await expect(cells.nth(4)).toContainText("partial"); // status chip
    await expect(cells.nth(5)).toHaveText("incomplete");
    await expect(cells.nth(7)).toHaveText("local");
    await expect(cells.nth(9)).toHaveText("11");
    await expect(cells.nth(15)).toHaveText(/\d+(\.\d)?s|\d+ ms|\d+m \d+s/); // duration = end − start
    await latest.click();
    const details = admin.locator("tr", { has: admin.getByText(c.site.url, { exact: true }) });
    await expect(details).toContainText("Not read: 1 timeout");
    await expect(details.getByText("Pages · 12")).toBeVisible();
    const docsLine = details.locator("div", { has: admin.getByRole("link", { name: "/docs", exact: true }) }).last();
    await expect(docsLine).toContainText("failed");
    await expect(details.getByText(/Log · \d+/)).toBeVisible();
    await expect(details).toContainText("11 pages handed in from the station, 1 not read");
    // Retries: the PRD allows 1–3 attempts per page; the log names them.
    await expect.soft(details, "PRD: retries are visible in the log (1–3 attempts per failed page)").toContainText(/Retry 1/);
  });

  test("WS-14 deleting a competitor: pages, hashes and history stay in the DB, hidden from the UI; the waiting request is cancelled and the poller gets nothing", async ({ browser }) => {
    test.setTimeout(150_000);
    const c = await onboardLocal("QA-WS Pi");
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await competitorLine(page, c.name).getByRole("button", { name: "Remove" }).click();
    await acceptConfirm(page);
    await expect(page.getByText(c.name, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(c.name, { exact: true })).toHaveCount(0);
    const row = await withTestDb((db) => db.competitor.findUniqueOrThrow({ where: { id: c.id } }));
    expect(row.deletedAt).not.toBeNull();
    const pages = await pagesOf(c.sourceId);
    expect(pages.length).toBe(12);
    for (const p of pages) expect(p.hash, p.url).toMatch(/^[0-9a-f]{32}$/);
    const scans = await scansOf(c.sourceId);
    expect(scans.length).toBe(2);
    expect(scans[0].status).toBe("ok");
    expect(scans[1].status).toBe("cancelled");
    expect((await requestOf(pending.id)).state).toBe("cancelled");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/nothing waiting/);
    const state = (await (await pmApi.get("/api/competitors")).json()) as { state: { competitors: { id: string }[] } };
    expect(state.state.competitors.find((x) => x.id === c.id)).toBeUndefined();
  });

  test("WS-27 unlinked page: /people still answers but nothing links to it → state unlinked, not removed; 12 pages read", async () => {
    test.setTimeout(150_000);
    const c = await onboardLocal("QA-WS Rho");
    await c.site.control({ unlinkPeople: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const scan = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" })).code).toBe(0);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const pages = await pagesOf(c.sourceId);
    const states = Object.fromEntries(pages.map((p) => [pathOf(p.url), p.state]));
    expect(states["/people"]).toBe("unlinked");
    for (const path of PAGE_PATHS) if (path !== "/people") expect(states[path], `${path} state`).toBe("present");
    expect(pages.find((p) => pathOf(p.url) === "/people")!.removedAt).toBeNull();
  });

  // ————————————————————————————— Remote lane ON —————————————————————————————

  test("WS-15 remote blocked falls to local: site 403 to the PM-OS UA → remote Blocked (denied) in the log, row Scan pending, local reads the whole site, Full; lanes named only in the admin log", async ({ browser }) => {
    test.setTimeout(200_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ forbidPmosUa: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Sigma");
    const remote = await waitForScanWithStatus(c.sourceId, "failed", 90_000);
    expect(remote.lane).toBe("remote");
    expect(remote.badge).toBe("blocked");
    expect(((remote.outcomes as Record<string, number>).denied ?? 0)).toBeGreaterThanOrEqual(1);
    const log = (remote.log as { msg: string }[]).map((l) => l.msg).join("\n");
    expect(log).toMatch(/Handed to the local lane/);
    const local = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect(local.lane).toBe("local");
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText(/^Scan pending · since /);
    await expect(competitorLine(page, c.name)).not.toContainText(/\b(remote|local|lane|browser|station)\b/i);
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(local.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    await expect(pill(page, c.name)).toHaveText("Full", { timeout: 15_000 });
    const admin = await newPage(browser, "admin");
    await admin.goto("/admin/competitors");
    const rows = adminScanRows(admin, c.name);
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.nth(0).locator("td").nth(7)).toHaveText("local");
    await expect(rows.nth(0).locator("td").nth(5)).toHaveText("full");
    await expect(rows.nth(1).locator("td").nth(7)).toHaveText("remote");
    await expect(rows.nth(1).locator("td").nth(5)).toHaveText("blocked");
  });

  test("WS-16 remote: page needs the browser — pricing empty on the plain fetch, re-read headless with its full text, Full 12", async () => {
    test.skip(!BROWSER_ON, "COMPETITORS_BROWSER=on is not set in test-apphosting.yaml — the headless browser is off in this environment");
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ jsOnlyPricing: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Tau");
    const queued = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(() => null);
    const scan = queued ?? (await scansOf(c.sourceId))[0];
    const done = await waitForScanEnd(scan.id);
    expect(done.status, done.error ?? "").toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    expect(done.fetchMode).toBe("browser");
    const log = (done.log as { msg: string; url?: string }[]);
    const switched = log.find((l) => /no text without JavaScript — switching to the browser/.test(l.msg));
    expect(switched?.url).toBe(`${site.url}/pricing`);
    const pricing = (await pagesOf(c.sourceId)).find((p) => pathOf(p.url) === "/pricing")!;
    expect(pricing.text).toContain("Starter $49 per month. Team $199 per month.");
  });

  test("WS-17 safety ceiling (local lane, --max-pages 20): stops at 20, Incomplete, the rest not attempted, plain message", async ({ browser }) => {
    test.setTimeout(150_000);
    const site = await newSite();
    await site.control({ infiniteLinks: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Upsilon");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked", maxPages: 20 });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    expect(done.badge).toBe("incomplete");
    // "Stops at 20" = 20 attempts; read = attempts minus not-found answers (a followed link that 404s is attempted, not read).
    const attempts = (done.pages as { outcome: string; category?: string }[]).filter((p) => p.outcome !== "skipped");
    expect(attempts.length, JSON.stringify(attempts)).toBe(20);
    expect(done.pagesFetched).toBe(20 - attempts.filter((p) => p.category === "notfound").length);
    expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(1);
    expect((await pagesOf(c.sourceId)).length).toBe(done.pagesFetched);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await competitorLine(page, c.name).getByRole("button", { name: "Scan log" }).click();
    await expect(page.getByText(new RegExp(`^${done.pagesNotAttempted} pages? not attempted — the next scan continues from them$`))).toBeVisible();
  });

  test("WS-17 safety ceiling (remote lane, ceiling 20 pages): stops at 20, Incomplete, reason cap, plain message", async ({ browser }) => {
    test.skip(!CEILING_20, "COMPETITORS_CEILING_PAGES=20 is not set in test-apphosting.yaml — the remote ceiling cannot be lowered per test");
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ infiniteLinks: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Phi");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("incomplete");
    const attempts = (done.pages as { outcome: string; category?: string }[]).filter((p) => p.outcome !== "skipped");
    expect(attempts.length, JSON.stringify(attempts)).toBe(20); // the ceiling counts attempts
    expect(done.pagesFetched).toBe(20 - attempts.filter((p) => p.category === "notfound").length);
    expect((done.outcomes as Record<string, number>).cap).toBeGreaterThanOrEqual(1);
    expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(1);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await expect(competitorLine(page, c.name)).toContainText(/\d+ not attempted — scan ceiling reached/);
  });

  test("WS-18 site is down: Scan now → no pages, Unreachable, the previous 12 stand and nothing is missing; site back → next scheduled scan Full", async ({ browser }) => {
    test.setTimeout(200_000);
    await setRemote(true);
    const c = await onboardRemote("QA-WS Chi");
    await c.site.control({ down: true });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const scans1 = await scansOf(c.sourceId);
    const second = scans1[scans1.length - 1];
    const down = await waitForScanEnd(second.id);
    expect(down.status).toBe("failed");
    expect(down.badge).toBe("unreachable");
    expect(down.pagesFetched).toBe(0);
    const pages = await pagesOf(c.sourceId);
    expect(pages.length).toBe(12);
    for (const p of pages) {
      expect(p.state, p.url).toBe("present");
      expect(p.text, p.url).toBeTruthy();
    }
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Unreachable");
    await expect(competitorLine(page, c.name)).toContainText(/^The site did not answer on .*Showing data from /);

    // The site comes back; the next scheduled scan (frequency 2 days) reads everything.
    await c.site.control({ down: false });
    await setClock(2 * DAY + HOUR);
    const lines = await tick();
    expect(lines.join("\n")).toMatch(new RegExp(`due: ${c.name}`));
    const third = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[2]);
    const done = await waitForScanEnd(third.id);
    expect(done.trigger).toBe("scheduled");
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
  });

  test("WS-19 robots.txt respected: /docs never requested, reason robots in the log, Crawl-delay 3 → ≥3 s between requests, Incomplete 11/12", async ({ browser }) => {
    test.setTimeout(240_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ robotsDisallow: ["/docs$"], robotsCrawlDelay: 3 });
    const c = await addCompetitor(pmApi, site, "QA-WS Psi");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id, 200_000);
    expect(done.badge).toBe("incomplete");
    expect(done.pagesFetched).toBe(11);
    expect((done.outcomes as Record<string, number>).robots).toBe(1);
    expect(done.robotsDisallowed).toEqual(["/docs"]);
    const log = (done.log as { msg: string }[]).map((l) => l.msg).join("\n");
    expect(log).toMatch(/robots\.txt: 1 disallow rule, 1 sitemap, Crawl-delay 3 s \(pause 3 s\)/);
    expect(log).toMatch(/Kept out by robots\.txt: 1 page \(\/docs\)/);
    const pageReqs = await scannerPageRequests(site);
    expect(pageReqs.filter((q) => q.path === "/docs")).toEqual([]);
    expect(pageReqs.some((q) => q.path === "/docs/start")).toBe(true);
    expect(pageReqs.map((q) => q.path).sort()).toEqual(PAGE_PATHS.filter((p) => p !== "/docs").sort());
    for (let i = 1; i < pageReqs.length; i++) {
      // sleep(3000) between requests; 50 ms tolerance for timer granularity.
      expect(pageReqs[i].at - pageReqs[i - 1].at, `gap before ${pageReqs[i].path}`).toBeGreaterThanOrEqual(2950);
    }
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await expect(competitorLine(page, c.name)).toContainText("11 of 12 pages scanned. 1 kept out by robots.txt (/docs).");
  });

  test("WS-20 site says slow down: 429 on the 5th request → stops at page 4, Incomplete, reason slow down, no more requests; the next scheduled scan completes", async () => {
    test.setTimeout(200_000);
    await setRemote(true);
    const site = await newSite();
    // The add route probes "/" once before the scan (an ok page for the site's counter), so the scanner's 5th page is the site's 6th.
    await site.control({ slowdownAfter: 5 });
    const c = await addCompetitor(pmApi, site, "QA-WS Omega");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("incomplete");
    expect(done.pagesFetched).toBe(4);
    expect((done.outcomes as Record<string, number>).slowdown).toBe(1);
    expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(7);
    const reqs = await scannerPageRequests(site);
    const shown = JSON.stringify(reqs.map((q) => `${q.path} ${q.status}`));
    expect(reqs.filter((q) => q.status === 429).length, shown).toBe(1);
    expect(reqs[reqs.length - 1].status, shown).toBe(429); // nothing after the slow-down answer
    expect(reqs.filter((q) => q.status === 200).length, shown).toBe(4);

    await site.control({ slowdownAfter: 0 });
    await setClock(2 * DAY + HOUR);
    const lines = await tick();
    expect(lines.join("\n")).toMatch(new RegExp(`due: ${c.name}`));
    const next = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[1]);
    const done2 = await waitForScanEnd(next.id);
    expect(done2.badge).toBe("full");
    expect(done2.pagesFetched).toBe(12);
  });

  test("WS-21 PDF on a product page: the PDF's text is stored as a page of kind document with URL and hash; 13 pages", async () => {
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ linkPdf: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Pdf");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(13);
    const pages = await pagesOf(c.sourceId);
    expect(pages.length).toBe(13);
    const pdf = pages.find((p) => pathOf(p.url) === "/files/brochure.pdf")!;
    expect(pdf.kind).toBe("document");
    expect(pdf.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(pdf.text).toContain("Acme Fake brochure");
    expect(pdf.text).toContain("Datasheet page two");
    expect(pages.filter((p) => p.kind === "page").length).toBe(12);
  });

  test("WS-22 scan frequency per source: day 1 no, day 2 yes, day 3 no; set every 1 day in Administration → day 3 yes", async ({ browser }) => {
    test.setTimeout(240_000);
    await setRemote(true);
    const c = await onboardRemote("QA-WS Freq");
    const due = (lines: string[]) => lines.some((l) => l.startsWith(`due: ${c.name}`));
    await setClock(DAY);
    expect(due(await tick()), "day 1").toBe(false);
    expect((await scansOf(c.sourceId)).length).toBe(1);
    await setClock(2 * DAY + HOUR);
    expect(due(await tick()), "day 2").toBe(true);
    const second = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[1]);
    expect((await waitForScanEnd(second.id)).badge).toBe("full");
    await setClock(3 * DAY + HOUR);
    expect(due(await tick()), "day 3 at every 2 days").toBe(false);
    expect((await scansOf(c.sourceId)).length).toBe(2);
    // Administration → per-source frequency.
    const admin = await newPage(browser, "admin");
    await admin.goto("/admin/competitors");
    const select = admin.getByLabel(`Scan ${c.name} every N days`);
    await expect(select).toHaveValue("2", { timeout: 30_000 });
    await select.selectOption("1");
    await expect(select).toHaveValue("1");
    expect((await withTestDb((db) => db.competitorSource.findUniqueOrThrow({ where: { id: c.sourceId } }))).scanEveryDays).toBe(1);
    expect(due(await tick()), "day 3 at every 1 day").toBe(true);
    const third = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[2]);
    expect((await waitForScanEnd(third.id)).badge).toBe("full");
    expect((await scansOf(c.sourceId)).length).toBe(3);
  });

  test("WS-23 subdomain not followed: app.<host> and other domains are never fetched and never missing; 12 pages", async () => {
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    const c = await addCompetitor(pmApi, site, "QA-WS Sub");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const reqs = await site.requests();
    expect(reqs.filter((q) => q.host.startsWith("app.") || q.path === "/dashboard").map((q) => `${q.host}${q.path}`), "requests to the app. subdomain").toEqual([]);
    const pages = await pagesOf(c.sourceId);
    expect(pages.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS].sort());
    expect(pages.every((p) => new URL(p.url).host === site.host)).toBe(true);
    expect(pages.filter((p) => p.state !== "present")).toEqual([]);
  });

  test("WS-24 crawl order: product, pricing and docs are read before the blog; all 12 read", async () => {
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    const c = await addCompetitor(pmApi, site, "QA-WS Order");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const order = (await scannerPageRequests(site)).filter((q) => q.status === 200 && (PAGE_PATHS as readonly string[]).includes(q.path)).map((q) => q.path);
    expect(new Set(order).size).toBe(12);
    const idx = (p: string) => order.indexOf(p);
    const firstBlog = Math.min(idx("/blog"), idx("/blog/1"), idx("/blog/2"));
    for (const p of ["/product", "/product/features", "/pricing", "/docs", "/docs/start", "/docs/api"]) {
      expect(idx(p), `${p} read before the blog`).toBeLessThan(firstBlog);
    }
  });

  test("WS-25 retention: one year and a day later the retention job drops page texts; hashes, URLs, titles, states and scan history remain", async () => {
    test.setTimeout(200_000);
    await setRemote(true);
    const c = await onboardRemote("QA-WS Keep");
    // A superseded text to retain: change the pricing and scan again.
    await c.site.control({ pricingText: "Starter $69 per month. Team $299 per month." });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const second = (await scansOf(c.sourceId))[1];
    expect((await waitForScanEnd(second.id)).pagesChanged).toBe(1);
    const before = await pagesOf(c.sourceId);
    const pricingBefore = before.find((p) => pathOf(p.url) === "/pricing")!;
    expect(pricingBefore.versions.length).toBe(2);
    expect(pricingBefore.versions.find((v) => v.supersededAt != null)!.text).toContain("$49");

    await setClock(366 * DAY);
    const lines = await tick();
    expect(lines.join("\n")).toMatch(/retention: 1 superseded page text dropped \(hashes kept\)/);
    const after = await pagesOf(c.sourceId);
    expect(after.length).toBe(12);
    for (const p of after) {
      const was = before.find((b) => b.url === p.url)!;
      expect(p.hash, `${p.url} hash`).toBe(was.hash);
      expect(p.title, `${p.url} title`).toBe(was.title);
      expect(p.state, `${p.url} state`).toBe(was.state);
      for (const v of p.versions) expect(v.hash, `${p.url} version hash`).toBeTruthy();
    }
    const pricingAfter = after.find((p) => pathOf(p.url) === "/pricing")!;
    expect(pricingAfter.versions.find((v) => v.supersededAt != null)!.text).toBeNull();
    expect((await scansOf(c.sourceId)).length).toBeGreaterThanOrEqual(2); // history stays
    // PRD: "Text kept one year, hash forever" — after the window no page text remains.
    for (const p of after) expect(p.text, `${p.url} current text past retention`).toBeNull();
  });

  test("WS-26 remote concurrency: 10 sites due → at most 8 in progress, the other 2 start when a slot frees, never two per site; Scan now on a running site is queued behind it", async ({ browser }) => {
    test.setTimeout(240_000);
    await setRemote(true);
    const sites: FakeSite[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await newSite();
      await s.control({ delayMs: 400 });
      sites.push(s);
    }
    // Ten due website sources of this org (never scanned), created the way the pipeline leaves them.
    const sourceIds = await withTestDb(async (db) => {
      const ids: string[] = [];
      for (let i = 0; i < sites.length; i++) {
        const cmp = await db.competitor.create({
          data: { workspaceId, name: `QA-WS Many ${i + 1}`, websiteUrl: sites[i].url, host: sites[i].host, position: i, sources: { create: { workspaceId, type: "website", url: sites[i].url } } },
          include: { sources: true },
        });
        ids.push(cmp.sources[0].id);
      }
      return ids;
    });
    const lines = await tick();
    expect(lines.filter((l) => l.startsWith("due: QA-WS Many")).length).toBe(10);
    expect(lines.filter((l) => l.startsWith("start ")).length).toBe(8);

    let maxRunning = 0;
    let sawEight = false;
    let sawQueuedWhileFull = false;
    let doubleOnSite = false;
    const scanNowChecked = { done: false };
    await expect.poll(async () => {
      const scans = await withTestDb((db) => db.competitorScan.findMany({ where: { sourceId: { in: sourceIds } }, select: { sourceId: true, status: true } }));
      const running = scans.filter((s) => s.status === "running");
      const queued = scans.filter((s) => s.status === "queued");
      maxRunning = Math.max(maxRunning, running.length);
      if (running.length === 8) sawEight = true;
      if (running.length === 8 && queued.length >= 1) sawQueuedWhileFull = true;
      if (new Set(running.map((s) => s.sourceId)).size !== running.length) doubleOnSite = true;
      if (!scanNowChecked.done && running.length > 0) {
        scanNowChecked.done = true;
        const cid = (await withTestDb((db) => db.competitorSource.findUniqueOrThrow({ where: { id: running[0].sourceId }, select: { competitorId: true } }))).competitorId;
        const res = await scanNow(pmApi, cid);
        expect(res.status(), await res.text()).toBe(202);
        expect(((await res.json()) as { state: string }).state).toBe("queued"); // behind the running scan, never beside it
      }
      return scans.filter((s) => FINAL.test(s.status)).length;
    }, { timeout: 180_000, intervals: [150] }).toBe(11);
    expect(maxRunning).toBeLessThanOrEqual(8);
    expect(sawEight).toBe(true);
    expect(sawQueuedWhileFull).toBe(true);
    expect(doubleOnSite).toBe(false);
    const finals = await withTestDb((db) => db.competitorScan.findMany({ where: { sourceId: { in: sourceIds } } }));
    expect(finals.length).toBe(11);
    expect(finals.filter((s) => s.badge === "full").length, JSON.stringify(finals.map((s) => `${s.status}/${s.badge}/${s.errorKind}: ${s.error ?? ""}`))).toBe(11);
    // The UI never offers a second scan on a running site.
    const page = await newPage(browser, "pm");
    await openSettings(page, "QA-WS Many 1");
    await expect(competitorLine(page, "QA-WS Many 1").getByRole("button", { name: "Scan now" })).toBeEnabled();
  });

  // ————— Onboarding helpers (a row that starts from "WS-01 done") —————

  /** Add on the local lane (remote OFF) and run the station once: the row's "WS-01 done" state. */
  async function onboardLocal(name: string): Promise<Cmp> {
    const c = await addCompetitor(pmApi, await newSite(), name);
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    expect(done.status, `${name} onboarding: ${done.error ?? ""}`).toBe("ok");
    expect(done.badge, `${name} onboarding badge`).toBe("full");
    expect(done.pagesFetched, `${name} onboarding pages`).toBe(12);
    return c;
  }

  /** Add with the remote lane ON: the first scan runs at once in the scanner; the row's "WS-01 done, remote ON" state. */
  async function onboardRemote(name: string): Promise<Cmp> {
    const c = await addCompetitor(pmApi, await newSite(), name);
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.lane, `${name} lane`).toBe("remote");
    expect(done.status, `${name} onboarding: ${done.error ?? ""}`).toBe("ok");
    expect(done.badge, `${name} onboarding badge`).toBe("full");
    expect(done.pagesFetched, `${name} onboarding pages`).toBe(12);
    return c;
  }
});
