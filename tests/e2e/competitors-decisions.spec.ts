import { expect, test, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import type { FakeSite } from "../fixtures/fake-site/fake-site";
import {
  addCompetitor, createStationKey, isolateOtherOrgs, postKnob, restoreOtherOrgs, runStationPoller, scanNow, SCRATCH, startSite,
  waitForScanEnd, waitForScanWithStatus, type Cmp,
} from "./competitors-helpers";
import { acceptConfirm, hashPasswordLikeApp, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";

/**
 * Competitors — Capability Analysis, the slice "PM decisions stick"
 * (feature/competitor_website_analysis, QA rows CA-01 … CA-24, 2026-11-10).
 * What a PM decides about the catalog — remove, restore, rename, move, order,
 * the org's own cell, a corrected cell — is recorded and a scan never reopens it.
 *
 * Round 2 (same night, after the code-review fixes of 7d1964e): rows CA-25 … CA-28 and added assertions in
 * CA-03, CA-17 and CA-24. Each one fails on the code before that commit.
 *
 * Common setup (every row): one QA org (QA-CA Org) with a PM-OS admin (knobs,
 * Scan now without the daily limit), an org admin PM (every catalog change —
 * "the admin" of the rows) and a member. Two competitors, Alpha and Beta, each
 * on its own fake site (tests/fixtures/fake-site, two ports), each scanned
 * once in beforeAll by the real station poller run once. Before every row the
 * catalog is seeded again with Prisma (as the profile spec seeds its tables):
 * domains Planning, Feedback, Reporting; capabilities Roadmap and
 * Prioritization scoring (Planning), Feedback inbox and Customer portal
 * (Feedback), Dashboards (Reporting); one status row per competitor and
 * capability with a value, a quote and a source URL on the fake site. A row
 * that needs something removed, renamed or declined does it through the real
 * route in its own setup, so no row depends on another.
 *
 * Knobs — the only deviations from reality, named in each test title:
 *   AI answer injected  POST /api/admin/competitors/knobs {aiAnswers: {competitorId, classify}} — the model's raw
 *                       answer for one competitor (COMPETITORS_TEST_KNOBS=on). It replaces the model call only:
 *                       parsing, name matching and everything the scan writes run for real. Cleared after the row.
 *   fake site           the competitor is the fixture site; its pricing text is changed before the scan (no changed
 *                       page → no PMOS AI step).
 *   run-once            the real poller (fetch runner, real station key, real hand-in routes), one check-in.
 * DB, routes, hashing, diffing and emails are never mocked.
 *
 * Every injected answer carries one control status (Prioritization scoring: has → partial) that must show in its
 * cell: a row that asserts "nothing was added" cannot pass because the answer never ran. Expected for each injected
 * scan: status ok, the injected-answer line in the scan log, and 2 on the scan's AI-call counter — the PMOS AI step
 * ran once and made its two calls (classification, scan.ts aiStep; profile facts, same step), both answered by the knob.
 *
 * Rows marked (proposed) test a build-time decision that is not a PRD line yet; they change with Daniel's decision.
 * Not built tonight, kept as test.fixme: CA-08's "goes to the closest active domain" (needs the analysis run).
 *
 * Shared-clone hazard: the station check-in is global — other organizations' sources and waiting requests are parked
 * for the run and restored byte-exact (competitors-helpers.ts). The aiAnswers knob is one AppSetting row keyed by
 * competitor id; this file only ever writes its own competitors' entries and removes them.
 */

const ORG = { orgName: "QA-CA Org", slug: "qa-ca-org" };
const ORG2 = { orgName: "QA-CA Second Org", slug: "qa-ca-org-2" };
const ORG3 = { orgName: "QA-CA Third Org", slug: "qa-ca-org-3" };
type Creds = TotpCreds & { name: string };
// Synthetic, test-only credentials.
const ADMIN: Creds = { name: "QA CA Admin", email: "qa+ca-admin@pm-os.io", password: "Ca-admin-qa-pass1", totpSecret: "QACAADMNQACAADMNQACAADMNQACAADMN" };
const PM: Creds = { name: "QA CA PM", email: "qa+ca-pm@pm-os.io", password: "Ca-pm-qa-pass1", totpSecret: "QACAPMQACAPMQACAPMQACAPMQACAPMQA" };
const MEMBER: Creds = { name: "QA CA Member", email: "qa+ca-member@pm-os.io", password: "Ca-member-qa-pass1", totpSecret: "QACAMEMBQACAMEMBQACAMEMBQACAMEMB" };
const PM2: Creds = { name: "QA CA PM Two", email: "qa+ca-pm2@pm-os.io", password: "Ca-pm2-qa-pass1", totpSecret: "QACAPMBBQACAPMBBQACAPMBBQACAPMBB" };
const PM3: Creds = { name: "QA CA PM Three", email: "qa+ca-pm3@pm-os.io", password: "Ca-pm3-qa-pass1", totpSecret: "QACAPMCCQACAPMCCQACAPMCCQACAPMCC" };
const KEY_LABEL = "QA-CA station";
const ALPHA = "QA-CA Alpha";
const BETA = "QA-CA Beta";
const AI_ANSWERS_KEY = "competitors.test.aiAnswers";
const INJECTED_LINE = "PMOS AI answer injected (test knob) — no model is called";

type Value = "has" | "partial" | "missing" | "unknown";
const LABEL: Record<Value, string> = { has: "Has it", partial: "Partial", missing: "Missing", unknown: "Unknown" };
const DOMAINS = ["Planning", "Feedback", "Reporting"] as const;
type DomainName = (typeof DOMAINS)[number];
/** The seeded catalog: capability → its domain, the org's own status, each competitor's value, the quote and page. */
const CAPS = [
  { name: "Roadmap", domain: "Planning", ours: "has", alpha: "has", beta: "has", quote: "Plan every release on a shared roadmap.", path: "/product" },
  { name: "Prioritization scoring", domain: "Planning", ours: "partial", alpha: "has", beta: "has", quote: "Score every request by reach and effort.", path: "/product/features" },
  { name: "Feedback inbox", domain: "Feedback", ours: "has", alpha: "partial", beta: "missing", quote: "One inbox for every piece of feedback.", path: "/docs" },
  { name: "Customer portal", domain: "Feedback", ours: "missing", alpha: "has", beta: "partial", quote: "A portal where customers follow their requests.", path: "/docs/start" },
  { name: "Dashboards", domain: "Reporting", ours: "missing", alpha: "has", beta: "missing", quote: "Dashboards for every team.", path: "/pricing" },
] as const satisfies readonly { name: string; domain: DomainName; ours: string; alpha: Value; beta: Value; quote: string; path: string }[];
type CapName = (typeof CAPS)[number]["name"];
const CONTROL: CapName = "Prioritization scoring";
const CONTROL_QUOTE = "Scoring is limited to the Team plan.";

// ————— Environment gate (same knobs as the Website Scanning rows) —————
const envProblems: string[] = [];
for (const [k, want] of [["COMPETITORS_TEST_KNOBS", "on"], ["COMPETITORS_ALLOW_PRIVATE_HOSTS", "on"], ["COMPETITORS_PAUSE_MS", "0"], ["COMPETITORS_RESCAN_LIMIT", "on"], ["COMPETITORS_AI", "off"]] as const) {
  if (RESOLVED_ENV[k]?.trim() !== want) envProblems.push(`${k} must be "${want}" in test-apphosting.yaml (got ${RESOLVED_ENV[k] ?? "<unset>"})`);
}

// ————— Shared state —————
let workspaceId: string;
let workspace2Id: string;
let workspace3Id: string;
let adminId: string;
let pmId: string;
let memberId: string;
let adminApi: APIRequestContext;
let pmApi: APIRequestContext;
let memberApi: APIRequestContext;
const stateFile: Record<"admin" | "pm" | "member", string> = { admin: "", pm: "", member: "" };
let keyFile: string;
let alpha: Cmp;
let beta: Cmp;
/** The onboarding scan of each competitor: the seeded status rows name it as the scan that found them. */
const firstScanId: Record<string, string> = {};
const fileSites: FakeSite[] = [];
const rowSites: FakeSite[] = [];
const openContexts: BrowserContext[] = [];
/** Ids of the catalog as seeded before the current row. */
let dom: Record<DomainName, string>;
let cap: Record<CapName, string>;
let scanSeq = 0;

// ————— Fixtures —————
const SLUGS = [ORG.slug, ORG2.slug, ORG3.slug];

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.user.deleteMany({ where: { OR: [{ email: { startsWith: "qa+ca-" } }, { organization: { slug: { in: SLUGS } } }] } });
  await db.organization.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.scannerKey.deleteMany({ where: { label: { startsWith: "QA-CA" } } });
  await pruneAiAnswers(db);
}

/** The knob row holds one entry per competitor: entries of competitors that no longer exist (ours, after a run that died) go. */
async function pruneAiAnswers(db: PrismaClient): Promise<void> {
  const row = await db.appSetting.findUnique({ where: { key: AI_ANSWERS_KEY } });
  if (!row || !row.value || typeof row.value !== "object" || Array.isArray(row.value)) return;
  const all = row.value as Record<string, Prisma.JsonValue>;
  const alive = new Set((await db.competitor.findMany({ where: { id: { in: Object.keys(all) } }, select: { id: true } })).map((c) => c.id));
  const next = Object.fromEntries(Object.entries(all).filter(([id]) => alive.has(id)));
  if (Object.keys(next).length === Object.keys(all).length) return;
  await db.appSetting.update({ where: { key: AI_ANSWERS_KEY }, data: { value: next as Prisma.InputJsonValue } });
}

async function createUser(db: PrismaClient, orgId: string, creds: Creds, role: "PMOS_ADMIN" | "CUSTOMER_ADMIN"): Promise<string> {
  process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY;
  const u = await db.user.create({
    data: { email: creds.email, name: creds.name, passwordHash: hashPasswordLikeApp(creds.password), organizationId: orgId, role, totpSecretEnc: encryptTotpSecret(creds.totpSecret), totpEnabledAt: new Date(), totpLastUsedStep: null },
  });
  return u.id;
}

async function seedFixtures(db: PrismaClient): Promise<void> {
  const one = await seedQaOrgWithUser(db, { ...ORG, features: { competitors: true }, user: MEMBER });
  workspaceId = one.workspaceId;
  memberId = one.userId;
  adminId = await createUser(db, one.orgId, ADMIN, "PMOS_ADMIN");
  pmId = await createUser(db, one.orgId, PM, "CUSTOMER_ADMIN");
  // CA-18: two more organizations, each with its own org admin.
  const two = await seedQaOrgWithUser(db, { ...ORG2, features: { competitors: true }, user: PM2 });
  workspace2Id = two.workspaceId;
  await db.user.update({ where: { id: two.userId }, data: { role: "CUSTOMER_ADMIN" } });
  const three = await seedQaOrgWithUser(db, { ...ORG3, features: { competitors: true }, user: PM3 });
  workspace3Id = three.workspaceId;
  await db.user.update({ where: { id: three.userId }, data: { role: "CUSTOMER_ADMIN" } });
}

/** The Common setup's catalog and cells, written the way the routes and a scan leave them. */
async function seedCatalog(db: PrismaClient): Promise<void> {
  const mine = { in: [workspaceId, workspace2Id, workspace3Id] };
  await db.capability.deleteMany({ where: { workspaceId: mine } }); // cascades to the status rows and their history
  await db.competitorDomain.deleteMany({ where: { workspaceId: mine } });
  await db.usageEvent.deleteMany({ where: { workspaceId: mine } });
  await db.competitorFeedRead.deleteMany({ where: { workspaceId: mine } });
  const d = {} as Record<DomainName, string>;
  for (const [position, name] of DOMAINS.entries()) {
    d[name] = (await db.competitorDomain.create({ data: { workspaceId, name, summary: `QA-CA fixture domain ${name}`, description: `QA-CA fixture domain ${name}`, position } })).id;
  }
  const k = {} as Record<CapName, string>;
  for (const [position, c] of CAPS.entries()) {
    k[c.name] = (await db.capability.create({ data: { workspaceId, domainId: d[c.domain], name: c.name, description: "QA-CA fixture capability", ourStatus: c.ours, position } })).id;
    for (const [competitor, value] of [[alpha, c.alpha], [beta, c.beta]] as const) {
      await db.capabilityStatus.create({
        data: { workspaceId, competitorId: competitor.id, capabilityId: k[c.name], value, confidence: 0.9, quote: c.quote, sourceUrl: `${competitor.site.url}${c.path}`, scanId: firstScanId[competitor.id] },
      });
    }
  }
  dom = d;
  cap = k;
}

/** Scans a red row left behind are ended, so the next row's Scan now is not queued behind them. */
async function endOpenScans(): Promise<void> {
  if (!workspaceId) return; // beforeAll did not get that far
  await withTestDb(async (db) => {
    const mine = { in: [workspaceId, workspace2Id, workspace3Id] };
    const t = new Date();
    await db.localScanRequest.updateMany({ where: { workspaceId: mine, state: { in: ["waiting", "running"] } }, data: { state: "cancelled", finishedAt: t } });
    await db.competitorScan.updateMany({ where: { workspaceId: mine, status: { in: ["queued", "pending_local", "running"] } }, data: { status: "cancelled", finishedAt: t, error: "QA cleanup" } });
  });
}

// ————— Sessions —————
async function loginAndSave(browser: Browser, creds: Creds, file: string): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginWithTotp(page, creds);
  const path = join(SCRATCH, file);
  await ctx.storageState({ path });
  await ctx.close();
  return path;
}

async function open(browser: Browser, who: "admin" | "pm" | "member" | string): Promise<Page> {
  const ctx = await browser.newContext({ storageState: who in stateFile ? stateFile[who as keyof typeof stateFile] : who });
  openContexts.push(ctx);
  return ctx.newPage();
}

// ————— The injected scan —————
interface AiStatus { capability: string; value: Value; confidence?: number; quote?: string; url?: string; product?: string; summary?: string }
interface AiSuggestion { name: string; domain: string; newDomainDescription?: string; quote?: string; url?: string }
type ScanRow = Awaited<ReturnType<typeof waitForScanEnd>>;

const logOf = (scan: ScanRow): string[] => (Array.isArray(scan.log) ? (scan.log as { msg?: string }[]).map((l) => l.msg ?? "") : []);

const setAnswer = (competitorId: string, classify: string | null) => postKnob(adminApi, { aiAnswers: { competitorId, classify } });

/**
 * One scan of `c` on an injected model answer. Knobs: AI answer injected (CLASSIFY_TOOL's shape, with the control
 * status first), fake site (pricing text changed, so the scan has a changed page), run-once (the real poller).
 * `by` presses Scan now — the PM-OS admin in the first org (the daily limit never applies to him).
 */
async function injectedScan(c: Cmp, extra: { statuses?: AiStatus[]; suggestions?: AiSuggestion[] } = {}, by: APIRequestContext = adminApi): Promise<ScanRow> {
  const url = `${c.site.url}/pricing`;
  const status = (s: AiStatus) => ({ confidence: 0.8, quote: "", url, product: "", summary: "", ...s });
  const answer = {
    statuses: [status({ capability: CONTROL, value: "partial", quote: CONTROL_QUOTE, summary: "Scoring now needs the Team plan." }), ...(extra.statuses ?? []).map(status)],
    suggestions: (extra.suggestions ?? []).map((s) => ({ newDomainDescription: "", quote: "Listed on the pricing page.", url, ...s })),
  };
  scanSeq++;
  await c.site.control({ pricingText: `Starter $${50 + scanSeq} per month. Team $${200 + scanSeq} per month. Enterprise: talk to us about plan ${scanSeq}.` });
  await setAnswer(c.id, JSON.stringify(answer));
  const res = await scanNow(by, c.id);
  expect(res.status(), `Scan now on ${c.name}: ${await res.text()}`).toBe(202);
  const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
  const r = await runStationPoller({ mac: "locked", key: keyFile });
  expect(r.code, r.stdout).toBe(0);
  const done = await waitForScanEnd(pending.id);
  // The admin scan log of every injected scan is kept with the test result.
  await test.info().attach(`scan-log-${c.name}-${done.id}.txt`, { body: logOf(done).join("\n"), contentType: "text/plain" });
  expect(done.status, `${c.name} scan: ${done.error ?? ""}\n${logOf(done).join("\n")}`).toBe("ok");
  expect(logOf(done), "the scan ran on the injected answer").toContain(INJECTED_LINE);
  // One PMOS AI step: its classification call and its profile-facts call, both answered by the knob.
  expect(done.aiCalls, "AI calls counted on the scan (classification + facts)").toBe(2);
  expect(done.pagesChanged, "the changed pricing page").toBeGreaterThanOrEqual(1);
  // The control status was applied: the answer reached the catalog.
  const control = await withTestDb((db) => db.capabilityStatus.findFirstOrThrow({ where: { competitorId: c.id, capability: { name: CONTROL } } }));
  expect(control.value, "control status in the DB").toBe("partial");
  expect(control.quote).toBe(CONTROL_QUOTE);
  return done;
}

// ————— DB reads —————
const propsOf = (row: { props: Prisma.JsonValue }) => (row.props ?? {}) as Record<string, unknown>;
/** UsageEvent rows of an event in a workspace, newest first, optionally only those whose props match. */
async function events(event: string, match: Record<string, unknown> = {}, ws = workspaceId) {
  const rows = await withTestDb((db) => db.usageEvent.findMany({ where: { workspaceId: ws, event }, orderBy: { createdAt: "desc" }, select: { props: true, userId: true } }));
  return rows.filter((r) => Object.entries(match).every(([k, v]) => propsOf(r)[k] === v));
}
/** Every catalog row of a workspace: what must be identical before and after a scan. */
const catalogOf = (ws = workspaceId) => withTestDb(async (db) => ({
  domains: await db.competitorDomain.findMany({ where: { workspaceId: ws }, orderBy: { id: "asc" }, select: { id: true, name: true, state: true, position: true } }),
  capabilities: await db.capability.findMany({ where: { workspaceId: ws }, orderBy: { id: "asc" }, select: { id: true, name: true, domainId: true, state: true, position: true } }),
}));
/** The cells of one capability, with everything a scan or a route could have touched. */
const cellsOf = (capabilityId: string) => withTestDb((db) => db.capabilityStatus.findMany({
  where: { capabilityId }, orderBy: { competitorId: "asc" },
  select: { id: true, competitorId: true, value: true, confidence: true, quote: true, sourceUrl: true, scanId: true, changedAt: true, product: true, overrideValue: true, updatedAt: true },
}));
const capabilityRow = (id: string) => withTestDb((db) => db.capability.findUniqueOrThrow({ where: { id } }));
const domainRow = (id: string) => withTestDb((db) => db.competitorDomain.findUniqueOrThrow({ where: { id } }));
const capabilitiesNamed = (name: string, ws = workspaceId) => withTestDb((db) => db.capability.findMany({ where: { workspaceId: ws, name: { equals: name, mode: "insensitive" } } }));
const domainsNamed = (name: string, ws = workspaceId) => withTestDb((db) => db.competitorDomain.findMany({ where: { workspaceId: ws, name: { equals: name, mode: "insensitive" } } }));
const suggestedRows = (ws = workspaceId) => withTestDb(async (db) => ({
  domains: await db.competitorDomain.count({ where: { workspaceId: ws, state: "suggested" } }),
  capabilities: await db.capability.count({ where: { workspaceId: ws, state: "suggested" } }),
}));

// ————— Routes (a row's own setup: "removed / renamed / declined through the real route") —————
async function ok(res: APIResponse, status = 200): Promise<void> {
  expect(res.status(), `${res.url()}: ${await res.text()}`).toBe(status);
}
const removeCapability = async (id: string) => ok(await pmApi.delete(`/api/competitors/capabilities/${id}`));
const removeDomain = async (id: string, moveTo?: string) => ok(await pmApi.delete(`/api/competitors/domains/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`));
/** Decline a suggestion (the × of a suggested row / a suggested domain): PATCH {state: "dismissed"}. */
const declineCapability = async (id: string) => ok(await pmApi.patch(`/api/competitors/capabilities/${id}`, { data: { state: "dismissed" } }));
const declineDomain = async (id: string) => ok(await pmApi.patch(`/api/competitors/domains/${id}`, { data: { state: "dismissed" } }));
/** The one row of a workspace with this name (a suggestion a scan just left, in a row's setup). */
async function capabilityNamed(name: string) {
  const rows = await capabilitiesNamed(name);
  expect(rows, `rows named ${name}`).toHaveLength(1);
  return rows[0];
}

// ————— UI —————
/** lib/competitors/time.ts shortDate — "Nov 10" this year. */
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const removedBy = (name: string) => `Removed by ${name}, ${shortDate(new Date())}`;

/** React has attached to the element: clicks before that are lost (server-rendered page, client component). */
async function hydrated(target: Locator): Promise<void> {
  await expect(target.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => target.first().evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
}

const domainsSection = (page: Page) => page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Domains", exact: true }) });
/** A domain's card in Settings → Domains (view mode: swatch, name, counts, drag handle, edit, remove). */
const domainCard = (page: Page, name: string) => domainsSection(page).locator("div.rounded-xl.px-5.py-4", { has: page.locator("span.font-title", { hasText: new RegExp(`^${name}$`) }) });
const settingsDomainOrder = (page: Page) => domainsSection(page).locator("div.rounded-xl.px-5.py-4 span.font-title").allTextContents();
/** A capability's line in Settings → Capabilities (view mode: name, own status, move select, edit, remove). */
const capLine = (page: Page, name: string) => page.locator("div.items-start.px-5.py-3", { has: page.getByText(name, { exact: true }) });
const removedPanel = (page: Page) => page.getByTestId("cmp-removed");
/** Settings → "Suggested by scans": one line per waiting suggestion (name field, domain select, Dismiss, Accept). */
const suggestionsPanel = (page: Page) => page.locator("section", { has: page.getByText("Suggested by scans", { exact: true }) });
const removedCapability = (page: Page, name: string) => removedPanel(page).locator(`[data-testid="cmp-removed-capability"][data-name="${name}"]`);
const removedDomain = (page: Page, name: string) => removedPanel(page).locator(`[data-testid="cmp-removed-domain"][data-name="${name}"]`);

async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings/competitors");
  await hydrated(page.getByRole("heading", { level: 2, name: "Domains", exact: true }));
}

const parity = (page: Page) => page.locator('section[aria-label="Parity matrix"]');
async function openMatrix(page: Page): Promise<void> {
  await page.goto("/competitors");
  await expect(page.getByRole("heading", { level: 1, name: "Competitors" })).toBeVisible({ timeout: 30_000 });
  await hydrated(parity(page).locator("table"));
}

interface MatrixGroup { domain: string; suggestedDomain: boolean; rows: string[]; suggested: string[] }
/** The parity table as the PM reads it: domain groups in order, each with its capability rows and suggested rows. */
async function matrixGroups(page: Page): Promise<MatrixGroup[]> {
  return parity(page).locator("table tbody tr").evaluateAll((rows) => {
    const out: { domain: string; suggestedDomain: boolean; rows: string[]; suggested: string[] }[] = [];
    for (const tr of rows) {
      const first = tr.querySelector("td");
      if (!first) continue;
      if (first.colSpan > 1) {
        const button = first.querySelector("button");
        if (!button) continue; // the empty-table message
        out.push({ domain: (button.querySelectorAll("span")[1]?.textContent ?? "").trim(), suggestedDomain: tr.getAttribute("data-testid") === "cmp-suggested-domain", rows: [], suggested: [] });
      } else {
        const name = (first.querySelector("span")?.childNodes[0]?.textContent ?? "").trim();
        const group = out[out.length - 1];
        if (!group) continue;
        if (tr.getAttribute("data-testid") === "cmp-suggested-row") group.suggested.push(name);
        else group.rows.push(name);
      }
    }
    return out;
  });
}
const groupOf = (groups: MatrixGroup[], capability: string) => groups.find((g) => g.rows.includes(capability))?.domain ?? null;
const allRows = (groups: MatrixGroup[]) => groups.flatMap((g) => [...g.rows, ...g.suggested]);

/** A capability's row in the parity table (the description toggle carries the capability name). */
const matrixRow = (page: Page, capability: string) =>
  parity(page).locator("table tbody tr", { has: page.getByRole("button", { name: `${capability}: show or hide the description`, exact: true }) });
/** The <td> of one competitor on a capability's row (the column is found by the header). */
async function cellTd(page: Page, capability: string, competitor: string): Promise<Locator> {
  const index = await parity(page).locator("table thead th").evaluateAll((ths, name) => ths.findIndex((th) => (th.textContent ?? "").includes(name)), competitor);
  expect(index, `column of ${competitor}`).toBeGreaterThan(1);
  return matrixRow(page, capability).locator("td").nth(index);
}
async function expectCell(page: Page, capability: string, competitor: string, value: Value): Promise<Locator> {
  const td = await cellTd(page, capability, competitor);
  await expect(td.getByRole("button").first()).toHaveAttribute("aria-label", `${capability}: ${LABEL[value]}`);
  return td;
}
/** The cell shows the seeded value and, opened, its quote and its source link on the fake site. */
async function expectSeededCell(page: Page, name: CapName, competitor: Cmp): Promise<void> {
  const seeded = CAPS.find((c) => c.name === name)!;
  const td = await expectCell(page, name, competitor.name, competitor === alpha ? seeded.alpha : seeded.beta);
  await td.getByRole("button").first().click();
  await expect(td.getByText(`“${seeded.quote}”`)).toBeVisible();
  await expect(td.getByRole("link")).toHaveAttribute("href", `${competitor.site.url}${seeded.path}`);
  await page.keyboard.press("Escape");
  await expect(td.getByText(`“${seeded.quote}”`)).toHaveCount(0);
}
/** The control status of the injected answer shows in its cell. */
const expectControl = (page: Page, competitor: Cmp) => expectCell(page, CONTROL, competitor.name, "partial");

async function openFeed(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "News feed" }).click();
  await expect(page.locator('section[aria-label="News feed"]')).toBeVisible();
}
const feedItems = (page: Page, text: string | RegExp) => page.getByTestId("cmp-feed-item").filter({ hasText: text });

async function openProfile(page: Page, competitor: string): Promise<void> {
  await page.getByRole("tab", { name: "Profiles" }).click();
  const chip = page.getByRole("group", { name: "Choose a competitor" }).getByRole("button", { name: new RegExp(`${competitor}$`) });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: competitor })).toBeVisible();
}
/** A capability's row in the profile (its accessible name starts with the capability name). */
const profileRow = (page: Page, capability: string) => page.locator('section[aria-label="Profiles"]').getByRole("button", { name: new RegExp(`^${capability}`) });

/**
 * Settings → Domains: drag a domain by its handle onto another domain's card (HTML5 drag and drop, real mouse).
 * The card under the pointer accepts the drop only once the page knows what is being dragged, so each step waits
 * for what the PM sees: the dragged card fades, the target card gets its outline, then the drop.
 */
async function dragDomain(page: Page, from: string, onto: string): Promise<void> {
  const handle = domainCard(page, from).locator('[title="Drag to reorder"]');
  const target = domainCard(page, onto);
  await target.scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const h = (await handle.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 12, h.y + h.height / 2 - 12, { steps: 4 });
  await expect(domainCard(page, from)).toHaveClass(/opacity-40/);
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.move(t.x + t.width / 2 + 4, t.y + t.height / 2 + 4, { steps: 2 });
  await expect(target).toHaveClass(/border-primary/);
  await page.mouse.up();
}

/** Settings → Capabilities → Add capability: name + domain, Save. */
async function addCapabilityInSettings(page: Page, name: string, domain: string): Promise<void> {
  await page.getByRole("button", { name: "Add capability" }).click();
  const form = page.locator("form", { has: page.getByPlaceholder("The capability name") });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Domain").selectOption({ label: domain });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
}

test.describe("Capability Analysis — PM decisions stick", () => {
  test.skip(envProblems.length > 0, envProblems.join("; "));

  test.beforeAll(async ({ browser, playwright }) => {
    if (envProblems.length) return;
    test.setTimeout(420_000);
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await seedFixtures(db);
      await isolateOtherOrgs(db, [workspaceId, workspace2Id, workspace3Id]);
    });
    mkdirSync(SCRATCH, { recursive: true });
    // Three logins for the whole file; every row reuses the sessions through storage state.
    stateFile.admin = await loginAndSave(browser, ADMIN, "ca-admin-state.json");
    stateFile.pm = await loginAndSave(browser, PM, "ca-pm-state.json");
    stateFile.member = await loginAndSave(browser, MEMBER, "ca-member-state.json");
    adminApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: stateFile.admin });
    pmApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: stateFile.pm });
    memberApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: stateFile.member });
    // The scans of this file run on the local lane at the real time (the Website Scanning rows leave both that way too).
    await postKnob(adminApi, { clockOffsetMs: 0 });
    await ok(await adminApi.patch("/api/admin/competitors/settings", { data: { remoteScanEnabled: false } }));
    keyFile = (await createStationKey(adminApi, KEY_LABEL)).file;

    // Common setup: Alpha and Beta, each on its own fake site, each scanned once by the real poller in "once" mode.
    alpha = await addCompetitor(pmApi, await startSite(fileSites), ALPHA);
    beta = await addCompetitor(pmApi, await startSite(fileSites), BETA);
    const pending = [await waitForScanWithStatus(alpha.sourceId, "pending_local"), await waitForScanWithStatus(beta.sourceId, "pending_local")];
    const r = await runStationPoller({ mac: "locked", key: keyFile });
    expect(r.code, r.stdout).toBe(0);
    for (const [i, c] of [alpha, beta].entries()) {
      const done = await waitForScanEnd(pending[i].id);
      expect(done.status, `${c.name} onboarding: ${done.error ?? ""}`).toBe("ok");
      expect(done.badge, `${c.name} onboarding badge`).toBe("full");
      expect(done.pagesFetched, `${c.name} onboarding pages`).toBe(12);
      firstScanId[c.id] = done.id;
    }
  });

  test.beforeEach(async () => {
    if (envProblems.length) return;
    await withTestDb(seedCatalog);
  });

  test.afterEach(async () => {
    if (envProblems.length) return;
    // The knob is cleared after every row, whatever happened in it.
    for (const c of [alpha, beta]) if (c) await setAnswer(c.id, null).catch(() => undefined);
    await endOpenScans();
    for (const ctx of openContexts.splice(0)) await ctx.close().catch(() => undefined);
    for (const s of rowSites.splice(0)) await s.stop().catch(() => undefined);
  });

  test.afterAll(async () => {
    if (envProblems.length) return;
    await withTestDb(async (db) => {
      await restoreOtherOrgs(db);
      await deleteFixtures(db);
    });
    for (const s of fileSites.splice(0)) await s.stop().catch(() => undefined);
    await adminApi?.dispose();
    await pmApi?.dispose();
    await memberApi?.dispose();
  });

  // ————————————————————————————— Capabilities: remove, restore —————————————————————————————

  test("CA-01 remove a capability: the dialog says it leaves the table and scans will not add it back; gone from the matrix and the Capabilities panel; Removed lists it with who and when; state removed, statuses kept; event remove [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    const page = await open(browser, "pm");
    await openSettings(page);
    await expect(removedPanel(page)).toHaveCount(0);
    await capLine(page, "Dashboards").getByRole("button", { name: "Remove" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove Dashboards?");
    await expect(dialog).toContainText("It leaves the table");
    await expect(dialog).toContainText("scans will not add it back");
    await acceptConfirm(page);

    await expect(capLine(page, "Dashboards")).toHaveCount(0);
    await expect(removedPanel(page)).toBeVisible();
    await expect(removedCapability(page, "Dashboards")).toHaveCount(1);
    await expect(removedCapability(page, "Dashboards")).toContainText(removedBy(PM.name));

    const row = await capabilityRow(cap.Dashboards);
    expect(row.state).toBe("removed");
    expect(row.removedAt).not.toBeNull();
    expect(row.removedById).toBe(pmId);
    expect(await cellsOf(cap.Dashboards), "the status rows still exist, untouched").toEqual(cellsBefore);
    expect(cellsBefore).toHaveLength(2);

    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(allRows(groups)).not.toContain("Dashboards");
    expect(allRows(groups)).toEqual(expect.arrayContaining(["Roadmap", "Prioritization scoring", "Feedback inbox", "Customer portal"]));

    const [event] = await events("cmp_catalog_edited", { action: "remove" });
    expect(event, "cmp_catalog_edited remove").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", action: "remove", entityId: cap.Dashboards, from: "active", to: "removed", name: "Dashboards" });
    expect(event.userId).toBe(pmId);
  });

  test("CA-02 a scan does not add a removed capability back: no row, no suggestion in the matrix, the feed or the Suggested panel; its status rows unchanged; scan log line; Removed lists it once; event cmp_decision_respected removed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await removeCapability(cap.Dashboards);
    // A signal the feed must show (Alpha's Feedback inbox cell changed a minute ago), so "nothing about dashboards in
    // the feed" is read off a feed that renders this org's signals. Seeded, not taken from the scan below: on the
    // local lane a re-scan's status change is logged as "first evidence … not a change" and never reaches the feed
    // (scan.ts firstScan — reported to engineering on 2026-11-10, outside this row).
    const changedAt = new Date(Date.now() - 60_000);
    await withTestDb((db) => db.capabilityStatus.update({
      where: { competitorId_capabilityId: { competitorId: alpha.id, capabilityId: cap["Feedback inbox"] } },
      data: { changedAt, history: { create: { value: "missing", quote: null, sourceUrl: null, at: changedAt } } },
    }));
    const cellsBefore = await cellsOf(cap.Dashboards);
    const catalogBefore = await catalogOf();
    const scan = await injectedScan(alpha, {
      statuses: [{ capability: "Dashboards", value: "partial", quote: "Dashboards are in beta." }],
      suggestions: [{ name: "dashboards", domain: "Reporting" }],
    });

    expect(await catalogOf(), "no capability or domain row was created or changed").toEqual(catalogBefore);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await cellsOf(cap.Dashboards), "the status rows of the removed capability").toEqual(cellsBefore);
    expect(logOf(scan)).toContain("Suggestion skipped: dashboards — your team removed this capability");
    expect(scan.suggestions).toBe(0);

    const [event] = await events("cmp_decision_respected");
    expect(event, "cmp_decision_respected").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", entityId: cap.Dashboards, name: "Dashboards", found: "dashboards", reason: "removed", competitorId: alpha.id, scanId: scan.id });
    expect(event.userId).toBeNull();
    expect(await events("cmp_decision_respected")).toHaveLength(1);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(allRows(groups).map((n) => n.toLowerCase())).not.toContain("dashboards");
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    await expect(page.getByTestId("cmp-suggestions-chip")).toHaveCount(0);
    await openFeed(page);
    await expect(feedItems(page, `${ALPHA} missing → partial on Feedback inbox`)).toHaveCount(1);
    await expect(feedItems(page, /dashboards/i)).toHaveCount(0);
    await openSettings(page);
    await expect(page.getByText("Suggested by scans", { exact: true })).toHaveCount(0);
    await expect(removedCapability(page, "Dashboards")).toHaveCount(1);
    await expect(removedPanel(page).getByTestId("cmp-removed-capability")).toHaveCount(1);

    // The line is readable where scan logs are read: Administration → Competitors (customers never see runner lines).
    const admin = await open(browser, "admin");
    await admin.goto("/admin/competitors");
    const scanRows = admin.locator("table", { has: admin.getByRole("columnheader", { name: "Lane" }) }).locator("tbody tr", { hasText: ORG.orgName }).filter({ hasText: ALPHA });
    await expect(scanRows.first()).toBeVisible({ timeout: 30_000 });
    await scanRows.first().click();
    await expect(admin.getByText("Suggestion skipped: dashboards — your team removed this capability")).toBeVisible();
  });

  test("CA-03 restore a capability: back in the matrix under Reporting with the same cells, quotes and links; the Removed panel is gone; event restore via settings with the domain it left and the domain it returns to [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    const page = await open(browser, "pm");
    await openSettings(page);
    await removedCapability(page, "Dashboards").getByTestId("cmp-restore").click();
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(capLine(page, "Dashboards")).toHaveCount(1);

    const row = await capabilityRow(cap.Dashboards);
    expect(row.state).toBe("active");
    expect(row.removedAt).toBeNull();
    expect(row.removedById).toBeNull();
    expect(row.domainId).toBe(dom.Reporting);
    expect(await cellsOf(cap.Dashboards), "the cells as they were before the removal").toEqual(cellsBefore);

    await openMatrix(page);
    expect(groupOf(await matrixGroups(page), "Dashboards")).toBe("Reporting");
    await expectSeededCell(page, "Dashboards", alpha);
    await expectSeededCell(page, "Dashboards", beta);

    const [event] = await events("cmp_catalog_edited", { action: "restore" });
    expect(event, "cmp_catalog_edited restore").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", action: "restore", entityId: cap.Dashboards, from: "removed", to: "active", name: "Dashboards", via: "settings" });
    // Round 2 (review finding 1): the event says which domain the row left and which it returned to — here the same one.
    expect(propsOf(event)).toMatchObject({ fromDomainId: dom.Reporting, toDomainId: dom.Reporting, domainChanged: false });
    expect(event.userId).toBe(pmId);
  });

  test("CA-04 adding a removed name by hand clears the removal: one active Dashboards row, no 409, the Removed panel is gone, event restore via add; (proposed) it sits in the domain picked in the form with its earlier cells [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    const page = await open(browser, "pm");
    await openSettings(page);
    await expect(removedCapability(page, "Dashboards")).toHaveCount(1);
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/competitors/capabilities");
    await addCapabilityInSettings(page, "Dashboards", "Planning");
    expect((await posted).status(), "no 409 for a removed name").toBe(201);
    await expect(page.getByText("A capability with this name already exists.")).toHaveCount(0);
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(capLine(page, "Dashboards")).toHaveCount(1);

    const rows = await capabilitiesNamed("Dashboards");
    expect(rows.map((r) => r.state), "one Dashboards row, active").toEqual(["active"]);
    expect(rows[0].removedAt).toBeNull();
    const [event] = await events("cmp_catalog_edited", { action: "restore" });
    expect(event, "cmp_catalog_edited restore").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", action: "restore", from: "removed", to: "active", name: "Dashboards", via: "add" });
    expect(event.userId).toBe(pmId);
    expect(await events("cmp_catalog_edited", { action: "create" }), "a restore, not a second row").toHaveLength(0);

    // (proposed) the same row comes back, in the domain picked in the form, with its earlier cells.
    expect(rows[0].id).toBe(cap.Dashboards);
    expect(rows[0].domainId).toBe(dom.Planning);
    expect(await cellsOf(cap.Dashboards)).toEqual(cellsBefore);
    await openMatrix(page);
    expect(groupOf(await matrixGroups(page), "Dashboards")).toBe("Planning");
    await expectSeededCell(page, "Dashboards", alpha);
  });

  // ————————————————————————————— Rename, move —————————————————————————————

  test("CA-05 a renamed capability is not suggested again under its old name: the row is Product roadmap with Beta's injected value; no row or suggestion named Roadmap; scan log line; events rename and cmp_decision_respected renamed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page);
    await capLine(page, "Roadmap").getByRole("button", { name: "Edit" }).click();
    const name = page.getByPlaceholder("The capability name");
    await expect(name).toHaveValue("Roadmap");
    await name.fill("Product roadmap");
    await name.press("Enter");
    await expect(capLine(page, "Product roadmap")).toHaveCount(1);
    await expect(capLine(page, "Roadmap")).toHaveCount(0);

    const [rename] = await events("cmp_catalog_edited", { action: "rename" });
    expect(rename, "cmp_catalog_edited rename").toBeTruthy();
    expect(propsOf(rename)).toMatchObject({ entity: "capability", action: "rename", entityId: cap.Roadmap, from: "Roadmap", to: "Product roadmap" });
    expect(rename.userId).toBe(pmId);

    const scan = await injectedScan(beta, {
      statuses: [{ capability: "Product roadmap", value: "missing", confidence: 0.9 }],
      suggestions: [{ name: "roadmap", domain: "Planning" }],
    });
    expect(logOf(scan)).toContain('Suggestion skipped: roadmap — your team renamed this capability to "Product roadmap"');
    expect(await capabilitiesNamed("Roadmap"), "no row named Roadmap").toHaveLength(0);
    expect((await capabilitiesNamed("Product roadmap")).map((r) => [r.id, r.state])).toEqual([[cap.Roadmap, "active"]]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    const [respected] = await events("cmp_decision_respected");
    expect(respected, "cmp_decision_respected").toBeTruthy();
    expect(propsOf(respected)).toMatchObject({ entity: "capability", entityId: cap.Roadmap, name: "Product roadmap", found: "roadmap", reason: "renamed", competitorId: beta.id, scanId: scan.id });
    expect(respected.userId).toBeNull();

    await openMatrix(page);
    await expectControl(page, beta);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Product roadmap")).toBe("Planning");
    expect(allRows(groups).map((n) => n.toLowerCase())).not.toContain("roadmap");
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    await expectCell(page, "Product roadmap", BETA, "missing");
  });

  test("CA-06 a moved capability stays where the PM put it: one Customer portal row under Planning; every catalog row has the same name, domain, state and position before and after the scan; event move with who, from and to [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page);
    await capLine(page, "Customer portal").getByLabel("Move to domain").selectOption({ label: "Planning" });
    await expect.poll(async () => (await capabilityRow(cap["Customer portal"])).domainId).toBe(dom.Planning);
    const [move] = await events("cmp_catalog_edited", { action: "move" });
    expect(move, "cmp_catalog_edited move").toBeTruthy();
    expect(propsOf(move)).toMatchObject({ entity: "capability", action: "move", entityId: cap["Customer portal"], from: dom.Feedback, to: dom.Planning, fromName: "Feedback", toName: "Planning" });
    expect(move.userId).toBe(pmId);

    const before = await catalogOf();
    await injectedScan(alpha, { suggestions: [{ name: "Customer portal", domain: "Feedback" }] });
    expect(await catalogOf(), "catalog rows before and after the scan").toEqual(before);
    expect((await capabilitiesNamed("Customer portal")).map((r) => [r.id, r.domainId, r.state])).toEqual([[cap["Customer portal"], dom.Planning, "active"]]);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Customer portal")).toBe("Planning");
    expect(allRows(groups).filter((n) => n === "Customer portal")).toHaveLength(1);
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
  });

  // ————————————————————————————— Domains: remove, restore —————————————————————————————

  test("CA-07 removing a domain asks where its capabilities go: Remove disabled until a domain is picked; Esc closes and nothing changes; pick Reporting + Enter → Feedback gone from the matrix and Settings, its two capabilities under Reporting with their cells; Removed lists the domain with who and when; event remove with the moved capabilities [knobs: none]", async ({ browser }) => {
    const before = await catalogOf();
    const cellsBefore = [await cellsOf(cap["Feedback inbox"]), await cellsOf(cap["Customer portal"])];
    const page = await open(browser, "pm");
    await openSettings(page);
    const dialog = page.getByTestId("cmp-move-domain-dialog");
    await domainCard(page, "Feedback").getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove Feedback?");
    await expect(dialog).toContainText("Its 2 capabilities stay in the table");
    await expect(dialog).toContainText("Move its 2 capabilities to");
    await expect(page.getByTestId("cmp-move-domain-confirm")).toBeDisabled();
    // The only choices are the other domains in the table.
    expect((await page.getByTestId("cmp-move-domain-select").locator("option:not([disabled])").allTextContents()).sort()).toEqual(["Planning", "Reporting"]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await catalogOf(), "Esc changes nothing").toEqual(before);
    expect(await events("cmp_catalog_edited")).toHaveLength(0);

    await domainCard(page, "Feedback").getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toBeVisible();
    // Enter with nothing picked does not confirm.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    expect(await catalogOf()).toEqual(before);
    await page.getByTestId("cmp-move-domain-select").selectOption({ label: "Reporting" });
    await expect(page.getByTestId("cmp-move-domain-confirm")).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);

    await expect(domainCard(page, "Feedback")).toHaveCount(0);
    expect(await settingsDomainOrder(page)).toEqual(["Planning", "Reporting"]);
    await expect(removedDomain(page, "Feedback")).toHaveCount(1);
    await expect(removedDomain(page, "Feedback")).toContainText(removedBy(PM.name));
    await expect(removedPanel(page).getByTestId("cmp-removed-capability")).toHaveCount(0);

    const feedback = await domainRow(dom.Feedback);
    expect(feedback.state).toBe("removed");
    expect(feedback.removedById).toBe(pmId);
    for (const name of ["Feedback inbox", "Customer portal"] as const) {
      const row = await capabilityRow(cap[name]);
      expect([row.domainId, row.state], name).toEqual([dom.Reporting, "active"]);
    }
    expect([await cellsOf(cap["Feedback inbox"]), await cellsOf(cap["Customer portal"])], "the cells of the moved capabilities").toEqual(cellsBefore);

    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Reporting"]);
    expect(groups[1].rows.sort()).toEqual(["Customer portal", "Dashboards", "Feedback inbox"]);
    await expectSeededCell(page, "Feedback inbox", alpha);
    await expectSeededCell(page, "Customer portal", beta);
    // The domain filter of the table does not offer it either.
    await parity(page).getByRole("button", { name: "Domain", exact: true }).click();
    await expect(parity(page).locator("div.max-h-60 button")).toHaveText(["Planning", "Reporting"]);

    const [event] = await events("cmp_catalog_edited", { action: "remove" });
    expect(event, "cmp_catalog_edited remove").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "remove", entityId: dom.Feedback, from: "active", to: "removed", name: "Feedback", movedCapabilities: 2, moveTo: dom.Reporting });
    expect(String(propsOf(event).movedCapabilityIds).split(",").sort()).toEqual([cap["Feedback inbox"], cap["Customer portal"]].sort());
    expect(event.userId).toBe(pmId);
  });

  test("CA-08 a removed domain is never suggested again: no domain 'feedback' created or suggested; Removed lists Feedback once; scan log line; event cmp_decision_respected domain removed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await removeDomain(dom.Feedback, dom.Reporting);
    const domainsBefore = (await catalogOf()).domains;
    const scan = await injectedScan(alpha, { suggestions: [{ name: "Idea voting", domain: "feedback", newDomainDescription: "Collecting and ranking customer feedback." }] });

    expect((await catalogOf()).domains, "no domain row was created or changed").toEqual(domainsBefore);
    expect((await domainsNamed("feedback")).map((d) => [d.id, d.state])).toEqual([[dom.Feedback, "removed"]]);
    expect((await suggestedRows()).domains).toBe(0);
    expect(logOf(scan)).toContain('Suggestion skipped: Idea voting — its domain "feedback" was removed by your team');
    const [event] = await events("cmp_decision_respected");
    expect(event, "cmp_decision_respected").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", entityId: dom.Feedback, name: "Feedback", found: "feedback", reason: "removed", competitorId: alpha.id, scanId: scan.id });
    expect(event.userId).toBeNull();

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain.toLowerCase())).not.toContain("feedback");
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    await openSettings(page);
    await expect(removedDomain(page, "Feedback")).toHaveCount(1);
    await expect(removedPanel(page).getByTestId("cmp-removed-domain")).toHaveCount(1);
    await expect(domainCard(page, "Feedback")).toHaveCount(0);
  });

  // Not built tonight (the plan's "Not built": it needs the analysis run). PRD: a capability found for a removed domain
  // goes to the closest active domain. Tonight the suggestion is skipped with its domain, so this half stays out.
  test.fixme("CA-08 placement half — not built, needs the analysis run: the capability found for the removed domain goes to the closest active domain [knobs: AI answer injected, fake site, run-once]", async () => {
    await removeDomain(dom.Feedback, dom.Reporting);
    await injectedScan(alpha, { suggestions: [{ name: "Idea voting", domain: "feedback", newDomainDescription: "Collecting and ranking customer feedback." }] });
    const rows = await capabilitiesNamed("Idea voting");
    expect(rows).toHaveLength(1);
    expect((await domainRow(rows[0].domainId)).state).toBe("active");
  });

  test("CA-09 restore a domain: Feedback is in the table's domains again, last in the order, with no capabilities; the two moved capabilities stay under Reporting; event restore via settings [knobs: none]", async ({ browser }) => {
    await removeDomain(dom.Feedback, dom.Reporting);
    const page = await open(browser, "pm");
    await openSettings(page);
    await removedDomain(page, "Feedback").getByTestId("cmp-restore").click();
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(domainCard(page, "Feedback")).toHaveCount(1);
    expect(await settingsDomainOrder(page)).toEqual(["Planning", "Reporting", "Feedback"]);
    await expect(domainCard(page, "Feedback")).toContainText("0 capabilities");

    const feedback = await domainRow(dom.Feedback);
    expect(feedback.state).toBe("active");
    expect(feedback.removedAt).toBeNull();
    expect(feedback.removedById).toBeNull();
    const active = await withTestDb((db) => db.competitorDomain.findMany({ where: { workspaceId, state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true } }));
    expect(active.map((d) => d.name)).toEqual(["Planning", "Reporting", "Feedback"]);
    expect(await withTestDb((db) => db.capability.count({ where: { domainId: dom.Feedback } })), "Feedback comes back empty").toBe(0);
    for (const name of ["Feedback inbox", "Customer portal"] as const) expect((await capabilityRow(cap[name])).domainId, name).toBe(dom.Reporting);

    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Feedback inbox")).toBe("Reporting");
    expect(groupOf(groups, "Customer portal")).toBe("Reporting");
    // An empty domain has no group of rows; it is one of the table's domains again, last, in the domain filter.
    await parity(page).getByRole("button", { name: "Domain", exact: true }).click();
    await expect(parity(page).locator("div.max-h-60 button")).toHaveText(["Planning", "Reporting", "Feedback"]);

    const [event] = await events("cmp_catalog_edited", { action: "restore" });
    expect(event, "cmp_catalog_edited restore").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "restore", entityId: dom.Feedback, from: "removed", to: "active", name: "Feedback", via: "settings" });
    expect(event.userId).toBe(pmId);
  });

  test("CA-10 removing an empty domain asks nothing: a plain confirm with no move question; the domain is listed under Removed [knobs: none]", async ({ browser }) => {
    const integrations = await withTestDb((db) => db.competitorDomain.create({ data: { workspaceId, name: "Integrations", description: "QA-CA fixture domain Integrations", position: 3 } }));
    const page = await open(browser, "pm");
    await openSettings(page);
    await domainCard(page, "Integrations").getByRole("button", { name: "Remove" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove Integrations?");
    await expect(dialog).toContainText("The domain has no capabilities.");
    await expect(page.getByTestId("cmp-move-domain-dialog")).toHaveCount(0);
    await expect(dialog.locator("select")).toHaveCount(0);
    await acceptConfirm(page);

    await expect(domainCard(page, "Integrations")).toHaveCount(0);
    await expect(removedDomain(page, "Integrations")).toHaveCount(1);
    await expect(removedDomain(page, "Integrations")).toContainText(removedBy(PM.name));
    expect((await domainRow(integrations.id)).state).toBe("removed");
    const [event] = await events("cmp_catalog_edited", { action: "remove" });
    expect(propsOf(event)).toMatchObject({ entity: "domain", entityId: integrations.id, name: "Integrations", movedCapabilities: 0, moveTo: null });
  });

  test("CA-11 (proposed) the only domain cannot be removed while it holds capabilities: refused with a message to add another domain or remove its capabilities first; nothing changes [knobs: none]", async ({ browser }) => {
    // A catalog with one domain holding one capability.
    await withTestDb(async (db) => {
      await db.capability.deleteMany({ where: { workspaceId, id: { not: cap.Roadmap } } });
      await db.competitorDomain.deleteMany({ where: { workspaceId, id: { not: dom.Planning } } });
    });
    const before = await catalogOf();
    expect([before.domains.length, before.capabilities.length]).toEqual([1, 1]);
    const message = "This is the only domain and it still holds capabilities. Add another domain or remove its capabilities first.";

    const page = await open(browser, "pm");
    await openSettings(page);
    await domainCard(page, "Planning").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(domainCard(page, "Planning")).toHaveCount(1);
    await expect(removedPanel(page)).toHaveCount(0);

    // The route refuses it too, with the same message.
    const res = await pmApi.delete(`/api/competitors/domains/${dom.Planning}`);
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(message);
    expect(await catalogOf(), "nothing changes").toEqual(before);
    expect(await events("cmp_catalog_edited")).toHaveLength(0);
  });

  test("CA-12 a renamed domain is still recognised: no domain named Reporting appears; Scheduled reports is attached to the domain now called Analytics [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page);
    await domainCard(page, "Reporting").getByRole("button", { name: "Edit" }).click();
    const name = domainsSection(page).getByLabel("Name");
    await expect(name).toHaveValue("Reporting");
    await name.fill("Analytics");
    await domainsSection(page).getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alertdialog")).toContainText('Rename "Reporting" to "Analytics"?');
    await acceptConfirm(page);
    await expect(domainCard(page, "Analytics")).toHaveCount(1);
    await expect(domainCard(page, "Reporting")).toHaveCount(0);
    const [rename] = await events("cmp_catalog_edited", { action: "rename" });
    expect(propsOf(rename)).toMatchObject({ entity: "domain", entityId: dom.Reporting, from: "Reporting", to: "Analytics" });

    const scan = await injectedScan(alpha, { suggestions: [{ name: "Scheduled reports", domain: "Reporting", newDomainDescription: "Reports and dashboards for the team." }] });
    expect(scan.suggestions).toBe(1);
    expect(await domainsNamed("Reporting"), "no domain named Reporting").toHaveLength(0);
    expect((await catalogOf()).domains.map((d) => [d.name, d.state]).sort()).toEqual([["Analytics", "active"], ["Feedback", "active"], ["Planning", "active"]]);
    const suggested = await capabilitiesNamed("Scheduled reports");
    expect(suggested.map((r) => [r.domainId, r.state])).toEqual([[dom.Reporting, "suggested"]]);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Feedback", "Analytics"]);
    expect(groups[2]).toMatchObject({ domain: "Analytics", suggestedDomain: false, rows: ["Dashboards"], suggested: ["Scheduled reports"] });
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
  });

  // ————————————————————————————— Order, the "new" mark —————————————————————————————

  test("CA-13 the table follows the settings order: the save succeeds with a suggested and a removed domain present; after a reload Settings and the matrix show Reporting, Planning, Feedback; event reorder with the order before and after; (proposed) a domain added afterwards lands last [knobs: none]", async ({ browser }) => {
    await withTestDb(async (db) => {
      await db.competitorDomain.create({ data: { workspaceId, name: "QA Suggested Domain", position: 9999, origin: "ai", state: "suggested", suggestedById: alpha.id } });
      await db.competitorDomain.create({ data: { workspaceId, name: "QA Removed Domain", position: 7, state: "removed", removedAt: new Date(), removedById: pmId } });
    });
    const page = await open(browser, "pm");
    await openSettings(page);
    expect(await settingsDomainOrder(page)).toEqual(["Planning", "Feedback", "Reporting"]);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/competitors/domains");
    await dragDomain(page, "Reporting", "Planning");
    expect((await saved).status(), "the order saves with suggested and removed domains present").toBe(200);
    await expect.poll(() => settingsDomainOrder(page)).toEqual(["Reporting", "Planning", "Feedback"]);

    await page.reload();
    await hydrated(page.getByRole("heading", { level: 2, name: "Domains", exact: true }));
    expect(await settingsDomainOrder(page)).toEqual(["Reporting", "Planning", "Feedback"]);
    await openMatrix(page);
    // The suggested domain has no rows, so it has no group; the three domains of the table are in the settings order.
    expect((await matrixGroups(page)).map((g) => g.domain)).toEqual(["Reporting", "Planning", "Feedback"]);

    const [event] = await events("cmp_catalog_edited", { action: "reorder" });
    expect(event, "cmp_catalog_edited reorder").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "reorder", from: [dom.Planning, dom.Feedback, dom.Reporting].join(","), to: [dom.Reporting, dom.Planning, dom.Feedback].join(",") });
    expect(event.userId).toBe(pmId);

    // (proposed) a domain added afterwards lands last among the domains in the table.
    await openSettings(page);
    await page.getByRole("button", { name: "Add domain" }).click();
    await domainsSection(page).getByLabel("Name").fill("Pricing");
    await domainsSection(page).getByRole("button", { name: "Add domain" }).click();
    await expect(domainCard(page, "Pricing")).toHaveCount(1);
    expect(await settingsDomainOrder(page)).toEqual(["Reporting", "Planning", "Feedback", "Pricing"]);
    const active = await withTestDb((db) => db.competitorDomain.findMany({ where: { workspaceId, state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { name: true, position: true } }));
    expect(active).toEqual([{ name: "Reporting", position: 0 }, { name: "Planning", position: 1 }, { name: "Feedback", position: 2 }, { name: "Pricing", position: 3 }]);
  });

  test("CA-14 the table has no 'new' mark: no button New Changes, no element labelled Changed in the last scan; cmp_matrix_viewed has no newChanges property [knobs: none]", async ({ browser }) => {
    // Alpha's cell on Roadmap changed value in its latest scan (the state the removed mark used to light up on).
    const source = await withTestDb((db) => db.competitorSource.findUniqueOrThrow({ where: { id: alpha.sourceId } }));
    expect(source.lastScanAt).not.toBeNull();
    await withTestDb((db) => db.capabilityStatus.update({
      where: { competitorId_capabilityId: { competitorId: alpha.id, capabilityId: cap.Roadmap } },
      data: { changedAt: source.lastScanAt, history: { create: { value: "partial", quote: "Roadmaps are in beta.", sourceUrl: `${alpha.site.url}/product`, at: source.lastScanAt! } } },
    }));
    const page = await open(browser, "member");
    await openMatrix(page);
    // The changed cell is on the page (and says when it changed once opened) — only the mark on the table is gone.
    const td = await expectCell(page, "Roadmap", ALPHA, "has");
    await expect(page.getByRole("button", { name: "Gaps only" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Changes" })).toHaveCount(0);
    await expect(page.getByText("New Changes")).toHaveCount(0);
    await expect(page.locator('[aria-label="Changed in the last scan"]')).toHaveCount(0);
    await expect(td.locator("button span.rounded-full.bg-primary")).toHaveCount(0);

    // The client event is flushed every 5 s.
    await expect.poll(async () => (await events("cmp_matrix_viewed")).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const [viewed] = await events("cmp_matrix_viewed");
    expect(propsOf(viewed)).toHaveProperty("capabilities", 5);
    expect(propsOf(viewed)).toHaveProperty("gapsOnly", false);
    expect(propsOf(viewed)).not.toHaveProperty("newChanges");
  });

  // ————————————————————————————— Cells —————————————————————————————

  test("CA-15 our own cell: the member's value shows at once, with no confidence and no percentage; no scan is created by the edit; event ourStatus with from and to [knobs: none]", async ({ browser }) => {
    const scansBefore = await withTestDb((db) => db.competitorScan.count({ where: { workspaceId } }));
    const page = await open(browser, "member");
    await openMatrix(page);
    const own = matrixRow(page, "Dashboards").locator("td").nth(1);
    await expect(own.getByRole("button").first()).toHaveAttribute("aria-label", `Dashboards: ${ORG.orgName} Missing`);
    await own.getByRole("button").first().click();
    await expect(own.getByText(`${ORG.orgName}'s status · Set by your team, never scanned.`)).toBeVisible();
    await expect(own).not.toContainText("%");
    await expect(own).not.toContainText(/confidence/i);
    await own.getByRole("button", { name: "Partial", exact: true }).click();
    await expect(own.getByRole("button").first()).toHaveAttribute("aria-label", `Dashboards: ${ORG.orgName} Partial`);
    await expect(own).not.toContainText("%");
    await expect(own).not.toContainText(/confidence/i);

    expect((await capabilityRow(cap.Dashboards)).ourStatus).toBe("partial");
    expect(await withTestDb((db) => db.competitorScan.count({ where: { workspaceId } })), "no scan is created by the edit").toBe(scansBefore);
    expect(await withTestDb((db) => db.localScanRequest.count({ where: { workspaceId, state: "waiting" } }))).toBe(0);
    const [event] = await events("cmp_catalog_edited", { action: "ourStatus" });
    expect(event, "cmp_catalog_edited ourStatus").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", action: "ourStatus", entityId: cap.Dashboards, from: "missing", to: "partial" });
    expect(event.userId).toBe(memberId);
  });

  test("CA-16 a PM's cell value survives the next scan: after the scan the cell still shows missing with the edited mark, Edited by the member and the date, Scan found partial; after Reset it shows partial; events cmp_status_overridden with from, to and reset [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "member");
    await openMatrix(page);
    const td = await expectCell(page, "Roadmap", ALPHA, "has");
    await td.getByRole("button").first().click();
    await td.getByRole("button", { name: "Correct this" }).click();
    await td.getByRole("button", { name: "Missing", exact: true }).click();
    await td.getByRole("button", { name: "Save", exact: true }).click();
    await expectCell(page, "Roadmap", ALPHA, "missing");
    await expect(td.locator('[aria-label="edited"]')).toHaveCount(1);

    await injectedScan(alpha, { statuses: [{ capability: "Roadmap", value: "partial", quote: "Roadmaps are limited to one team." }] });

    await openMatrix(page);
    await expectControl(page, alpha);
    const after = await expectCell(page, "Roadmap", ALPHA, "missing");
    await expect(after.locator('[aria-label="edited"]')).toHaveCount(1);
    await after.getByRole("button").first().click();
    await expect(after.getByText(`Edited by ${MEMBER.name}, ${shortDate(new Date())}`)).toBeVisible();
    await expect(after.getByText("Scan found: Partial")).toBeVisible();
    await after.getByRole("button", { name: "Reset to scanned" }).click();
    await expectCell(page, "Roadmap", ALPHA, "partial");
    await expect(after.locator('[aria-label="edited"]')).toHaveCount(0);

    const overrides = await events("cmp_status_overridden", { capabilityId: cap.Roadmap });
    expect(overrides).toHaveLength(2);
    expect(propsOf(overrides[1])).toMatchObject({ competitorId: alpha.id, from: "has", to: "missing", reset: false });
    expect(propsOf(overrides[0])).toMatchObject({ competitorId: alpha.id, from: "missing", to: "partial", reset: true });
    expect(overrides.map((o) => o.userId)).toEqual([memberId, memberId]);
  });

  // ————————————————————————————— Roles, organizations —————————————————————————————

  test("CA-17 (proposed) roles: the member sees no remove, restore, rename or move control and no Removed panel; every direct call to the remove, restore, rename, move, add and reorder routes answers 403 and nothing changes; the state sent to the member carries no removed items while the admin's lists them [knobs: none]", async ({ browser }) => {
    // Something is removed, so an admin would see the Removed panel.
    await removeCapability(cap.Dashboards);
    await withTestDb((db) => db.competitorDomain.create({ data: { workspaceId, name: "QA Removed Domain", position: 7, state: "removed", removedAt: new Date(), removedById: pmId } }));
    const removedDomainId = (await domainsNamed("QA Removed Domain"))[0].id;
    const before = await catalogOf();

    const page = await open(browser, "member");
    await openSettings(page);
    await expect(page.getByText("Only an admin can change competitors.", { exact: true })).toBeVisible();
    await expect(capLine(page, "Roadmap")).toHaveCount(1);
    await expect(domainCard(page, "Planning")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Move to domain")).toHaveCount(0);
    await expect(page.locator('[title="Drag to reorder"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add capability" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add domain" })).toHaveCount(0);
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(page.getByTestId("cmp-restore")).toHaveCount(0);
    // Positive control: the org admin gets the panel and the controls from the same state.
    const pm = await open(browser, "pm");
    await openSettings(pm);
    await expect(removedPanel(pm)).toBeVisible();
    await expect(capLine(pm, "Roadmap").getByRole("button", { name: "Remove" })).toHaveCount(1);

    // Round 2 (review finding 7): the removed names and who removed them are sent to organization admins only —
    // by the state route and inside the Settings page itself (the hidden panel is not just hidden).
    type Removed = { domains: { name: string; removedByName: string | null }[]; capabilities: { name: string; removedByName: string | null }[] };
    const removedOf = async (api: APIRequestContext): Promise<Removed> => {
      const res = await api.get("/api/competitors");
      await ok(res);
      return ((await res.json()) as { state: { removed: Removed } }).state.removed;
    };
    const forAdmin = await removedOf(pmApi);
    expect(forAdmin.capabilities.map((k) => [k.name, k.removedByName]), "the admin's state lists the removed capability").toEqual([["Dashboards", PM.name]]);
    expect(forAdmin.domains.map((d) => [d.name, d.removedByName]), "the admin's state lists the removed domain").toEqual([["QA Removed Domain", PM.name]]);
    expect(await removedOf(memberApi), "the member's state").toEqual({ domains: [], capabilities: [] });
    expect(await pm.content(), "the admin's Settings page carries the removed domain's name").toContain("QA Removed Domain");
    expect(await page.content(), "the member's Settings page does not carry it").not.toContain("QA Removed Domain");

    const order = [dom.Reporting, dom.Planning, dom.Feedback];
    const calls: [string, () => Promise<APIResponse>][] = [
      ["remove a capability", () => memberApi.delete(`/api/competitors/capabilities/${cap.Roadmap}`)],
      ["remove a domain", () => memberApi.delete(`/api/competitors/domains/${dom.Feedback}?moveTo=${dom.Planning}`)],
      ["restore a capability", () => memberApi.patch(`/api/competitors/capabilities/${cap.Dashboards}`, { data: { state: "active" } })],
      ["restore a domain", () => memberApi.patch(`/api/competitors/domains/${removedDomainId}`, { data: { state: "active" } })],
      ["rename a capability", () => memberApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { name: "Member roadmap" } })],
      ["rename a domain", () => memberApi.patch(`/api/competitors/domains/${dom.Planning}`, { data: { name: "Member planning" } })],
      ["move a capability", () => memberApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { domainId: dom.Feedback } })],
      ["add a capability", () => memberApi.post("/api/competitors/capabilities", { data: { name: "Member capability", domainId: dom.Planning } })],
      ["add a removed capability back", () => memberApi.post("/api/competitors/capabilities", { data: { name: "Dashboards", domainId: dom.Planning } })],
      ["add a domain", () => memberApi.post("/api/competitors/domains", { data: { name: "Member domain" } })],
      ["reorder the domains", () => memberApi.put("/api/competitors/domains", { data: { order } })],
    ];
    for (const [what, call] of calls) expect((await call()).status(), what).toBe(403);
    expect(await catalogOf(), "nothing changes").toEqual(before);
    expect(await events("cmp_catalog_edited", { action: "remove" }), "only the setup's removal is recorded").toHaveLength(1);
    expect((await events("cmp_catalog_edited")).filter((e) => e.userId === memberId)).toHaveLength(0);
  });

  test("CA-18 (proposed) organizations are separate: with Dashboards removed in the first org, the second org keeps its Dashboards row and gets its suggestion, and the third org gets a new row [knobs: AI answer injected, fake site, run-once]", async ({ browser, playwright }) => {
    test.setTimeout(300_000);
    await removeCapability(cap.Dashboards);

    // The second org: its own catalog (Dashboards under Reporting, the control capability) and a competitor on the fake site.
    const pm2State = await loginAndSave(browser, PM2, "ca-pm2-state.json");
    const pm2Api = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: pm2State });
    const pm3State = await loginAndSave(browser, PM3, "ca-pm3-state.json");
    const pm3Api = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: pm3State });
    let gamma: Cmp | undefined;
    try {
      gamma = await addCompetitor(pm2Api, await startSite(rowSites), "QA-CA Gamma");
      const onboarding = await waitForScanWithStatus(gamma.sourceId, "pending_local");
      expect((await runStationPoller({ mac: "locked", key: keyFile })).code).toBe(0);
      const first = await waitForScanEnd(onboarding.id);
      expect(first.status, `QA-CA Gamma onboarding: ${first.error ?? ""}`).toBe("ok");
      const gammaId = gamma.id;
      const second = await withTestDb(async (db) => {
        const reporting = await db.competitorDomain.create({ data: { workspaceId: workspace2Id, name: "Reporting", position: 0 } });
        const dashboards = await db.capability.create({ data: { workspaceId: workspace2Id, domainId: reporting.id, name: "Dashboards", ourStatus: "has", position: 0 } });
        const scoring = await db.capability.create({ data: { workspaceId: workspace2Id, domainId: reporting.id, name: CONTROL, ourStatus: "has", position: 1 } });
        for (const k of [dashboards, scoring]) {
          await db.capabilityStatus.create({ data: { workspaceId: workspace2Id, competitorId: gammaId, capabilityId: k.id, value: "has", confidence: 0.9, quote: "Dashboards for every team.", sourceUrl: `${gamma!.site.url}/pricing`, scanId: first.id } });
        }
        return { reportingId: reporting.id, dashboardsId: dashboards.id };
      });
      // Scan now by the second org's own PM: the onboarding scan is not a rescan, so the daily limit allows this one.
      const scan = await injectedScan(gamma, { suggestions: [{ name: "Dashboards 2", domain: "Reporting" }] }, pm2Api);
      expect(scan.suggestions).toBe(1);

      // The second org keeps its row and gets its suggestion.
      expect((await capabilitiesNamed("Dashboards", workspace2Id)).map((r) => [r.id, r.state])).toEqual([[second.dashboardsId, "active"]]);
      expect((await capabilitiesNamed("Dashboards 2", workspace2Id)).map((r) => [r.domainId, r.state])).toEqual([[second.reportingId, "suggested"]]);
      expect(await events("cmp_decision_respected", {}, workspace2Id), "nothing of the first org's decisions applies here").toHaveLength(0);
      const page = await open(browser, pm2State);
      await openMatrix(page);
      await expectCell(page, CONTROL, "QA-CA Gamma", "partial");
      const groups = await matrixGroups(page);
      expect(groups).toEqual([{ domain: "Reporting", suggestedDomain: false, rows: ["Dashboards", CONTROL], suggested: ["Dashboards 2"] }]);
      await openSettings(page);
      await expect(removedPanel(page)).toHaveCount(0);

      // The third org is empty: adding Dashboards by hand creates a new row (201, a create — not the restore of another org's row).
      await ok(await pm3Api.post("/api/competitors/domains", { data: { name: "Reporting" } }), 201);
      const reporting3 = (await domainsNamed("Reporting", workspace3Id))[0];
      await ok(await pm3Api.post("/api/competitors/capabilities", { data: { name: "Dashboards", domainId: reporting3.id } }), 201);
      const third = await capabilitiesNamed("Dashboards", workspace3Id);
      expect(third.map((r) => [r.domainId, r.state, r.origin])).toEqual([[reporting3.id, "active", "manual"]]);
      expect(third[0].id).not.toBe(cap.Dashboards);
      expect(await events("cmp_catalog_edited", { action: "create", entity: "capability", name: "Dashboards" }, workspace3Id)).toHaveLength(1);
      expect(await events("cmp_catalog_edited", { action: "restore" }, workspace3Id)).toHaveLength(0);

      // The first org's removal stands, in the first org only.
      const mine = await capabilitiesNamed("Dashboards");
      expect(mine.map((r) => [r.id, r.state])).toEqual([[cap.Dashboards, "removed"]]);
    } finally {
      if (gamma) await setAnswer(gamma.id, null).catch(() => undefined);
      await withTestDb((db) => db.competitor.updateMany({ where: { workspaceId: workspace2Id, deletedAt: null }, data: { deletedAt: new Date() } }));
      await pm2Api.dispose();
      await pm3Api.dispose();
    }
  });

  test("CA-19 (proposed) a removed capability leaves the feed and the profile: while removed no feed item and no profile row for Dashboards; after the restore both are back [knobs: none]", async ({ browser }) => {
    // Alpha's cell on Dashboards changed in its latest scan (missing → has; the org's own status is missing → a gap signal).
    const changedAt = new Date(Date.now() - 60_000);
    await withTestDb((db) => db.capabilityStatus.update({
      where: { competitorId_capabilityId: { competitorId: alpha.id, capabilityId: cap.Dashboards } },
      data: { changedAt, history: { create: { value: "missing", quote: null, sourceUrl: null, at: changedAt } } },
    }));
    const signal = `${ALPHA} missing → has it on Dashboards`;
    const page = await open(browser, "member");
    // Positive control: before the removal the signal and the profile row are there.
    await openMatrix(page);
    await openFeed(page);
    await expect(feedItems(page, signal)).toHaveCount(1);
    await openProfile(page, ALPHA);
    await expect(profileRow(page, "Dashboards")).toHaveCount(1);

    await removeCapability(cap.Dashboards);
    await openMatrix(page);
    await openFeed(page);
    await expect(page.locator('section[aria-label="News feed"]')).toBeVisible();
    await expect(feedItems(page, /Dashboards/)).toHaveCount(0);
    await openProfile(page, ALPHA);
    await expect(profileRow(page, "Roadmap")).toHaveCount(1);
    await expect(profileRow(page, "Dashboards")).toHaveCount(0);
    await expect(page.locator('section[aria-label="Profiles"]')).not.toContainText("Dashboards");

    await ok(await pmApi.patch(`/api/competitors/capabilities/${cap.Dashboards}`, { data: { state: "active" } }));
    await openMatrix(page);
    await openFeed(page);
    await expect(feedItems(page, signal)).toHaveCount(1);
    await openProfile(page, ALPHA);
    await expect(profileRow(page, "Dashboards")).toHaveCount(1);
    await expect(profileRow(page, "Dashboards")).toContainText(`Changed ${shortDate(changedAt)}`);
  });

  // ————————————————————————————— Names added by hand —————————————————————————————

  test("CA-20 (proposed) a name added by hand wins over a replaced name: two rows, Product roadmap and Roadmap; no third row and no suggestion; Product roadmap no longer keeps Roadmap as a replaced name [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await ok(await pmApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { name: "Product roadmap" } }));
    expect((await capabilityRow(cap.Roadmap)).aliases, "the rename keeps the replaced name").toEqual(["Roadmap"]);
    await ok(await pmApi.post("/api/competitors/capabilities", { data: { name: "Roadmap", domainId: dom.Planning } }), 201);
    const added = await capabilitiesNamed("Roadmap");
    expect(added.map((r) => [r.state, r.origin, r.domainId])).toEqual([["active", "manual", dom.Planning]]);
    expect(added[0].id).not.toBe(cap.Roadmap);
    expect((await capabilityRow(cap.Roadmap)).aliases, "Product roadmap no longer keeps Roadmap as a replaced name").toEqual([]);

    const before = await catalogOf();
    const scan = await injectedScan(alpha, { suggestions: [{ name: "roadmap", domain: "Planning" }] });
    expect(scan.suggestions).toBe(0);
    expect(await catalogOf(), "no third row").toEqual(before);
    expect(before.capabilities.filter((k) => /roadmap/i.test(k.name)).map((k) => k.name).sort()).toEqual(["Product roadmap", "Roadmap"]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await events("cmp_decision_respected"), "the name is a row of the table today, not a replaced name").toHaveLength(0);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.find((g) => g.domain === "Planning")!.rows.filter((n) => /roadmap/i.test(n)).sort()).toEqual(["Product roadmap", "Roadmap"]);
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
  });

  test("CA-21 a capability added by hand is looked for at every competitor: both cells on SSO show the injected value and quote; event create [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await open(browser, "pm");
    await openSettings(page);
    await addCapabilityInSettings(page, "SSO", "Planning");
    await expect(capLine(page, "SSO")).toHaveCount(1);
    const [sso] = await capabilitiesNamed("SSO");
    expect([sso.state, sso.origin, sso.domainId]).toEqual(["active", "manual", dom.Planning]);
    const [created] = await events("cmp_catalog_edited", { action: "create" });
    expect(created, "cmp_catalog_edited create").toBeTruthy();
    expect(propsOf(created)).toMatchObject({ entity: "capability", action: "create", entityId: sso.id, from: null, to: "SSO", name: "SSO" });
    expect(created.userId).toBe(pmId);

    const quote = { [alpha.id]: "Single sign-on with SAML on every plan.", [beta.id]: "Single sign-on through any SAML provider." };
    for (const c of [alpha, beta]) {
      await injectedScan(c, { statuses: [{ capability: "SSO", value: "has", confidence: 0.9, quote: quote[c.id], url: `${c.site.url}/product/features` }] });
    }
    const cells = await cellsOf(sso.id);
    expect(cells.map((s) => [s.competitorId, s.value, s.quote]).sort()).toEqual([alpha, beta].map((c) => [c.id, "has", quote[c.id]]).sort());

    await openMatrix(page);
    for (const c of [alpha, beta]) {
      await expectControl(page, c);
      const td = await expectCell(page, "SSO", c.name, "has");
      await td.getByRole("button").first().click();
      await expect(td.getByText(`“${quote[c.id]}”`)).toBeVisible();
      await expect(td.getByRole("link")).toHaveAttribute("href", `${c.site.url}/product/features`);
      await page.keyboard.press("Escape");
    }
  });

  test("CA-22 a domain added by hand receives capabilities: Usage billing is attached to Pricing; no suggested domain is created [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page);
    await page.getByRole("button", { name: "Add domain" }).click();
    await domainsSection(page).getByLabel("Name").fill("Pricing");
    await domainsSection(page).getByRole("button", { name: "Add domain" }).click();
    await expect(domainCard(page, "Pricing")).toHaveCount(1);
    const [pricing] = await domainsNamed("Pricing");
    expect([pricing.state, pricing.origin]).toEqual(["active", "manual"]);

    const scan = await injectedScan(alpha, { suggestions: [{ name: "Usage billing", domain: "pricing", newDomainDescription: "How the product is priced and billed." }] });
    expect(scan.suggestions).toBe(1);
    expect((await capabilitiesNamed("Usage billing")).map((r) => [r.domainId, r.state])).toEqual([[pricing.id, "suggested"]]);
    expect((await domainsNamed("pricing")).map((d) => [d.id, d.state]), "one Pricing domain, the PM's").toEqual([[pricing.id, "active"]]);
    expect((await suggestedRows()).domains, "no suggested domain").toBe(0);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.find((g) => g.domain === "Pricing")).toEqual({ domain: "Pricing", suggestedDomain: false, rows: [], suggested: ["Usage billing"] });
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
  });

  test("CA-23 a declined domain is not suggested again: no suggested domain appears and Billing is still declined; no Invoices row; event cmp_decision_respected domain dismissed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    // A suggested domain "Billing" (as a scan leaves it), declined through the route.
    const billing = await withTestDb((db) => db.competitorDomain.create({ data: { workspaceId, name: "Billing", description: "Invoices and payments.", position: 9999, origin: "ai", state: "suggested", suggestedById: alpha.id } }));
    await ok(await pmApi.patch(`/api/competitors/domains/${billing.id}`, { data: { state: "dismissed" } }));
    expect((await domainRow(billing.id)).state).toBe("dismissed");
    const before = await catalogOf();

    const scan = await injectedScan(alpha, { suggestions: [{ name: "Invoices", domain: "billing", newDomainDescription: "Invoices and payments." }] });
    expect(scan.suggestions).toBe(0);
    expect(await catalogOf(), "no row was created or changed").toEqual(before);
    expect((await domainsNamed("billing")).map((d) => [d.id, d.state])).toEqual([[billing.id, "dismissed"]]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await capabilitiesNamed("Invoices")).toHaveLength(0);
    expect(logOf(scan)).toContain('Suggestion skipped: Invoices — its domain "billing" was dismissed earlier');
    const [event] = await events("cmp_decision_respected");
    expect(event, "cmp_decision_respected").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", entityId: billing.id, name: "Billing", found: "billing", reason: "dismissed", competitorId: alpha.id, scanId: scan.id });
    expect(event.userId).toBeNull();

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    expect((await matrixGroups(page)).map((g) => g.domain)).toEqual(["Planning", "Feedback", "Reporting"]);
  });

  test("CA-24 (proposed) restoring a capability whose domain is not in the table asks where it returns: Restore disabled until a domain is picked, the line says its domain is not in the table; pick Planning → Dashboards under Planning with its earlier cells; Reporting stays removed; event restore from Reporting to Planning [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    await removeDomain(dom.Reporting); // it holds nothing else: no move question
    expect((await domainRow(dom.Reporting)).state).toBe("removed");

    const page = await open(browser, "pm");
    await openSettings(page);
    const line = removedCapability(page, "Dashboards");
    await expect(line).toContainText('Its domain "Reporting" is not in the table. Pick the domain it returns to.');
    await expect(line.getByTestId("cmp-restore")).toBeDisabled();
    expect((await line.getByTestId("cmp-restore-domain").locator("option:not([disabled])").allTextContents()).sort()).toEqual(["Feedback", "Planning"]);
    await line.getByTestId("cmp-restore-domain").selectOption({ label: "Planning" });
    await expect(line.getByTestId("cmp-restore")).toBeEnabled();
    await line.getByTestId("cmp-restore").click();
    await expect(removedCapability(page, "Dashboards")).toHaveCount(0);
    await expect(removedDomain(page, "Reporting")).toHaveCount(1);
    await expect(capLine(page, "Dashboards")).toHaveCount(1);

    const row = await capabilityRow(cap.Dashboards);
    expect([row.state, row.domainId, row.removedAt]).toEqual(["active", dom.Planning, null]);
    expect((await domainRow(dom.Reporting)).state, "Reporting stays removed").toBe("removed");
    expect(await cellsOf(cap.Dashboards)).toEqual(cellsBefore);

    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Dashboards")).toBe("Planning");
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Feedback"]);
    await expectSeededCell(page, "Dashboards", alpha);
    await expectSeededCell(page, "Dashboards", beta);
    const [event] = await events("cmp_catalog_edited", { action: "restore", via: "settings" });
    expect(propsOf(event)).toMatchObject({ entity: "capability", entityId: cap.Dashboards, name: "Dashboards", domainChanged: true });
    // Round 2 (review finding 1): the value before and the value after of the move that came with the restore.
    expect(propsOf(event)).toMatchObject({ fromDomainId: dom.Reporting, toDomainId: dom.Planning });
    expect(event.userId).toBe(pmId);
  });

  // ————————————————————————————— Round 2: the code-review fixes (7d1964e) —————————————————————————————

  test("CA-25 accepting a suggestion with a new name and another domain records each change: one request {state, name, domainId}; the row is Report scheduling under Planning with Alpha's cell; events rename (from, to), move (from, to) and cmp_capability_suggestion accepted [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const scan = await injectedScan(alpha, { suggestions: [{ name: "Scheduled reports", domain: "Reporting" }] });
    expect(scan.suggestions).toBe(1);
    const suggestion = await capabilityNamed("Scheduled reports");
    expect([suggestion.state, suggestion.domainId, suggestion.suggestedById]).toEqual(["suggested", dom.Reporting, alpha.id]);

    const page = await open(browser, "pm");
    await openSettings(page);
    const panel = suggestionsPanel(page);
    await expect(panel.getByLabel("Capability name")).toHaveValue("Scheduled reports");
    await panel.getByLabel("Capability name").fill("Report scheduling");
    await panel.getByLabel("Domain").selectOption({ label: "Planning" });
    const sent = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/competitors/capabilities/${suggestion.id}`);
    await panel.getByRole("button", { name: "Accept", exact: true }).click();
    const request = await sent;
    expect(request.postDataJSON(), "the decision, the rename and the move travel in one request").toEqual({ state: "active", name: "Report scheduling", domainId: dom.Planning });
    expect((await request.response())?.status()).toBe(200);
    await expect(page.getByText("Suggested by scans", { exact: true })).toHaveCount(0);
    await expect(capLine(page, "Report scheduling")).toHaveCount(1);
    // The accepted row is still the scan's find (CA-27 asserts the opposite for a name a PM adds by hand).
    await expect(capLine(page, "Report scheduling")).toContainText("PMOS AI");

    const row = await capabilityRow(suggestion.id);
    expect([row.name, row.state, row.domainId, row.origin]).toEqual(["Report scheduling", "active", dom.Planning, "ai"]);
    expect(row.aliases, "the replaced name is kept behind the row").toEqual(["Scheduled reports"]);
    expect(await capabilitiesNamed("Scheduled reports"), "no row keeps the suggested name").toHaveLength(0);

    // Each change is recorded with who, the value before and the value after — beside the decision itself.
    const renames = await events("cmp_catalog_edited", { action: "rename" });
    expect(renames, "cmp_catalog_edited rename").toHaveLength(1);
    expect(propsOf(renames[0])).toMatchObject({ entity: "capability", action: "rename", entityId: suggestion.id, field: "name", from: "Scheduled reports", to: "Report scheduling" });
    expect(renames[0].userId).toBe(pmId);
    const moves = await events("cmp_catalog_edited", { action: "move" });
    expect(moves, "cmp_catalog_edited move").toHaveLength(1);
    expect(propsOf(moves[0])).toMatchObject({ entity: "capability", action: "move", entityId: suggestion.id, field: "domain", from: dom.Reporting, to: dom.Planning, fromName: "Reporting", toName: "Planning" });
    expect(moves[0].userId).toBe(pmId);
    const decisions = await events("cmp_capability_suggestion");
    expect(decisions, "cmp_capability_suggestion").toHaveLength(1);
    expect(propsOf(decisions[0])).toMatchObject({ capabilityId: suggestion.id, competitorId: alpha.id, decision: "accepted", domainChanged: true });
    expect(decisions[0].userId).toBe(pmId);
    expect(await events("cmp_catalog_edited"), "the rename and the move, nothing else").toHaveLength(2);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Report scheduling")).toBe("Planning");
    expect(allRows(groups)).not.toContain("Scheduled reports");
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    await expectCell(page, "Report scheduling", ALPHA, "has");
  });

  test("CA-26 (proposed) a capability enters the table only inside a domain that is in the table: accepting a declined suggestion whose domain is declined or removed answers 400 and nothing changes; with a domain of the table picked it is accepted, last in the order; a suggestion waiting in a removed domain moves with its capabilities [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const message = "Pick a domain that is in the table.";
    const scan = await injectedScan(alpha, { suggestions: [
      { name: "Invoices", domain: "Billing", newDomainDescription: "Invoices and payments." },
      { name: "Scheduled reports", domain: "Reporting" },
      { name: "Report builder", domain: "Reporting" },
    ] });
    expect(scan.suggestions).toBe(3);
    const invoices = await capabilityNamed("Invoices");
    const scheduled = await capabilityNamed("Scheduled reports");
    const builder = await capabilityNamed("Report builder");
    const [billing] = await domainsNamed("Billing");
    expect([billing.state, invoices.state, invoices.domainId], "the scan suggested the domain with its capability").toEqual(["suggested", "suggested", billing.id]);

    // The PM declines the suggested domain (its suggestion goes with it), declines Scheduled reports, then removes
    // Reporting: Dashboards and the suggestion still waiting there move to Planning, the declined one stays behind.
    await declineDomain(billing.id);
    expect([(await domainRow(billing.id)).state, (await capabilityRow(invoices.id)).state]).toEqual(["dismissed", "dismissed"]);
    await declineCapability(scheduled.id);
    await removeDomain(dom.Reporting, dom.Planning);
    expect((await domainRow(dom.Reporting)).state).toBe("removed");
    for (const [id, state, what] of [[cap.Dashboards, "active", "Dashboards"], [builder.id, "suggested", "Report builder"]] as const) {
      const moved = await capabilityRow(id);
      expect([moved.domainId, moved.state], `${what} moved with the removal`).toEqual([dom.Planning, state]);
    }
    const [removal] = await events("cmp_catalog_edited", { action: "remove" });
    expect(propsOf(removal)).toMatchObject({ entity: "domain", entityId: dom.Reporting, movedCapabilities: 2, moveTo: dom.Planning });
    expect([(await capabilityRow(scheduled.id)).domainId, (await capabilityRow(scheduled.id)).state], "the declined suggestion stays in the removed domain").toEqual([dom.Reporting, "dismissed"]);

    // Accepting either declined suggestion now would put a row of the table inside a domain that is not in it.
    const before = await catalogOf();
    const lastPosition = Math.max(...before.capabilities.filter((k) => k.state === "active").map((k) => k.position));
    for (const [id, what] of [[invoices.id, "Invoices (its domain was declined)"], [scheduled.id, "Scheduled reports (its domain was removed)"]] as const) {
      const res = await pmApi.patch(`/api/competitors/capabilities/${id}`, { data: { state: "active" } });
      expect(res.status(), what).toBe(400);
      expect(((await res.json()) as { error: string }).error, what).toBe(message);
      expect(await cellsOf(id), `${what}: no cell is written`).toHaveLength(0);
    }
    expect(await catalogOf(), "nothing changes").toEqual(before);
    expect(await events("cmp_capability_suggestion", { decision: "accepted" }), "no acceptance is recorded").toHaveLength(0);

    // With a domain of the table picked the same row is accepted: it gets the next place in the order and Alpha's cell.
    await ok(await pmApi.patch(`/api/competitors/capabilities/${scheduled.id}`, { data: { state: "active", domainId: dom.Planning } }));
    const accepted = await capabilityRow(scheduled.id);
    expect([accepted.state, accepted.domainId, accepted.position]).toEqual(["active", dom.Planning, lastPosition + 1]);
    expect((await cellsOf(scheduled.id)).map((s) => [s.competitorId, s.value])).toEqual([[alpha.id, "has"]]);
    const [decision] = await events("cmp_capability_suggestion", { decision: "accepted" });
    expect(propsOf(decision)).toMatchObject({ capabilityId: scheduled.id, competitorId: alpha.id, decision: "accepted", domainChanged: true });
    expect((await capabilityRow(invoices.id)).state, "Invoices stays declined").toBe("dismissed");

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Feedback"]);
    expect(groups[0]).toEqual({ domain: "Planning", suggestedDomain: false, rows: ["Roadmap", "Prioritization scoring", "Dashboards", "Scheduled reports"], suggested: ["Report builder"] });
    expect(allRows(groups)).not.toContain("Invoices");
    await expectCell(page, "Scheduled reports", ALPHA, "has");
  });

  test("CA-27 (proposed) a declined suggestion a PM adds by hand is his row: Scheduled reports → the same row, active, origin manual, no suggesting competitor and no suggestion quote, no PMOS AI mark, no longer a suggestion in the feed; Billing → the same domain, active, origin manual, empty; events restore via add from dismissed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const scan = await injectedScan(alpha, { suggestions: [
      { name: "Scheduled reports", domain: "Reporting" },
      { name: "Invoices", domain: "Billing", newDomainDescription: "Invoices and payments." },
    ] });
    expect(scan.suggestions).toBe(2);
    const scheduled = await capabilityNamed("Scheduled reports");
    const invoices = await capabilityNamed("Invoices");
    const [billing] = await domainsNamed("Billing");
    expect([scheduled.origin, scheduled.suggestedById, billing.origin, billing.suggestedById]).toEqual(["ai", alpha.id, "ai", alpha.id]);
    expect(scheduled.suggestedQuote, "the suggestion carries the scan's quote").toContain("Listed on the pricing page.");
    await declineCapability(scheduled.id);
    await declineDomain(billing.id);

    const page = await open(browser, "pm");
    // Positive control: the declined suggestion is a feed item before the PM adds the name himself.
    await openMatrix(page);
    await openFeed(page);
    await expect(feedItems(page, "Scheduled reports")).toHaveCount(1);

    await openSettings(page);
    await expect(page.getByText("Suggested by scans", { exact: true })).toHaveCount(0);
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/competitors/capabilities");
    await addCapabilityInSettings(page, "Scheduled reports", "Planning");
    expect((await posted).status(), "no 409 for a declined name").toBe(201);
    await expect(capLine(page, "Scheduled reports")).toHaveCount(1);
    await expect(capLine(page, "Scheduled reports")).not.toContainText("PMOS AI");

    const rows = await capabilitiesNamed("Scheduled reports");
    expect(rows.map((r) => [r.id, r.state, r.domainId]), "one row with the name: the declined one, now in the table").toEqual([[scheduled.id, "active", dom.Planning]]);
    expect([rows[0].origin, rows[0].suggestedById, rows[0].suggestedQuote], "it is the PM's row, not the scan's").toEqual(["manual", null, null]);
    const [restored] = await events("cmp_catalog_edited", { action: "restore", entity: "capability" });
    expect(restored, "cmp_catalog_edited restore (capability)").toBeTruthy();
    expect(propsOf(restored)).toMatchObject({ entityId: scheduled.id, from: "dismissed", to: "active", name: "Scheduled reports", via: "add" });
    expect(restored.userId).toBe(pmId);

    // The same for a declined domain.
    await page.getByRole("button", { name: "Add domain" }).click();
    await domainsSection(page).getByLabel("Name").fill("Billing");
    await domainsSection(page).getByRole("button", { name: "Add domain" }).click();
    await expect(domainCard(page, "Billing")).toHaveCount(1);
    await expect(domainCard(page, "Billing")).toContainText("0 capabilities");
    const domains = await domainsNamed("Billing");
    expect(domains.map((d) => [d.id, d.state, d.origin, d.suggestedById]), "one Billing domain: the declined one, now the PM's").toEqual([[billing.id, "active", "manual", null]]);
    expect((await capabilityRow(invoices.id)).state, "the suggestion declined with the domain stays declined").toBe("dismissed");
    const [restoredDomain] = await events("cmp_catalog_edited", { action: "restore", entity: "domain" });
    expect(restoredDomain, "cmp_catalog_edited restore (domain)").toBeTruthy();
    expect(propsOf(restoredDomain)).toMatchObject({ entityId: billing.id, from: "dismissed", to: "active", name: "Billing", via: "add" });
    expect(await events("cmp_catalog_edited", { action: "create" }), "two restores, no second row").toHaveLength(0);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Scheduled reports")).toBe("Planning");
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    await openFeed(page);
    await expect(feedItems(page, "Scheduled reports"), "a row the PM added is not a suggestion in the feed").toHaveCount(0);
  });

  test("CA-28 (proposed) renaming a capability to a declined suggestion's name succeeds: Dashboards becomes Scheduled reports with no 'already exists' error; one row has the name, the declined row is gone; the cells stay; event rename [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const scan = await injectedScan(alpha, { suggestions: [{ name: "Scheduled reports", domain: "Reporting" }] });
    expect(scan.suggestions).toBe(1);
    const declined = await capabilityNamed("Scheduled reports");
    await declineCapability(declined.id);
    expect((await capabilityRow(declined.id)).state).toBe("dismissed");
    const cellsBefore = await cellsOf(cap.Dashboards);

    const page = await open(browser, "pm");
    await openSettings(page);
    await capLine(page, "Dashboards").getByRole("button", { name: "Edit" }).click();
    const name = page.getByPlaceholder("The capability name");
    await expect(name).toHaveValue("Dashboards");
    await name.fill("Scheduled reports");
    const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/competitors/capabilities/${cap.Dashboards}`);
    await name.press("Enter");
    expect((await patched).status(), "no 409 for a declined name").toBe(200);
    await expect(capLine(page, "Scheduled reports")).toHaveCount(1);
    await expect(capLine(page, "Dashboards")).toHaveCount(0);
    await expect(page.getByText("A capability with this name already exists.")).toHaveCount(0);

    const rows = await capabilitiesNamed("Scheduled reports");
    expect(rows.map((r) => [r.id, r.state, r.domainId]), "one row with the name: the renamed capability").toEqual([[cap.Dashboards, "active", dom.Reporting]]);
    expect(rows[0].aliases, "the replaced name is kept behind the row").toEqual(["Dashboards"]);
    expect(await withTestDb((db) => db.capability.findUnique({ where: { id: declined.id } })), "the declined row is gone").toBeNull();
    expect(await capabilitiesNamed("Dashboards")).toHaveLength(0);
    expect(await cellsOf(cap.Dashboards), "the cells of the renamed capability").toEqual(cellsBefore);
    const [rename] = await events("cmp_catalog_edited", { action: "rename" });
    expect(rename, "cmp_catalog_edited rename").toBeTruthy();
    expect(propsOf(rename)).toMatchObject({ entity: "capability", action: "rename", entityId: cap.Dashboards, from: "Dashboards", to: "Scheduled reports" });
    expect(rename.userId).toBe(pmId);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Scheduled reports")).toBe("Reporting");
    expect(allRows(groups).filter((n) => n === "Scheduled reports")).toHaveLength(1);
    await expect(page.getByTestId("cmp-suggested-row")).toHaveCount(0);
    await expectCell(page, "Scheduled reports", ALPHA, "has");
  });
});
