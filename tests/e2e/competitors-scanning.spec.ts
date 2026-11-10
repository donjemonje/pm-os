import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import { BIG_PAGE_MARKERS, PAGE_PATHS, type FakeSite } from "../fixtures/fake-site/fake-site";
import {
  addCompetitor, cleanupCompetitorsOf, createStationKey, FINAL, freshStateDir, isolateOtherOrgs, pagesOf, pathOf, postKnob, requestOf, restoreOtherOrgs,
  runStationPoller, scanNow, scanRow, scansOf, SCRATCH, SITE_HOST, spawnStationPoller, startSite, waitForScanEnd, waitForScanWithStatus,
  type Cmp, type PollerOpts,
} from "./competitors-helpers";
import { acceptConfirm, hashPasswordLikeApp, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";

/**
 * Competitors — Website Scanning (feature/competitors_v1_finalization, QA rows
 * WS-01 … WS-36 of the story tab, 2026-11-04; WS-28 … WS-36 added 2026-11-09). The fake competitor site is
 * tests/fixtures/fake-site (12 pages, variants through its control endpoint,
 * one server per port); the local lane runs the real poller
 * (scripts/pmos-local-scan/poller.mjs) once per row with the plain fetch
 * runner, the real station key and the real hand-in routes. Knobs — only
 * deviations from reality, never logic changes:
 *
 *   clock    POST /api/admin/competitors/knobs {clockOffsetMs}  (COMPETITORS_TEST_KNOBS=on)
 *   tick     POST /api/admin/competitors/knobs {tick: true}     (the hourly scheduler, once)
 *   remote   PATCH /api/admin/competitors/settings {remoteScanEnabled}  (default OFF)
 *   limits   POST /api/admin/competitors/knobs {ceilingMs} | {storageLimitChars} (null = default) — WS-17, WS-36
 *   poller   --mac-state locked|active, --answer approve|later, --runner fetch, --pause-ms, --max-minutes,
 *   env      COMPETITORS_PAUSE_MS=0 (robots Crawl-delay still honoured — WS-19 proves the pause rule),
 *            COMPETITORS_RESCAN_LIMIT=on, COMPETITORS_BROWSER=on,
 *            COMPETITORS_ALLOW_PRIVATE_HOSTS=on (a local site may be a competitor),
 *            COMPETITORS_AI=off (the PMOS AI step is skipped; badges come from pages — analysis is the next story).
 *
 * Every knob sits behind COMPETITORS_TEST_KNOBS=on only (no NODE_ENV guard:
 * `next build` inlines NODE_ENV=production into the CI e2e build too), so the
 * spec runs on both the dev path and the CI build path. Missing knob vars →
 * the file skips itself with the list.
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
// The fake site, the poller, the knobs route, the scan waits and the parking of other organizations live in
// competitors-helpers.ts (shared with competitors-decisions.spec.ts since 2026-11-10); this file binds them to its own state.
const KEYS_SNAPSHOT = join(SCRATCH, "station-keys-snapshot.json");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESCAN_LIMITED = "Daily manual scan limit reached for this site — next manual scan tomorrow.";

// ————— Environment gate —————
const envProblems: string[] = [];
for (const [k, want] of [["COMPETITORS_TEST_KNOBS", "on"], ["COMPETITORS_ALLOW_PRIVATE_HOSTS", "on"], ["COMPETITORS_PAUSE_MS", "0"], ["COMPETITORS_RESCAN_LIMIT", "on"], ["COMPETITORS_AI", "off"]] as const) {
  if (RESOLVED_ENV[k]?.trim() !== want) envProblems.push(`${k} must be "${want}" in test-apphosting.yaml (got ${RESOLVED_ENV[k] ?? "<unset>"})`);
}
const BROWSER_ON = RESOLVED_ENV.COMPETITORS_BROWSER?.trim() === "on";

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

/**
 * WS-31 needs "no station key": the station check (hasActiveScannerKey) is GLOBAL, so every enrolled key is parked
 * (revokedAt set) for that one row and un-parked right after it (ids in the OS temp dir, re-applied at the next start
 * if a run died). Nothing is deleted; a parked key works again the moment it is restored.
 */
async function parkStationKeys(): Promise<void> {
  await withTestDb(async (db) => {
    await restoreStationKeys(db);
    const ids = (await db.scannerKey.findMany({ where: { revokedAt: null }, select: { id: true } })).map((k) => k.id);
    mkdirSync(SCRATCH, { recursive: true });
    writeFileSync(KEYS_SNAPSHOT, JSON.stringify(ids));
    await db.scannerKey.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
  });
}

async function restoreStationKeys(db: PrismaClient): Promise<void> {
  if (!existsSync(KEYS_SNAPSHOT)) return;
  const ids = JSON.parse(readFileSync(KEYS_SNAPSHOT, "utf8")) as string[];
  await db.scannerKey.updateMany({ where: { id: { in: ids } }, data: { revokedAt: null } });
  rmSync(KEYS_SNAPSHOT, { force: true });
}

async function resetGlobalKnobs(db: PrismaClient): Promise<void> {
  await db.appSetting.upsert({ where: { key: "competitors.clockOffsetMs" }, create: { key: "competitors.clockOffsetMs", value: 0 }, update: { value: 0 } });
  await db.appSetting.upsert({ where: { key: "competitors.remoteScanEnabled" }, create: { key: "competitors.remoteScanEnabled", value: false }, update: { value: false } });
}

// ————— API knobs —————
const knob = (body: Record<string, unknown>) => postKnob(adminApi, body);
const setClock = (offsetMs: number) => knob({ clockOffsetMs: offsetMs });
/** Limits knobs (Daniel 2026-11-09: no page limit; 8 h per scan; 10 GB of page text in all). null = back to the default. */
const setCeilingMs = (ms: number | null) => knob({ ceilingMs: ms });
const setStorageLimit = (chars: number | null) => knob({ storageLimitChars: chars });
const storedTextChars = async () => Number((await (await adminApi.get("/api/admin/competitors/knobs")).json()).storedTextChars);
/** One hourly tick; returns its log lines ("due: …", "start …", "N stale scans", …). */
async function tick(): Promise<string[]> {
  return (await knob({ tick: true })).tick as string[];
}
async function setRemote(on: boolean): Promise<void> {
  const res = await adminApi.patch("/api/admin/competitors/settings", { data: { remoteScanEnabled: on } });
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { settings: { remoteScanEnabled: boolean } }).settings.remoteScanEnabled).toBe(on);
}
const createKey = (label: string) => createStationKey(adminApi, label);

// ————— Sites and competitors —————
/** A fixture site on a free port (see startSite); stopped in afterEach. */
const newSite = () => startSite(openSites);

/** The remote scanner's page requests on the site itself: after its robots.txt read (the add route probes "/" first), without robots/sitemap. */
async function scannerPageRequests(site: FakeSite) {
  const all = await site.requests();
  const start = all.findIndex((q) => q.path === "/robots.txt");
  expect(start, `robots.txt request in ${JSON.stringify(all.map((q) => `${q.host}${q.path}`))}`).toBeGreaterThanOrEqual(0);
  return all.slice(start).filter((q) => q.host === site.host && q.path !== "/robots.txt" && q.path !== "/sitemap.xml");
}

// ————— The poller —————
/** One check-in ("run once") with this file's station key unless the row brings its own. */
const runPoller = (o: PollerOpts, timeoutMs = 150_000) => runStationPoller({ ...o, key: o.key ?? keyFile }, timeoutMs);
const spawnPoller = (o: PollerOpts): ChildProcess => spawnStationPoller({ ...o, key: o.key ?? keyFile });

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
const adminScanRows = (page: Page, name: string) =>
  page.locator("table", { has: page.getByRole("columnheader", { name: "Lane" }) }).locator("tbody tr", { hasText: ORG.orgName }).filter({ hasText: name });

/** Soft-delete this org's competitors and end their scans so the next row starts clean (no tick leftovers). */
const cleanupCompetitors = () => cleanupCompetitorsOf(workspaceId);

test.describe("Website Scanning rows", () => {
  test.skip(envProblems.length > 0, envProblems.join("; "));

  test.beforeAll(async ({ browser, playwright }) => {
    if (envProblems.length) return;
    test.setTimeout(240_000);
    await withTestDb(async (db) => {
      await restoreStationKeys(db); // a previous run that died inside WS-31
      await deleteFixtures(db);
      await seedFixtures(db);
      await isolateOtherOrgs(db, [workspaceId]);
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
      await restoreStationKeys(db);
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
    // PRD: "Add competitor → Waiting" — the add answer is built after the first scan is routed.
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
    // Serial on the station: the next site is read only after the previous one's last page was handed in; order = the order
    // the requests were made. PM-OS processes a handed-in scan in its own runner while the station already reads the next
    // site (the hand-in is acknowledged at once, WS-35), so finishedAt is not the bound — the last page read is.
    const order = r.stdout.match(/scan [0-9a-f-]+ — (QA-WS \w+)/g)!.map((m) => m.replace(/.* — /, ""));
    expect(order).toEqual(names);
    for (let i = 1; i < scans.length; i++) {
      const lastRead = Math.max(...(await pagesOf(cmps[i - 1].sourceId)).map((pg) => pg.lastReadAt!.getTime()));
      expect(scans[i].startedAt.getTime(), `${names[i]} started before ${names[i - 1]}'s last page was read`).toBeGreaterThanOrEqual(lastRead);
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
    // PRD: one manual rescan per site per day. The onboarding scan is not a rescan — the PM's Scan now is allowed.
    const first = await scanNow(pmApi, c.id);
    expect(first.status(), `PM's first Scan now after onboarding: ${await first.text()}`).toBe(202);
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
    for (const p of after) expect(p.changedAt, `${p.url} unchanged`).toBeNull();

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

  test("WS-08 re-scan with changes: pricing changed (previous text handed to analysis, then dropped), new product page → 13 pages, home footer date only → unchanged", async () => {
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
    // /pricing changed, /product/new is new, and /product changed too: its list now carries the "Acme Shield (new)" link text.
    expect(done.pagesChanged).toBe(3);
    const pages = await pagesOf(c.sourceId);
    const byPath = Object.fromEntries(pages.map((p) => [pathOf(p.url), p]));
    expect(Object.keys(byPath).sort()).toEqual([...PAGE_PATHS, "/product/new"].sort());
    const pricing = byPath["/pricing"];
    expect(pricing.text).toContain("Starter $59 per month");
    expect(pricing.hash).not.toBe(before["/pricing"]);
    // No retention (PRD 2026-11-04): the previous text is held only until the analysis step ran on the change
    // (the suite's AI-off knob counts as analyzed), then dropped; the page carries when it changed.
    expect(pricing.previousText).toBeNull();
    expect(pricing.previousHash).toBeNull();
    expect(pricing.changedAt).not.toBeNull();
    expect(byPath["/product/new"].text).toContain("Acme Shield");
    expect(byPath["/product"].text).toContain("Acme Shield (new)");
    expect(byPath["/product"].changedAt).not.toBeNull();
    // Dates and tracking strings are normalized away: the footer date changed on every page, nothing else did.
    for (const path of PAGE_PATHS) {
      if (path === "/pricing" || path === "/product") continue;
      expect(byPath[path].hash, `${path} hash`).toBe(before[path]);
      expect(byPath[path].changedAt, `${path} unchanged`).toBeNull();
    }
    // (The footer is not part of the stored text — htmlToText drops <nav>/<footer> — so the date edit leaves text and hash alone.)
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

  test("WS-12 scan dies halfway: 6 pages saved and in progress; after 10 min without reporting the scan is stale and the next run finishes it; 12 total (a local scan with no heartbeat goes back to Scan pending and the station resumes it)", async ({ browser }) => {
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
    expect(stale.status, "PRD (2026-11-04): a local scan with no heartbeat goes back to Scan pending; the station resumes the same scan").toBe("pending_local");
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
    await expect(cells.nth(4)).toContainText(/^(ok|partial)/); // status chip (the badge says what the pages gave)
    await expect(cells.nth(5)).toHaveText("incomplete");
    await expect(cells.nth(7)).toHaveText("local");
    await expect(cells.nth(9)).toHaveText("11");
    await expect(cells.nth(15)).toHaveText(/\d+(\.\d)?s|\d+ ms|\d+m \d+s/); // duration = end − start
    await latest.click();
    const details = admin.locator("tr", { has: admin.getByText(c.site.url, { exact: true }) });
    await expect(details).toContainText("Not read: 1 timeout");
    await expect(details.getByText("Pages · 12")).toBeVisible();
    // The Pages panel row of /docs (page rows carry the row border; the log line about /docs below does not).
    const docsLine = details.locator("div.border-b", { has: admin.getByRole("link", { name: "/docs", exact: true }) }).last();
    await expect(docsLine).toContainText("failed");
    await expect(details.getByText(/Log · \d+/)).toBeVisible();
    await expect(details).toContainText("11 pages handed in from the station, 1 not read");
    // Retries: the PRD allows 1–3 attempts per page; the station's attempts are in the log (3 attempts on /docs, then gave up).
    const retryLine = details.locator("div", { has: admin.getByText("Station retried 2 times before giving up (timeout)") }).last();
    await expect(retryLine).toBeVisible();
    await expect(retryLine).toContainText("/docs");
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

  test("WS-28 page PM-OS cannot take: a 2.6 MB HTML page is read with its text cut at 2 MB; a .pdf that is not a PDF has no text and the scan log names the reason; every other page read; Incomplete, 1 not read (PRD 2026-11-09)", async () => {
    // Knobs: run-once (one poller check-in), Mac state (--mac-state locked), fetcher runner (--runner fetch), pause 0 (--pause-ms 0),
    // scripted site pages (fake-site variants bigPage = /big, 2.6 MB of HTML, and bogusPdf = /files/report.pdf, plain text under a .pdf name).
    test.setTimeout(150_000);
    const site = await newSite();
    await site.control({ bigPage: true, bogusPdf: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Odd");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    const bigUrl = `${site.url}/big`;
    const pdfUrl = `${site.url}/files/report.pdf`;
    // The station really took both odd files from the site.
    const served = (await site.requests()).filter((q) => q.host === site.host && q.status === 200).map((q) => q.path);
    expect(served, "the station fetched /big").toContain("/big");
    expect(served, "the station fetched /files/report.pdf").toContain("/files/report.pdf");

    type PageEntry = { url: string; outcome: string; status?: number; category?: string; error?: string; chars?: number };
    const entries = done.pages as PageEntry[];
    const diag = `outcomes ${JSON.stringify(done.outcomes)}; failed ${JSON.stringify(entries.filter((p) => p.outcome === "failed"))}`;
    expect(done.status, diag).toBe("ok");
    expect(done.badge, `PRD WS-28: the scan reaches Incomplete, 1 page not read — ${diag}`).toBe("incomplete");
    expect(done.pagesFetched, diag).toBe(13); // the 12 pages + /big; the bogus PDF is not read

    // Every other page read: the 12 pages and /big, each with text.
    const pages = await pagesOf(c.sourceId);
    const read = pages.filter((p) => p.url !== pdfUrl);
    expect(read.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS, "/big"].sort());
    for (const p of read) {
      expect(p.text, p.url).toBeTruthy();
      expect(p.state, `${p.url} state`).toBe("present");
      expect(p.hash, p.url).toMatch(/^[0-9a-f]{32}$/);
    }
    // The 2.6 MB page: its HTML is cut at 2 MB — the markers at the top and at ~1.9 MB are in the text, the one at ~2.3 MB is not.
    const big = read.find((p) => p.url === bigUrl)!;
    expect(big.text).toContain(BIG_PAGE_MARKERS.start);
    expect(big.text).toContain(BIG_PAGE_MARKERS.beforeCut);
    expect(big.text, "text past the 2 MB cut").not.toContain(BIG_PAGE_MARKERS.afterCut);

    // The bogus PDF: a page row of the scan, not read, reason "could not be read" (ours, not the site's — Daniel 2026-11-09), no text.
    const pdf = entries.find((p) => p.url === pdfUrl);
    expect(pdf, `page row for ${pdfUrl} in ${JSON.stringify(entries.map((p) => p.url))}`).toBeTruthy();
    expect(pdf!.outcome).toBe("failed");
    expect(pdf!.category).toBe("unreadable");
    expect((done.outcomes as Record<string, number>).unreadable).toBe(1);
    expect(pdf!.status).toBe(0);
    expect(pdf!.chars ?? 0).toBe(0);
    expect(pdf!.error).toMatch(/^PDF could not be read/);
    const pdfRow = pages.find((p) => p.url === pdfUrl);
    if (pdfRow) expect(pdfRow.text, "the bogus PDF has no text").toBeNull();
    // The scan log names the reason, on the PDF's URL.
    const reason = (done.log as { msg: string; url?: string; level?: string }[]).find((l) => /^PDF could not be read/.test(l.msg));
    expect(reason, `log ${JSON.stringify((done.log as { msg: string }[]).map((l) => l.msg))}`).toBeTruthy();
    expect(reason!.url).toBe(pdfUrl);
    expect(reason!.level, "ours, not the site's: an error, not a warning").toBe("error");
  });

  test("WS-29 one scan token per scan: two check-ins carry the same token; after the scan ended and the hourly tick at +1 h 16 min the token row is gone and a post is refused (401)", async () => {
    // Knobs: clock (+1 h 16 min), scheduler tick (once), fetcher runner (the real poller, --runner fetch, finishes the scan).
    test.setTimeout(150_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Token");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const secret = readFileSync(keyFile, "utf8").trim();
    const checkIn = async (): Promise<string> => {
      const res = await pmApi.get("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${secret}` } });
      expect(res.status(), await res.text()).toBe(200);
      const list = ((await res.json()) as { waiting: { scanId: string; token: string }[] }).waiting;
      const w = list.find((x) => x.scanId === pending.id);
      expect(w, `scan ${pending.id} in ${JSON.stringify(list.map((x) => x.scanId))}`).toBeTruthy();
      return w!.token;
    };
    const first = await checkIn();
    const second = await checkIn();
    expect(first).toMatch(/^pmost_/);
    expect(second, "both check-ins carry the same token").toBe(first);
    const tokenRows = () => withTestDb((db) => db.scanToken.count({ where: { scanId: pending.id } }));
    expect(await tokenRows(), "one token row for the scan").toBe(1);

    // Finish the scan on the station (its own check-in issues the same token again).
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(await tokenRows(), "still one token row after the poller's check-in").toBe(1);

    await setClock(HOUR + 16 * 60_000);
    await tick();
    expect(await tokenRows(), "the tick deleted the ended scan's token").toBe(0);
    const res = await pmApi.post(`/api/competitors/local/scans/${pending.id}/pages`, {
      headers: { authorization: `Bearer ${first}` },
      data: { url: `${c.site.url}/`, status: "ok", html: "<html><head><title>Acme Fake</title></head><body><main><p>late hand-in probe</p></main></body></html>" },
    });
    expect(res.status()).toBe(401);
  });

  test("WS-30 key rotation grace: a key older than 30 days rotates on check-in; the old key still works a day later while the new one is unused; after the new key's first use the old key works 10 more minutes, then 401", async () => {
    // Knobs: clock (+31 days → the key is older than 30 days; +32 days; +32 days 11 min).
    const key = await createKey("QA-WS key WS-30");
    const checkIn = (secret: string) => pmApi.get("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${secret}` } });
    const keyRow = () => withTestDb((db) => db.scannerKey.findUniqueOrThrow({ where: { id: key.id } }));
    type CheckIn = { station: string; rotatedKey?: string };

    // Check in with the old key: rotation happens, the answer carries the new key once.
    await setClock(31 * DAY);
    let res = await checkIn(key.secret);
    expect(res.status(), await res.text()).toBe(200);
    let json = (await res.json()) as CheckIn;
    expect(json.station).toBe("QA-WS key WS-30");
    expect(json.rotatedKey, "rotation returns a new key").toMatch(/^pmosk_/);
    const newKey = json.rotatedKey!;
    expect(newKey).not.toBe(key.secret);
    let row = await keyRow();
    expect(row.rotatedAt).not.toBeNull();
    expect(row.previousValidUntil, "no grace clock before the new key is used").toBeNull();

    // A day later the old key still works (the new one is unused), and does not rotate again.
    await setClock(32 * DAY);
    res = await checkIn(key.secret);
    expect(res.status(), `old key a day after rotation, new key unused: ${await res.text()}`).toBe(200);
    expect(((await res.json()) as CheckIn).rotatedKey).toBeUndefined();
    expect((await keyRow()).previousValidUntil).toBeNull();

    // The new key's first use starts the 10-minute grace of the old key.
    res = await checkIn(newKey);
    expect(res.status(), await res.text()).toBe(200);
    json = (await res.json()) as CheckIn;
    expect(json.rotatedKey).toBeUndefined();
    row = await keyRow();
    expect(row.previousValidUntil, "grace starts at the new key's first use").not.toBeNull();
    expect(row.previousValidUntil!.getTime() - row.lastUsedAt!.getTime()).toBe(10 * 60_000);
    res = await checkIn(key.secret);
    expect(res.status(), "old key inside the 10 minutes").toBe(200);

    // 11 minutes later: the old key is refused, the new one works.
    await setClock(32 * DAY + 11 * 60_000);
    res = await checkIn(key.secret);
    expect(res.status(), "old key after the 10 minutes").toBe(401);
    res = await checkIn(newKey);
    expect(res.status(), await res.text()).toBe(200);
  });

  test("WS-31 no station: one failed scan per frequency — first tick fails with missing scanner configuration, a tick 1 h later adds nothing, a tick 2 days later adds one; two scans in total", async () => {
    // Knobs: clock (+1 h, then +2 days 1 h), scheduler tick (three times). Setup: remote OFF; every station key parked for this row
    // (the station check is global) and restored after it.
    test.setTimeout(120_000);
    const site = await newSite();
    const name = "QA-WS NoStation";
    // One competitor, frequency 2 days, never scanned (created the way the pipeline leaves it: adding through the API would start a scan at once).
    const sourceId = await withTestDb(async (db) => {
      const cmp = await db.competitor.create({
        data: { workspaceId, name, websiteUrl: site.url, host: site.host, position: 0, sources: { create: { workspaceId, type: "website", url: site.url, scanEveryDays: 2 } } },
        include: { sources: true },
      });
      return cmp.sources[0].id;
    });
    const dueLines = (lines: string[]) => lines.filter((l) => l.startsWith(`due: ${name} `)).length;
    const expectMissingConfig = (scans: Awaited<ReturnType<typeof scansOf>>) => {
      for (const s of scans) {
        expect(s.status, s.id).toBe("failed");
        expect(s.error, s.id).toBe("missing scanner configuration");
        expect(s.trigger, s.id).toBe("scheduled");
      }
    };
    await parkStationKeys();
    try {
      expect(await withTestDb((db) => db.scannerKey.count({ where: { revokedAt: null } })), "no station key enrolled").toBe(0);
      expect(dueLines(await tick()), "first tick").toBe(1);
      let scans = await scansOf(sourceId);
      expect(scans.length).toBe(1);
      expectMissingConfig(scans);
      expect(await withTestDb((db) => db.localScanRequest.count({ where: { sourceId } })), "nothing parked in the local lane").toBe(0);

      await setClock(HOUR);
      expect(dueLines(await tick()), "second tick, 1 h later").toBe(0);
      expect((await scansOf(sourceId)).length).toBe(1);

      await setClock(HOUR + 2 * DAY);
      expect(dueLines(await tick()), "third tick, 2 days later").toBe(1);
      scans = await scansOf(sourceId);
      expect(scans.length, "two scans in total").toBe(2);
      expectMissingConfig(scans);
    } finally {
      await withTestDb((db) => restoreStationKeys(db));
    }
  });

  test("WS-32 website address changed: after the edit all 12 site A pages are removed with no text; one poller run onboards site B as a whole and never requests a site A URL", async () => {
    // Knobs: run-once (one poller check-in per scan), Mac state (--mac-state locked), fetcher runner (--runner fetch), pause 0 (--pause-ms 0),
    // request log (both fake sites log every request with its host).
    test.setTimeout(200_000);
    const c = await onboardLocal("QA-WS Move"); // WS-01 done: 12 pages of site A
    const siteA = c.site;
    const siteB = await newSite();
    expect(siteB.host).not.toBe(siteA.host);
    const scansBefore = (await scansOf(c.sourceId)).length;
    const aRequestsBefore = (await siteA.requests()).length;
    const onSite = (rows: Awaited<ReturnType<typeof pagesOf>>, s: FakeSite) => rows.filter((p) => new URL(p.url).host === s.host);

    // Edit the competitor: the website becomes site B.
    const res = await pmApi.patch(`/api/competitors/${c.id}`, { data: { website: siteB.url } });
    expect(res.status(), await res.text()).toBe(200);
    const afterEdit = onSite(await pagesOf(c.sourceId), siteA);
    expect(afterEdit.length).toBe(12);
    for (const p of afterEdit) {
      expect.soft(p.state, `${p.url} state right after the edit`).toBe("removed");
      expect.soft(p.text, `${p.url} text right after the edit`).toBeNull();
    }

    // PRD: the next step is "Run poller once" — the edit itself queues site B's onboarding scan (nobody presses Scan now).
    let next: Awaited<ReturnType<typeof scansOf>>[number] | undefined;
    await expect.poll(async () => {
      next = (await scansOf(c.sourceId)).slice(scansBefore).find((s) => s.status === "pending_local");
      return next?.id ?? null;
    }, { timeout: 30_000, intervals: [250, 500], message: "a website change queues the onboarding scan of the new site" }).not.toBeNull();
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(next!.id);
    expect(done.status, done.error ?? "").toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);

    // Site A: all 12 pages removed, no text left.
    const all = await pagesOf(c.sourceId);
    const onA = onSite(all, siteA);
    expect(onA.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS].sort());
    for (const p of onA) {
      expect(p.state, `${p.url} state`).toBe("removed");
      expect(p.removedAt, `${p.url} removedAt`).not.toBeNull();
      expect(p.text, `${p.url} text`).toBeNull();
      expect(p.previousText, `${p.url} previousText`).toBeNull();
    }
    // Site B onboarded as a whole: its 12 pages, present, with text.
    const onB = onSite(all, siteB);
    expect(onB.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS].sort());
    for (const p of onB) {
      expect(p.state, `${p.url} state`).toBe("present");
      expect(p.text, p.url).toBeTruthy();
      expect(p.hash, p.url).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(all.length).toBe(24);

    // Request log: nothing reached site A after the edit; site B answered every page.
    const aAfter = (await siteA.requests()).slice(aRequestsBefore);
    expect(aAfter.map((q) => `${q.host}${q.path}`), "site A requests after the edit").toEqual([]);
    const bServed = new Set((await siteB.requests()).filter((q) => q.host === siteB.host && q.status === 200).map((q) => q.path));
    for (const path of PAGE_PATHS) expect(bServed.has(path), `site B ${path} requested`).toBe(true);
  });

  test("WS-33 sitemap entry counts as a link: /whitepaper is listed only in /sitemap.xml and linked from no page → present, not unlinked; 13 pages, Full, no 'unlinked' log line", async () => {
    // Knobs: run-once (one poller check-in), Mac state (--mac-state locked), fetcher runner (--runner fetch), pause 0 (--pause-ms 0),
    // scripted site (fake-site variant sitemapOnly = /whitepaper served and listed in /sitemap.xml, no <a> to it on any page).
    test.setTimeout(150_000);
    const site = await newSite();
    await site.control({ sitemapOnly: true });
    const whitepaper = `${site.url}/whitepaper`;
    // The fixture's contract, checked rather than assumed: the sitemap lists it, the home page (the only page with extra links) does not.
    expect(await (await fetch(`${site.url}/sitemap.xml`)).text()).toContain(`<loc>${whitepaper}</loc>`);
    expect(await (await fetch(`${site.url}/`)).text()).not.toContain("/whitepaper");
    const c = await addCompetitor(pmApi, site, "QA-WS Sitemap");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    // The station found the page in the sitemap: 13 URLs to start with (12 pages + /whitepaper).
    expect(r.stdout).toMatch(/sitemaps: 1 sitemap file, 13 URLs/);
    const done = await waitForScanEnd(pending.id);
    const logMsgs = (done.log as { msg: string }[]).map((l) => l.msg);
    expect(done.status, done.error ?? "").toBe("ok");
    expect(done.badge, logMsgs.join("\n")).toBe("full");
    expect(done.pagesFetched).toBe(13);
    // The station handed its sitemap entries in as links: the scan's linkedUrls carry /whitepaper.
    expect(done.linkedUrls as string[], "scan.linkedUrls").toContain(whitepaper);
    const pages = await pagesOf(c.sourceId);
    expect(pages.map((p) => pathOf(p.url)).sort()).toEqual([...PAGE_PATHS, "/whitepaper"].sort());
    for (const p of pages) expect(p.state, `${p.url} state`).toBe("present");
    const wp = pages.find((p) => p.url === whitepaper)!;
    expect(wp.text).toContain("a whitepaper only the sitemap lists");
    expect(wp.lastLinkedScanId, "the sitemap entry marked /whitepaper linked in this scan").toBe(done.id);
    expect(wp.removedAt).toBeNull();
    // No "N pages unlinked" line in the scan log.
    expect(logMsgs.filter((m) => /unlinked/.test(m)), "unlinked log lines").toEqual([]);
  });

  test("WS-34 one page, one row (local lane): home links /pricing/ and /product/features/ with a trailing slash and /about under www.<host> → 12 rows, none ending with '/', no www row, 12 fetched, Full; a hand-in under a variant spelling lands on the existing row", async () => {
    // Knobs: run-once (one poller check-in), Mac state (--mac-state locked), fetcher runner (--runner fetch), pause 0 (--pause-ms 0),
    // scripted site (fake-site variant variantLinks: home links the same pages under other spellings), request log (host per request).
    test.setTimeout(200_000);
    const site = await newSite();
    await site.control({ variantLinks: true });
    const wwwOrigin = `http://www.${SITE_HOST}:${site.port}`;
    // The fixture really answers under the www. copy of its host (else the link would be a dead one, not a variant).
    expect((await fetch(`${wwwOrigin}/about`)).status, `${wwwOrigin}/about reachable`).toBe(200);
    const home = await (await fetch(`${site.url}/`)).text();
    for (const href of [`${site.url}/pricing/`, `${site.url}/product/features/`, `${wwwOrigin}/about`]) expect(home, `home links ${href}`).toContain(`href="${href}"`);
    const probed = (await site.requests()).length; // the checks above are the test's own requests, not the station's

    const c = await addCompetitor(pmApi, site, "QA-WS OneRow");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    const done = await waitForScanEnd(pending.id);
    expect(done.status, done.error ?? "").toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const oneRowPerPage = (rows: Awaited<ReturnType<typeof pagesOf>>) => {
      const urls = rows.map((p) => p.url);
      expect(urls.map(pathOf).sort(), "exactly the 12 pages").toEqual([...PAGE_PATHS].sort());
      expect(new Set(urls).size, "no duplicate URL").toBe(urls.length);
      for (const u of urls) {
        expect(u === `${site.url}/` || !u.endsWith("/"), `${u} ends with a slash`).toBe(true);
        expect(new URL(u).host, `${u} host`).toBe(site.host);
      }
    };
    oneRowPerPage(await pagesOf(c.sourceId));
    // The station fetched nothing under the www. host: the variants are one page to it too.
    expect((await site.requests()).slice(probed).filter((q) => q.host.startsWith("www.")).map((q) => `${q.host}${q.path}`), "requests under www.").toEqual([]);

    // Server side: a page handed in under a variant spelling (www. host, trailing slash) lands on the existing row.
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const next = await waitForScanWithStatus(c.sourceId, "pending_local");
    const secret = readFileSync(keyFile, "utf8").trim();
    const checkIn = await pmApi.get("/api/competitors/local/waiting", { headers: { authorization: `Bearer ${secret}` } });
    expect(checkIn.status(), await checkIn.text()).toBe(200);
    const job = ((await checkIn.json()) as { waiting: { scanId: string; token: string }[] }).waiting.find((w) => w.scanId === next.id);
    expect(job, `scan ${next.id} waiting`).toBeTruthy();
    const aboutHtml = await (await fetch(`${site.url}/about`)).text();
    const handin = await pmApi.post(`/api/competitors/local/scans/${next.id}/pages`, {
      headers: { authorization: `Bearer ${job!.token}` },
      data: { url: `${wwwOrigin}/about/`, status: "ok", html: aboutHtml },
    });
    expect(handin.status(), await handin.text()).toBe(200);
    const answer = (await handin.json()) as { url: string; outcome: string };
    expect(answer.url, "stored under the site's own address, no trailing slash").toBe(`${site.url}/about`);
    expect(answer.outcome, "the same text as the existing row").toBe("unchanged");
    const finish = await pmApi.post(`/api/competitors/local/scans/${next.id}/done`, { headers: { authorization: `Bearer ${job!.token}` }, data: {} });
    expect(finish.status(), await finish.text()).toBe(200);
    await waitForScanEnd(next.id);
    oneRowPerPage(await pagesOf(c.sourceId));
  });

  test("WS-34 one page, one row (remote lane): the crawler follows /pricing/, /product/features/ and www.<host>/about → 12 rows, none ending with '/', no www row, each page requested once, Full", async () => {
    // Knobs: remote ON (PATCH settings), pause 0, scripted site (fake-site variant variantLinks), request log (host per request).
    test.setTimeout(150_000);
    await setRemote(true);
    const site = await newSite();
    await site.control({ variantLinks: true });
    const wwwOrigin = `http://www.${SITE_HOST}:${site.port}`;
    expect((await fetch(`${wwwOrigin}/about`)).status, `${wwwOrigin}/about reachable`).toBe(200);
    const probed = (await site.requests()).length; // the check above is the test's own request, not the crawler's
    const c = await addCompetitor(pmApi, site, "QA-WS OneRowRemote");
    const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
    const done = await waitForScanEnd(scan.id);
    expect(done.lane).toBe("remote");
    expect(done.status, done.error ?? "").toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    const urls = (await pagesOf(c.sourceId)).map((p) => p.url);
    expect(urls.map(pathOf).sort(), "exactly the 12 pages").toEqual([...PAGE_PATHS].sort());
    expect(new Set(urls).size, "no duplicate URL").toBe(urls.length);
    for (const u of urls) {
      expect(u === `${site.url}/` || !u.endsWith("/"), `${u} ends with a slash`).toBe(true);
      expect(new URL(u).host, `${u} host`).toBe(site.host);
    }
    // The crawler asked for each variant target once, on the site's own host, never under www.
    const all = (await site.requests()).slice(probed);
    expect(all.filter((q) => q.host.startsWith("www.")).map((q) => `${q.host}${q.path}`), "requests under www.").toEqual([]);
    const scanner = await scannerPageRequests(site);
    const counts = Object.fromEntries(["/pricing", "/product/features", "/about"].map((p) => [p, scanner.filter((q) => q.path === p).length]));
    expect(counts).toEqual({ "/pricing": 1, "/product/features": 1, "/about": 1 });
  });

  test("WS-35 hand-in acknowledged at once: the station's done call is answered before processing, in every environment → the station exits saying PM-OS is processing, nothing 'failed on the station', and the scan ends Full 12 on its own", async () => {
    // Knobs: run-once, Mac locked, fetch runner, pause 0. No server knob: the done route has one path (answer, then launch the
    // runner) in dev and prod alike. Round 2 (2026-11-09): dev processed ZeroFox's 1,717 pages inside the call for 31 min and
    // the station gave up at 20 — Daniel 2026-11-10: dev and prod behave the same, the server answers first.
    test.setTimeout(150_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Patient");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const t0 = Date.now();
    const r = await runPoller({ mac: "locked" });
    const stationMs = Date.now() - t0;
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/failed on the station/);
    // "PM-OS is processing the pages" is printed only on a `processing: true` answer — the server acknowledged before it ran the scan.
    expect(r.stdout).toMatch(new RegExp(`scan ${pending.id} handed in · 0 not attempted · PM-OS is processing the pages`));
    const done = await waitForScanEnd(pending.id);
    expect(done.status).toBe("ok");
    expect(done.badge).toBe("full");
    expect(done.pagesFetched).toBe(12);
    expect((await pagesOf(c.sourceId)).length).toBe(12);
    expect(stationMs, `the station held the line for ${Math.round(stationMs / 1000)} s`).toBeLessThan(60_000);
  });

  test("WS-37 processing dies after the hand-in: the request is handed_in with no heartbeat → the tick processes it again (the station gets nothing to re-read); after 3 attempts the scan is failed with support named", async () => {
    // Knobs: run-once, Mac locked, fetch runner, pause 0, tick (scheduler, once). The failure is injected as its end state: the
    // request put back to handed_in and the scan's heartbeat aged past 10 minutes — exactly what a runner crash or a dev-server
    // restart leaves behind. Tomer's review 2026-11-10 (item 1): before, the sweep sent the station back to re-read the whole site.
    test.setTimeout(200_000);
    const c = await addCompetitor(pmApi, await newSite(), "QA-WS Relaunch");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    expect((await runPoller({ mac: "locked" })).code).toBe(0);
    const first = await waitForScanEnd(pending.id);
    expect(first.status).toBe("ok");
    const stale = new Date(Date.now() - 11 * 60_000);
    // 1. Processing died once: the tick relaunches it, the scan ends ok again, the station is never asked.
    await withTestDb(async (db) => {
      await db.localScanRequest.update({ where: { scanId: pending.id }, data: { state: "handed_in", processAttempts: 0 } });
      await db.competitorScan.update({ where: { id: pending.id }, data: { status: "running", finishedAt: null, heartbeatAt: stale } });
    });
    await knob({ tick: true });
    const again = await waitForScanEnd(pending.id);
    expect(again.status).toBe("ok");
    expect(again.badge).toBe("full");
    expect(again.pagesFetched).toBe(12);
    const req = await withTestDb((db) => db.localScanRequest.findUniqueOrThrow({ where: { scanId: pending.id } }));
    expect(req.state).toBe("done");
    expect(req.processAttempts).toBe(1);
    const idle = await runPoller({ mac: "locked" });
    expect(idle.stdout).toMatch(/nothing waiting/);
    expect((await pagesOf(c.sourceId)).length, "no page was read twice into a new row").toBe(12);
    // 2. Processing died for the fourth time: the scan is failed, support is named, the station still gets nothing.
    await withTestDb(async (db) => {
      await db.localScanRequest.update({ where: { scanId: pending.id }, data: { state: "handed_in", processAttempts: 3 } });
      await db.competitorScan.update({ where: { id: pending.id }, data: { status: "running", finishedAt: null, heartbeatAt: stale } });
    });
    await knob({ tick: true });
    const failed = await scanRow(pending.id);
    expect(failed.status).toBe("failed");
    expect(failed.badge).toBe("incomplete");
    expect(failed.error).toMatch(/processing failed 3 times after the station handed the pages in — contact support@pm-os.io/);
    expect((await withTestDb((db) => db.localScanRequest.findUniqueOrThrow({ where: { scanId: pending.id } }))).state).toBe("failed");
    expect((await runPoller({ mac: "locked" })).stdout).toMatch(/nothing waiting/);
  });

  test("WS-20 site says slow down (local lane): 429 after the 5th page → the station hands the signal in and stops, Incomplete, reason slow down (not 'time limit'), the rest not attempted; the next scan completes 12", async ({ browser }) => {
    // Knobs: run-once, Mac locked, fetch runner, pause 0, fake-site slowdownAfter 5 (the add route's "/" probe and the sitemap read count toward it).
    // Round 2 (2026-11-09): ZeroFox answered 429 with 45 pages left and the scan showed them as "scan time limit reached".
    test.setTimeout(200_000);
    const site = await newSite();
    await site.control({ slowdownAfter: 5 });
    const c = await addCompetitor(pmApi, site, "QA-WS Omega Local");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r = await runPoller({ mac: "locked" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/slow down \(429\) \S+ — stopping this scan, \d+ pages left for the next one/);
    const done = await waitForScanEnd(pending.id);
    expect(done.badge).toBe("incomplete");
    const outcomes = done.outcomes as Record<string, number>;
    expect(outcomes.slowdown).toBe(1);
    expect(outcomes.cap, "a slow-down stop is not a time-limit stop").toBeUndefined();
    expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(1);
    expect(done.pagesFetched).toBeGreaterThanOrEqual(1);
    expect(done.pagesFetched).toBeLessThan(12);
    const log = (done.log as { msg: string }[]).map((l) => l.msg);
    expect(log, log.join("\n")).toContain(`${done.pagesNotAttempted} discovered page${done.pagesNotAttempted === 1 ? "" : "s"} not attempted after the slow-down answer`);
    expect(log.some((m) => /time limit/i.test(m)), log.join("\n")).toBe(false);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await expect(competitorLine(page, c.name)).not.toContainText("time limit");
    await competitorLine(page, c.name).getByRole("button", { name: "Scan log" }).click();
    const drawer = page.locator("div.fixed.right-0");
    await expect(drawer.getByText("1 not read — the site asked us to slow down")).toBeVisible();
    await expect(drawer.getByText(new RegExp(`^${done.pagesNotAttempted} pages? not attempted — the next scan continues from them$`))).toBeVisible();
    await page.close();
    // The site relents: the next scan (Scan now) reads the whole site.
    await site.control({ slowdownAfter: 0 });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const next = await waitForScanWithStatus(c.sourceId, "pending_local");
    const r2 = await runPoller({ mac: "locked" });
    expect(r2.code, r2.stdout).toBe(0);
    const done2 = await waitForScanEnd(next.id);
    expect(done2.badge).toBe("full");
    expect(done2.pagesFetched).toBe(12);
    expect((await pagesOf(c.sourceId)).length).toBe(12);
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

  test("WS-17 time limit (local lane, --max-minutes 0.25): stops after 15 s, Incomplete, the rest not attempted, plain message — no page limit (Daniel 2026-11-09)", async ({ browser }) => {
    // Knobs: run-once, Mac locked, fetch runner, pause 0, fake-site infiniteLinks, the station's own time stop at 15 s (the server's is 8 h).
    test.setTimeout(150_000);
    const site = await newSite();
    await site.control({ infiniteLinks: true });
    const c = await addCompetitor(pmApi, site, "QA-WS Upsilon");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const t0 = Date.now();
    const r = await runPoller({ mac: "locked", maxMinutes: 0.25 });
    expect(r.code, r.stdout).toBe(0);
    expect(Date.now() - t0, "the station stopped on time, not on a page count").toBeGreaterThanOrEqual(15_000);
    const done = await waitForScanEnd(pending.id);
    expect(done.badge).toBe("incomplete");
    const attempts = (done.pages as { outcome: string; category?: string }[]).filter((p) => p.outcome !== "skipped");
    // No page limit: in 15 s at pause 0 the station reads far more than the old 20-page cap would have allowed.
    expect(attempts.length, JSON.stringify(attempts.length)).toBeGreaterThan(20);
    expect(done.pagesFetched).toBe(attempts.length - attempts.filter((p) => p.category === "notfound").length);
    expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(1);
    expect((done.outcomes as Record<string, number>).cap).toBe(done.pagesNotAttempted);
    expect((await pagesOf(c.sourceId)).length).toBe(done.pagesFetched);
    const page = await newPage(browser, "pm");
    await openSettings(page, c.name);
    await expect(pill(page, c.name)).toHaveText("Incomplete");
    await expect(competitorLine(page, c.name)).toContainText(/\d+ not attempted — scan time limit reached/);
    await competitorLine(page, c.name).getByRole("button", { name: "Scan log" }).click();
    await expect(page.getByText(new RegExp(`^${done.pagesNotAttempted} pages? not attempted — the next scan continues from them$`))).toBeVisible();
  });

  test("WS-17 time limit (remote lane, ceilingMs knob 10 s): stops after 10 s, Incomplete, reason time limit, plain message", async ({ browser }) => {
    // Knobs: remote ON, pause 0, fake-site infiniteLinks, per-test time limit 10 s through the knobs route (default 8 h).
    test.setTimeout(150_000);
    await setRemote(true);
    await setCeilingMs(10_000);
    try {
      const site = await newSite();
      await site.control({ infiniteLinks: true });
      const c = await addCompetitor(pmApi, site, "QA-WS Phi");
      const scan = await waitForScanWithStatus(c.sourceId, "running", 30_000).catch(async () => (await scansOf(c.sourceId))[0]);
      const done = await waitForScanEnd(scan.id);
      expect(done.badge).toBe("incomplete");
      const attempts = (done.pages as { outcome: string; category?: string }[]).filter((p) => p.outcome !== "skipped");
      expect(attempts.length, "no page limit: more than the old 20-page cap in 10 s").toBeGreaterThan(20);
      expect(done.pagesFetched).toBe(attempts.length - attempts.filter((p) => p.category === "notfound").length);
      expect((done.outcomes as Record<string, number>).cap).toBeGreaterThanOrEqual(1);
      expect(done.pagesNotAttempted).toBeGreaterThanOrEqual(1);
      expect((done.log as { msg: string }[]).some((l) => /^Time limit reached \(10 s\)/.test(l.msg)), JSON.stringify(done.log)).toBe(true);
      const page = await newPage(browser, "pm");
      await openSettings(page, c.name);
      await expect(pill(page, c.name)).toHaveText("Incomplete");
      await expect(competitorLine(page, c.name)).toContainText(/\d+ not attempted — scan time limit reached/);
    } finally {
      await setCeilingMs(null);
    }
  });

  test("WS-36 storage limit (local lane, storageLimitChars knob): the store fills after the first page → the scan stops, Incomplete, 11 not attempted with the reason, support named in the log", async ({ browser }) => {
    // Knobs: run-once, Mac locked, fetch runner, pause 0; PM-OS store limit set to what is stored now + 1 character (default 10 GB):
    // the first page still fits (the store is below the limit when it lands), the second finds the store full.
    test.setTimeout(150_000);
    const site = await newSite();
    const c = await addCompetitor(pmApi, site, "QA-WS Storage");
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    const before = await storedTextChars();
    await setStorageLimit(before + 1);
    try {
      const r = await runPoller({ mac: "locked" });
      expect(r.code, r.stdout).toBe(0);
      expect(r.stdout).toMatch(/PM-OS stopped the scan \(storage\)/);
      const done = await waitForScanEnd(pending.id);
      expect(done.badge).toBe("incomplete");
      expect(done.errorKind).toBe("storage");
      expect(done.pagesFetched, "the first page lands while the store is still below the limit").toBe(1);
      expect(done.pagesNotAttempted, "the refused page and the 10 behind it").toBe(11);
      expect((done.outcomes as Record<string, number>).storage).toBe(done.pagesNotAttempted);
      expect((await pagesOf(c.sourceId)).length).toBe(done.pagesFetched);
      expect((done.log as { msg: string }[]).some((l) => /^PM-OS storage limit reached \(\d+ [KMG]B of page text, all organizations\) — 11 discovered pages not attempted; contact support@pm-os.io/.test(l.msg)), JSON.stringify(done.log)).toBe(true);
      const page = await newPage(browser, "pm");
      await openSettings(page, c.name);
      await expect(pill(page, c.name)).toHaveText("Incomplete");
      await expect(competitorLine(page, c.name)).toContainText(/\d+ not attempted — PM-OS storage limit reached/);
    } finally {
      await setStorageLimit(null);
    }
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
    await expect(competitorLine(page, c.name)).toContainText(/The site did not answer on .*Showing data from /);

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
    const diag = `outcomes ${JSON.stringify(done.outcomes)}; failed ${JSON.stringify((done.pages as { url: string; outcome: string; error?: string }[]).filter((p) => p.outcome === "failed"))}; log ${JSON.stringify((done.log as { msg: string }[]).map((l) => l.msg))}`;
    expect(done.badge, diag).toBe("full");
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

  test("WS-25 no retention: a change replaces the page text; the previous text is held only until the analysis step ran, then dropped; hashes, URLs, titles, states and scan history stay", async () => {
    test.setTimeout(200_000);
    await setRemote(true);
    const c = await onboardRemote("QA-WS Keep");
    const before = await pagesOf(c.sourceId);
    const pricingBefore = before.find((p) => pathOf(p.url) === "/pricing")!;
    expect(pricingBefore.previousText).toBeNull();
    await c.site.control({ pricingText: "Starter $69 per month. Team $299 per month." });
    const res = await scanNow(adminApi, c.id);
    expect(res.status(), await res.text()).toBe(202);
    const second = (await scansOf(c.sourceId))[1];
    const done = await waitForScanEnd(second.id);
    expect(done.pagesChanged).toBe(1);
    const after = await pagesOf(c.sourceId);
    expect(after.length).toBe(12);
    const pricingAfter = after.find((p) => pathOf(p.url) === "/pricing")!;
    expect(pricingAfter.text).toContain("$69");
    expect(pricingAfter.hash).not.toBe(pricingBefore.hash);
    // The analysis step ran (AI-off knob counts as analyzed): the previous text was handed over and dropped, nothing older is kept.
    expect(pricingAfter.previousText).toBeNull();
    expect(pricingAfter.previousHash).toBeNull();
    expect(pricingAfter.changedAt).not.toBeNull();
    const scan = await withTestDb((db) => db.competitorScan.findUniqueOrThrow({ where: { id: second.id }, select: { log: true } }));
    expect(JSON.stringify(scan.log)).toMatch(/1 previous page text dropped/);
    for (const p of after) {
      if (pathOf(p.url) === "/pricing") continue;
      const was = before.find((b) => b.url === p.url)!;
      expect(p.hash, `${p.url} hash`).toBe(was.hash);
      expect(p.title, `${p.url} title`).toBe(was.title);
      expect(p.state, `${p.url} state`).toBe(was.state);
      expect(p.text, `${p.url} current text`).toBe(was.text);
    }
    expect((await scansOf(c.sourceId)).length).toBeGreaterThanOrEqual(2); // history stays
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
    const scanNowChecked: { done: boolean; name?: string } = { done: false };
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
        const cmp = (await withTestDb((db) => db.competitorSource.findUniqueOrThrow({ where: { id: running[0].sourceId }, select: { competitor: { select: { id: true, name: true } } } }))).competitor;
        scanNowChecked.name = cmp.name;
        const res = await scanNow(pmApi, cmp.id);
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
    // Afterwards every site is Full; the site that got Scan now has two scans (queued one ran after the first ended).
    const pressed = scanNowChecked.name!;
    const other = sites.length ? `QA-WS Many ${pressed === "QA-WS Many 1" ? 2 : 1}` : "";
    const page = await newPage(browser, "pm");
    await openSettings(page, pressed);
    await expect(pill(page, pressed)).toHaveText("Full");
    await expect(pill(page, other)).toHaveText("Full");
    await expect(competitorLine(page, other).getByRole("button", { name: "Scan now" })).toBeEnabled();
    const pressedScans = await withTestDb((db) => db.competitorScan.findMany({ where: { sourceId: { in: sourceIds }, source: { competitor: { name: pressed } } }, orderBy: { startedAt: "asc" } }));
    expect(pressedScans.length).toBe(2);
    expect(pressedScans[1].startedAt.getTime()).toBeGreaterThanOrEqual(pressedScans[0].finishedAt!.getTime());
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
