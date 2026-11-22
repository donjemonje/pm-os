import { expect, test, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import type { FakeSite } from "../fixtures/fake-site/fake-site";
import {
  addCompetitor, createStationKey, expectOnlyOwnRequestsWaiting, isolateOtherOrgs, postKnob, restoreOtherOrgs, runStationPoller, scanNow, SCRATCH, startSite,
  waitForScanEnd, waitForScanWithStatus, type Cmp,
} from "./competitors-helpers";
import { acceptConfirm, hashPasswordLikeApp, hydrated, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";

/**
 * Competitors — Capability Analysis, "PM decisions stick" (QA rows CA-01 … CA-28 of the Capability Analysis PRD).
 * What a PM decides about the catalog — remove, restore, rename, move, order, the organization's own cell, a corrected
 * cell — is recorded, and an analysis never reopens it.
 *
 * History: written 2026-11-10/11 against the scan's PMOS AI step (CA-01 … CA-28). Rewritten 2026-11-22 for today's
 * product, because three things changed under it:
 *   1. The analysis is its own run after the scan (PRD "How the analysis runs", decided 2026-11-11): map, reading,
 *      match, second look, apply. The old knob shape (aiAnswers.classify / facts) is refused by the knobs route.
 *   2. Cell values are found / low / not_found (2026-11-11). A cell follows the evidence by fixed rules: a quote on a
 *      strong page = found. PMOS AI does not decide the cell.
 *   3. Settings → Competitors: sections start closed (2026-11-12); a capability is a short row that opens downward
 *      (2026-11-22) — its domain is changed in the open row, there is no "Move to domain" select and no Edit button.
 *   And: an analysis never creates a suggested capability or a suggested domain. An item of a competitor that is none
 *   of ours becomes a row of the table, in a domain that is in the table, named by its code (the match is given our
 *   domains as a closed set). So "a suggestion in domain X" of the old rows is now "an item the match places in X".
 *   The rows test what the PRD rows still say; where a PRD row says something the product no longer does, the test
 *   says so in a "PRD question" comment and the report lists it for Daniel.
 *
 * Common setup (every row): one QA org (QA-CA Org, setup done) with a PM-OS admin (knobs, Scan now without the daily
 * limit), an org admin ("the admin" of the rows) and a member (role USER; the same permissions, CA-17). Two
 * competitors, Alpha and Beta, each on its own fake site, scanned once in beforeAll by the real station poller and
 * analysed once on an empty injected answer (every page read, nothing listed) — so in a row only the page the row
 * changes is read, and its reading request holds that one page (P1). Before every row the catalog is seeded again
 * with Prisma: domains Planning, Feedback, Reporting; capabilities Roadmap and Prioritization scoring (Planning),
 * Feedback inbox and Customer portal (Feedback), Dashboards (Reporting); one status per competitor and capability with
 * a value, a quote and a link on the fake site; and the competitors' lists (what earlier analyses read) are emptied.
 *
 * Knobs — the only deviations from reality, named in each test title:
 *   AI answer injected  POST /api/admin/competitors/knobs {aiAnswers: {competitorId, answers}} — the raw answers PMOS AI
 *                       would give to the analysis run of that competitor (reading: the list of the changed page;
 *                       match: where a new item goes; second look: none = nothing found). Parsing, the quote check,
 *                       name matching, every write and the cell rules run for real. Cleared when the run ends.
 *   fake site           the competitor is the fixture site; its pricing text is changed before the scan and carries the
 *                       quotes of the answer (a quote that is not on its page is dropped by the product).
 *   run-once            the real poller (fetch runner, real station key, real hand-in routes), one check-in.
 * DB, routes, hashing, diffing and emails are never mocked.
 *
 * Every injected answer lists one control item (Prioritization scoring, quoted on the changed page) whose cell must go
 * from Not found to Found: a row that asserts "nothing was added" cannot pass because the answer never ran. Expected
 * for each injected scan: scan ok; its analysis run done, flagged injected, with the injected-answer line in its log
 * and one reading request.
 *
 * Rows marked (proposed) test a build-time decision that is not a PRD line yet; they change with Daniel's decision.
 *
 * Shared-clone hazard: the station check-in is global — other organizations' sources and waiting requests are parked
 * for the run and restored byte-exact (competitors-helpers.ts), and the poller runs only when no request of another
 * organization waits. The aiAnswers knob is one AppSetting row keyed by competitor id; this file only ever writes its
 * own competitors' entries and removes them.
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
const INJECTED_LINE = "PMOS AI answers injected (test knob), no model is called";

type Value = "found" | "low" | "not_found";
const LABEL: Record<Value, string> = { found: "Found", low: "Low confidence", not_found: "Not found" };
const DOMAINS = ["Planning", "Feedback", "Reporting"] as const;
type DomainName = (typeof DOMAINS)[number];
/** The seeded catalog: capability → its domain, the org's own status, each competitor's value, the quote and page. */
const CAPS = [
  { name: "Roadmap", domain: "Planning", ours: "found", alpha: "found", beta: "found", quote: "Plan every release on a shared roadmap.", path: "/product" },
  { name: "Prioritization scoring", domain: "Planning", ours: "found", alpha: "not_found", beta: "not_found", quote: "Score every request by reach and effort.", path: "/product/features" },
  { name: "Feedback inbox", domain: "Feedback", ours: "found", alpha: "low", beta: "not_found", quote: "One inbox for every piece of feedback.", path: "/docs" },
  { name: "Customer portal", domain: "Feedback", ours: "not_found", alpha: "found", beta: "low", quote: "A portal where customers follow their requests.", path: "/docs/start" },
  { name: "Dashboards", domain: "Reporting", ours: "not_found", alpha: "found", beta: "not_found", quote: "Dashboards for every team.", path: "/pricing" },
] as const satisfies readonly { name: string; domain: DomainName; ours: Value; alpha: Value; beta: Value; quote: string; path: string }[];
type CapName = (typeof CAPS)[number]["name"];
const CONTROL: CapName = "Prioritization scoring";
const CONTROL_QUOTE = "Scoring is limited to the Team plan.";

// ————— Environment gate (same knobs as the Website Scanning rows) —————
const envProblems: string[] = [];
for (const [k, want] of [["COMPETITORS_TEST_KNOBS", "on"], ["COMPETITORS_ALLOW_PRIVATE_HOSTS", "on"], ["COMPETITORS_PAUSE_MS", "0"], ["COMPETITORS_AI", "off"]] as const) {
  if (RESOLVED_ENV[k]?.trim() !== want) envProblems.push(`${k} must be "${want}" in test-apphosting.yaml (got ${RESOLVED_ENV[k] ?? "<unset>"})`);
}

// ————— Shared state —————
let workspaceId: string;
let workspace2Id: string;
let workspace3Id: string;
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
/** Competitors whose answers this file set: cleared after every row, whatever happened in it. */
const answered = new Set<string>();
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
  await createUser(db, one.orgId, ADMIN, "PMOS_ADMIN");
  pmId = await createUser(db, one.orgId, PM, "CUSTOMER_ADMIN");
  // CA-18: two more organizations, each with its own org admin.
  const two = await seedQaOrgWithUser(db, { ...ORG2, features: { competitors: true }, user: PM2 });
  workspace2Id = two.workspaceId;
  await db.user.update({ where: { id: two.userId }, data: { role: "CUSTOMER_ADMIN" } });
  const three = await seedQaOrgWithUser(db, { ...ORG3, features: { competitors: true }, user: PM3 });
  workspace3Id = three.workspaceId;
  await db.user.update({ where: { id: three.userId }, data: { role: "CUSTOMER_ADMIN" } });
  // Setup is done in every QA org: an analysis fills the table and the catalog is edited by hand (setup-rules.ts).
  await db.organization.updateMany({ where: { slug: { in: SLUGS } }, data: { competitorsSetup: "done" } });
}

/** The Common setup's catalog and cells, written the way the routes and an analysis leave them. */
async function seedCatalog(db: PrismaClient): Promise<void> {
  const mine = { in: [workspaceId, workspace2Id, workspace3Id] };
  await db.capability.deleteMany({ where: { workspaceId: mine } }); // cascades to the status rows and their history
  await db.competitorDomain.deleteMany({ where: { workspaceId: mine } });
  await db.usageEvent.deleteMany({ where: { workspaceId: mine } });
  await db.competitorFeedRead.deleteMany({ where: { workspaceId: mine } });
  // What earlier rows' analyses read: the competitors' lists start empty, so every row's reading is a first list.
  await db.pageFinding.deleteMany({ where: { workspaceId: mine } });
  await db.competitorItem.deleteMany({ where: { workspaceId: mine, kind: "feature" } });
  await db.competitorItem.deleteMany({ where: { workspaceId: mine } });
  const d = {} as Record<DomainName, string>;
  for (const [position, name] of DOMAINS.entries()) {
    d[name] = (await db.competitorDomain.create({ data: { workspaceId, name, summary: `QA-CA fixture domain ${name}`, description: `QA-CA fixture domain ${name}`, position } })).id;
  }
  const k = {} as Record<CapName, string>;
  for (const [position, c] of CAPS.entries()) {
    k[c.name] = (await db.capability.create({ data: { workspaceId, domainId: d[c.domain], name: c.name, description: "QA-CA fixture capability", ourStatus: c.ours, position } })).id;
    for (const [competitor, value] of [[alpha, c.alpha], [beta, c.beta]] as const) {
      await db.capabilityStatus.create({
        data: { workspaceId, competitorId: competitor.id, capabilityId: k[c.name], value, confidence: 0.9, quote: value === "not_found" ? null : c.quote, sourceUrl: value === "not_found" ? null : `${competitor.site.url}${c.path}`, evidenceCount: value === "not_found" ? 0 : 1, scanId: firstScanId[competitor.id] },
      });
    }
  }
  dom = d;
  cap = k;
}

/** Scans and analyses a red row left behind are ended, so the next row's Scan now is not queued behind them. */
async function endOpenWork(): Promise<void> {
  if (!workspaceId) return; // beforeAll did not get that far
  await withTestDb(async (db) => {
    const mine = { in: [workspaceId, workspace2Id, workspace3Id] };
    const t = new Date();
    await db.localScanRequest.updateMany({ where: { workspaceId: mine, state: { in: ["waiting", "running"] } }, data: { state: "cancelled", finishedAt: t } });
    await db.competitorScan.updateMany({ where: { workspaceId: mine, status: { in: ["queued", "pending_local", "running"] } }, data: { status: "cancelled", finishedAt: t, error: "QA cleanup" } });
    await db.competitorAnalysis.updateMany({ where: { workspaceId: mine, status: { in: ["queued", "running", "waiting"] } }, data: { status: "cancelled", finishedAt: t, error: "QA cleanup", ownerToken: null } });
  });
}

// ————— Sessions —————
/** One login, saved as storage state. A login that fails (a slow first compile, a TOTP window) is tried again: one bad login never drops the rows. */
async function loginAndSave(browser: Browser, creds: Creds, file: string): Promise<string> {
  const path = join(SCRATCH, file);
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await ctx.newPage();
      await loginWithTotp(page, creds);
      await ctx.storageState({ path });
      return path;
    } catch (e) {
      last = e;
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  throw last;
}

async function open(browser: Browser, who: "admin" | "pm" | "member" | string): Promise<Page> {
  const ctx = await browser.newContext({ storageState: who in stateFile ? stateFile[who as keyof typeof stateFile] : who });
  openContexts.push(ctx);
  return ctx.newPage();
}

// ————— The analysis on injected answers —————
type ScanRow = Awaited<ReturnType<typeof waitForScanEnd>>;
type AnalysisRow = NonNullable<Awaited<ReturnType<typeof analysisOfScan>>>;
const analysisOfScan = (scanId: string) => withTestDb((db) => db.competitorAnalysis.findFirst({ where: { scanId }, orderBy: { createdAt: "desc" } }));
const logOf = (row: { log: Prisma.JsonValue }): string[] => (Array.isArray(row.log) ? (row.log as { msg?: string }[]).map((l) => l.msg ?? "") : []);
const countersOf = (row: { counters: Prisma.JsonValue }) => (row.counters ?? {}) as Record<string, number>;

const setAnswers = async (competitorId: string, answers: Record<string, unknown> | null) => {
  if (answers) answered.add(competitorId);
  await postKnob(adminApi, { aiAnswers: { competitorId, answers } });
  if (!answers) answered.delete(competitorId);
};

async function waitForAnalysisEnd(find: () => Promise<AnalysisRow | null>, timeout = 90_000): Promise<AnalysisRow> {
  let row: AnalysisRow | null = null;
  await expect.poll(async () => {
    row = await find();
    return row?.status ?? null;
  }, { timeout, intervals: [500] }).toMatch(/^(done|failed|cancelled)$/);
  return row!;
}

/** The match step's code of one of our domains: "D-" + the first 8 characters of its id (analysis/match.ts codeFor; no two of our domain ids share them here). */
const domainCode = (id: string) => `D-${id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}`;

interface Item { name: string; quote: string; description?: string }
/** The match answer for the n-th item that no name of ours resolves (T1 … in the order the run sends them): none of ours, placed in `domainId`. */
interface Placement { entry: string; domainId: string; marketName: string; description?: string }

/**
 * One scan of `c`, then its analysis on injected answers. Knobs: AI answer injected (the reading answer lists the
 * control item and `items`, each quoted on the changed page P1; `place` answers the match for items none of ours),
 * fake site (the pricing text changes and carries every quote), run-once (the real poller). `by` presses Scan now —
 * the PM-OS admin in the first org (the daily limit never applies to him).
 */
async function injectedScan(c: Cmp, extra: { items?: Item[]; place?: Placement[] } = {}, by: APIRequestContext = adminApi, ownWorkspaces = [workspaceId, workspace2Id, workspace3Id]): Promise<{ scan: ScanRow; analysis: AnalysisRow }> {
  const items: Item[] = [{ name: CONTROL, quote: CONTROL_QUOTE, description: "Scores requests; the Team plan only." }, ...(extra.items ?? [])];
  scanSeq++;
  await c.site.control({ pricingText: `Plans, round ${scanSeq}. ${items.map((i) => i.quote).join(" ")} Starter $${50 + scanSeq} per month.` });
  const reading = { capabilities: items.map((i) => ({ name: i.name, description: i.description ?? `${i.name}, as the page says.`, quote: i.quote, page: "P1", features: [] })), unexplained: [] };
  const match = extra.place?.length
    ? [JSON.stringify({ matches: extra.place.map((p) => ({ entry: p.entry, ours: "none", domain: domainCode(p.domainId), marketName: p.marketName, description: p.description ?? `${p.marketName}.` })) })]
    : undefined;
  await setAnswers(c.id, { reading: [JSON.stringify(reading)], ...(match ? { match } : {}) });
  try {
    const res = await scanNow(by, c.id);
    expect(res.status(), `Scan now on ${c.name}: ${await res.text()}`).toBe(202);
    const pending = await waitForScanWithStatus(c.sourceId, "pending_local");
    await expectOnlyOwnRequestsWaiting(ownWorkspaces);
    const r = await runStationPoller({ key: keyFile });
    expect(r.code, r.stdout).toBe(0);
    const scan = await waitForScanEnd(pending.id);
    expect(scan.status, `${c.name} scan: ${scan.error ?? ""}`).toBe("ok");
    expect(scan.pagesChanged, "the changed pricing page").toBeGreaterThanOrEqual(1);
    const analysis = await waitForAnalysisEnd(() => analysisOfScan(scan.id));
    // The analysis log of every injected run is kept with the test result.
    await test.info().attach(`analysis-log-${c.name}-${analysis.id}.txt`, { body: logOf(analysis).join("\n"), contentType: "text/plain" });
    expect(analysis.status, `${c.name} analysis: ${analysis.error ?? ""}\n${logOf(analysis).join("\n")}`).toBe("done");
    expect(analysis.injected, "the run took the injected answers").toBe(true);
    expect(logOf(analysis).some((l) => l.includes(INJECTED_LINE)), "the injected-answer line in the analysis log").toBe(true);
    expect(countersOf(analysis).readRequests, "one reading request: the changed page only").toBe(1);
    // The control item was applied: the answer reached the table.
    const control = await withTestDb((db) => db.capabilityStatus.findFirstOrThrow({ where: { competitorId: c.id, capability: { name: CONTROL } } }));
    expect(control.value, "control cell in the DB").toBe("found");
    expect(control.quote).toBe(CONTROL_QUOTE);
    return { scan, analysis };
  } finally {
    await setAnswers(c.id, null).catch(() => undefined);
  }
}

/** A competitor's first analysis, on an empty injected answer: every stored page is read once and nothing is listed (beforeAll, CA-18). */
async function primeAnalysis(c: Cmp): Promise<void> {
  await setAnswers(c.id, {});
  try {
    const res = await adminApi.post("/api/admin/competitors/analyses", { data: { competitorId: c.id } });
    await ok(res);
    const { analysisId } = (await res.json()) as { analysisId?: string };
    expect(analysisId, `an analysis of ${c.name} was queued`).toBeTruthy();
    const run = await waitForAnalysisEnd(() => withTestDb((db) => db.competitorAnalysis.findUnique({ where: { id: analysisId! } })));
    expect(run.status, `${c.name} first analysis: ${run.error ?? ""}\n${logOf(run).join("\n")}`).toBe("done");
    expect(countersOf(run).pagesRead, `${c.name}: every stored page read`).toBe(12);
  } finally {
    await setAnswers(c.id, null).catch(() => undefined);
  }
}

// ————— DB reads —————
const propsOf = (row: { props: Prisma.JsonValue }) => (row.props ?? {}) as Record<string, unknown>;
/** UsageEvent rows of an event in a workspace, newest first, optionally only those whose props match. */
async function events(event: string, match: Record<string, unknown> = {}, ws = workspaceId) {
  const rows = await withTestDb((db) => db.usageEvent.findMany({ where: { workspaceId: ws, event }, orderBy: { createdAt: "desc" }, select: { props: true, userId: true } }));
  return rows.filter((r) => Object.entries(match).every(([k, v]) => propsOf(r)[k] === v));
}
/** Every catalog row of a workspace: what must be identical before and after an analysis. */
const catalogOf = (ws = workspaceId) => withTestDb(async (db) => ({
  domains: await db.competitorDomain.findMany({ where: { workspaceId: ws }, orderBy: { id: "asc" }, select: { id: true, name: true, state: true, position: true } }),
  capabilities: await db.capability.findMany({ where: { workspaceId: ws }, orderBy: { id: "asc" }, select: { id: true, name: true, domainId: true, state: true, position: true } }),
}));
/** The cells of one capability, with everything an analysis or a route could have touched. */
const cellsOf = (capabilityId: string) => withTestDb((db) => db.capabilityStatus.findMany({
  where: { capabilityId }, orderBy: { competitorId: "asc" },
  select: { id: true, competitorId: true, value: true, confidence: true, quote: true, sourceUrl: true, scanId: true, changedAt: true, product: true, overrideValue: true, updatedAt: true },
}));
const cellOf = (competitorId: string, capabilityId: string) => withTestDb((db) => db.capabilityStatus.findUnique({ where: { competitorId_capabilityId: { competitorId, capabilityId } } }));
const capabilityRow = (id: string) => withTestDb((db) => db.capability.findUniqueOrThrow({ where: { id } }));
const domainRow = (id: string) => withTestDb((db) => db.competitorDomain.findUniqueOrThrow({ where: { id } }));
const capabilitiesNamed = (name: string, ws = workspaceId) => withTestDb((db) => db.capability.findMany({ where: { workspaceId: ws, name: { equals: name, mode: "insensitive" } } }));
const domainsNamed = (name: string, ws = workspaceId) => withTestDb((db) => db.competitorDomain.findMany({ where: { workspaceId: ws, name: { equals: name, mode: "insensitive" } } }));
const suggestedRows = (ws = workspaceId) => withTestDb(async (db) => ({
  domains: await db.competitorDomain.count({ where: { workspaceId: ws, state: "suggested" } }),
  capabilities: await db.capability.count({ where: { workspaceId: ws, state: "suggested" } }),
}));
/** A suggested or declined row, written the way the earlier scans left them (PRD: "a suggested capability seeded for Alpha"). */
const seedSuggestedCapability = (name: string, domainId: string, state: "suggested" | "dismissed", position: number) => withTestDb((db) => db.capability.create({
  data: { workspaceId, domainId, name, description: "QA-CA fixture suggestion", position, origin: "ai", state, suggestedById: alpha.id, suggestedQuote: `Listed on the pricing page. — ${alpha.site.url}/pricing` },
}));
const seedSuggestedDomain = (name: string, state: "suggested" | "dismissed") => withTestDb((db) => db.competitorDomain.create({
  data: { workspaceId, name, description: "Invoices and payments.", position: 9999, origin: "ai", state, suggestedById: alpha.id },
}));

// ————— Routes (a row's own setup: "removed / renamed / declined through the real route") —————
async function ok(res: APIResponse, status = 200): Promise<void> {
  expect(res.status(), `${res.url()}: ${await res.text()}`).toBe(status);
}
const removeCapability = async (id: string) => ok(await pmApi.delete(`/api/competitors/capabilities/${id}`));
const removeDomain = async (id: string, moveTo?: string) => ok(await pmApi.delete(`/api/competitors/domains/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`));
/** Decline a suggestion: PATCH {state: "dismissed"}. */
const declineCapability = async (id: string) => ok(await pmApi.patch(`/api/competitors/capabilities/${id}`, { data: { state: "dismissed" } }));
const declineDomain = async (id: string) => ok(await pmApi.patch(`/api/competitors/domains/${id}`, { data: { state: "dismissed" } }));

// ————— UI: Settings → Competitors —————
/** lib/competitors/time.ts shortDate — "Nov 10" this year. */
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const removedBy = (name: string) => `Removed by ${name}, ${shortDate(new Date())}`;

type Section = "domains" | "capabilities";
/** Settings → Competitors with the named sections open (Domains and Capabilities start closed since 2026-11-12). */
async function openSettings(page: Page, ...sections: Section[]): Promise<void> {
  await page.goto("/settings/competitors");
  await hydrated(page.getByTestId("cmp-section-domains"));
  for (const s of sections) {
    const toggle = page.getByTestId(`cmp-section-${s}`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}
const domainsSection = (page: Page) => page.getByTestId("cmp-domains");
/** A domain's card in Settings → Domains (view mode: swatch, name, counts, drag handle, edit, remove). */
const domainCard = (page: Page, name: string) => domainsSection(page).locator("div.rounded-xl.px-5.py-4", { has: page.locator("span.font-title", { hasText: new RegExp(`^${name}$`) }) });
const settingsDomainOrder = (page: Page) => domainsSection(page).locator("div.rounded-xl.px-5.py-4 span.font-title").allTextContents();
/** A capability's short row in Settings → Capabilities (name, its domain, remove); a click opens its form below it. */
const capRow = (page: Page, name: string) => page.getByTestId("cmp-capability").filter({ has: page.getByRole("button", { name: `${name}: open or close its details`, exact: true }) });
const capToggle = (page: Page, name: string) => page.getByRole("button", { name: `${name}: open or close its details`, exact: true });
const removedPanel = (page: Page) => page.getByTestId("cmp-removed");
const removedCapability = (page: Page, name: string) => removedPanel(page).locator(`[data-testid="cmp-removed-capability"][data-name="${name}"]`);
const removedDomain = (page: Page, name: string) => removedPanel(page).locator(`[data-testid="cmp-removed-domain"][data-name="${name}"]`);

/** Settings → Capabilities → Add capability: name + domain, Save. */
async function addCapabilityInSettings(page: Page, name: string, domain: string): Promise<void> {
  await page.getByRole("button", { name: "Add capability" }).click();
  const form = page.getByTestId("cmp-capability-add-form");
  await form.getByTestId("cmp-capability-name").fill(name);
  await form.getByTestId("cmp-capability-domain").selectOption({ label: domain });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
}
/** Settings → Domains → Add domain: the name, then the form's own Add domain. */
async function addDomainInSettings(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Add domain" }).click();
  await domainsSection(page).getByTestId("cmp-domain-name").fill(name);
  await domainsSection(page).getByRole("button", { name: "Add domain" }).click();
  await expect(domainCard(page, name)).toHaveCount(1);
}
/** Open a capability's row, change its name (and/or domain) and save — Enter in the name field when only the name changes. */
async function editCapabilityInSettings(page: Page, name: string, change: { name?: string; domain?: string }): Promise<void> {
  await capToggle(page, name).click();
  const form = capRow(page, name).getByTestId("cmp-capability-form");
  await expect(form).toBeVisible();
  const field = form.getByTestId("cmp-capability-name");
  await expect(field).toHaveValue(name);
  if (change.domain) await form.getByTestId("cmp-capability-domain").selectOption({ label: change.domain });
  if (change.name) {
    await field.fill(change.name);
    await field.press("Enter");
  } else {
    await form.getByRole("button", { name: "Save", exact: true }).click();
  }
  await expect(page.getByTestId("cmp-capability-form")).toHaveCount(0);
}

// ————— UI: the parity table —————
const parity = (page: Page) => page.locator('section[aria-label="Parity matrix"]');
/** The Competitors page with every domain open (only the first opens at load since 2026-11-22). */
async function openMatrix(page: Page): Promise<void> {
  await page.goto("/competitors");
  await expect(page.getByRole("heading", { level: 1, name: "Competitors" })).toBeVisible({ timeout: 30_000 });
  await hydrated(parity(page).locator("table"));
  const all = parity(page).getByTestId("cmp-domains-toggle-all");
  if ((await all.count()) && (await all.getAttribute("aria-label")) === "Open all domains") await all.click();
  if (await all.count()) await expect(all).toHaveAttribute("aria-label", "Close all domains");
}

interface MatrixGroup { domain: string; suggestedDomain: boolean; rows: string[] }
/** The parity table as the PM reads it: domain groups in order, each with its capability rows (every domain open). */
async function matrixGroups(page: Page): Promise<MatrixGroup[]> {
  return parity(page).locator("table tbody tr").evaluateAll((trs) => {
    const out: { domain: string; suggestedDomain: boolean; rows: string[] }[] = [];
    const suffix = ": show or hide the description";
    for (const tr of trs) {
      const header = tr.querySelector('div[role="button"][aria-expanded]');
      if (header) {
        out.push({ domain: (header.querySelector("span.font-bold")?.textContent ?? "").trim(), suggestedDomain: tr.getAttribute("data-testid") === "cmp-suggested-domain", rows: [] });
        continue;
      }
      const label = [...tr.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label") ?? "").find((l) => l.endsWith(suffix));
      if (label && out.length) out[out.length - 1].rows.push(label.slice(0, -suffix.length));
    }
    return out;
  });
}
const groupOf = (groups: MatrixGroup[], capability: string) => groups.find((g) => g.rows.includes(capability))?.domain ?? null;
const allRows = (groups: MatrixGroup[]) => groups.flatMap((g) => g.rows);

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
/** Open a cell: its card (a portal on <body>) shows the quote and the link; Esc closes it. */
async function expectCellEvidence(page: Page, td: Locator, quote: string, url: string): Promise<void> {
  await td.getByRole("button").first().click();
  await expect(page.getByText(`“${quote}”`)).toBeVisible();
  await expect(page.locator(`a[href="${url}"]`).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(`“${quote}”`)).toHaveCount(0);
}
/** The cell shows the seeded value and, opened, its quote and its source link on the fake site. */
async function expectSeededCell(page: Page, name: CapName, competitor: Cmp): Promise<void> {
  const seeded = CAPS.find((c) => c.name === name)!;
  const value = competitor === alpha ? seeded.alpha : seeded.beta;
  const td = await expectCell(page, name, competitor.name, value);
  if (value !== "not_found") await expectCellEvidence(page, td, seeded.quote, `${competitor.site.url}${seeded.path}`);
}
/** The control item of the injected answer shows in its cell. */
const expectControl = (page: Page, competitor: Cmp) => expectCell(page, CONTROL, competitor.name, "found");

async function openFeed(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "News feed" }).click();
  await expect(page.locator('section[aria-label="News feed"]')).toBeVisible();
}
const feedItems = (page: Page, text: string | RegExp) => page.getByTestId("cmp-feed-item").filter({ hasText: text });

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

test.describe("Capability Analysis — PM decisions stick", () => {
  test.skip(envProblems.length > 0, envProblems.join("; "));

  test.beforeAll(async ({ browser, playwright }) => {
    if (envProblems.length) return;
    test.setTimeout(480_000);
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
    await ok(await adminApi.patch("/api/admin/competitors/settings", { data: { remoteScanEnabled: false, analysisDisabled: false } }));
    keyFile = (await createStationKey(adminApi, KEY_LABEL)).file;

    // Common setup: Alpha and Beta, each on its own fake site, each scanned once by the real poller in "once" mode.
    alpha = await addCompetitor(pmApi, await startSite(fileSites), ALPHA);
    beta = await addCompetitor(pmApi, await startSite(fileSites), BETA);
    const pending = [await waitForScanWithStatus(alpha.sourceId, "pending_local"), await waitForScanWithStatus(beta.sourceId, "pending_local")];
    await expectOnlyOwnRequestsWaiting([workspaceId, workspace2Id, workspace3Id]);
    const r = await runStationPoller({ key: keyFile });
    expect(r.code, r.stdout).toBe(0);
    for (const [i, c] of [alpha, beta].entries()) {
      const done = await waitForScanEnd(pending[i].id);
      expect(done.status, `${c.name} onboarding: ${done.error ?? ""}`).toBe("ok");
      expect(done.badge, `${c.name} onboarding badge`).toBe("full");
      expect(done.pagesFetched, `${c.name} onboarding pages`).toBe(12);
      firstScanId[c.id] = done.id;
    }
    // …and analysed once (every page read, nothing listed): a row's analysis reads only the page the row changes.
    for (const c of [alpha, beta]) await primeAnalysis(c);
  });

  test.beforeEach(async () => {
    if (envProblems.length) return;
    await withTestDb(seedCatalog);
  });

  test.afterEach(async () => {
    if (envProblems.length) return;
    // The knob is cleared after every row, whatever happened in it.
    for (const id of [...answered]) await setAnswers(id, null).catch(() => undefined);
    await endOpenWork();
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
    await openSettings(page, "capabilities");
    await expect(removedPanel(page)).toHaveCount(0);
    await capRow(page, "Dashboards").getByRole("button", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove Dashboards?");
    await expect(dialog).toContainText("It leaves the table");
    await expect(dialog).toContainText("scans will not add it back");
    await acceptConfirm(page);

    await expect(capRow(page, "Dashboards")).toHaveCount(0);
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

  // PRD question (CA-02): the row says "the scan log" and the event's scanId. Since the analysis is its own run after
  // the scan (2026-11-11), the line is in the analysis run's log and the event carries analysisId (the run names its
  // scan). The line is not shown in the app: Administration lists scans, not analysis runs.
  test("CA-02 an analysis does not add a removed capability back: no row in the matrix, nothing in the feed; its status rows unchanged; the analysis log says the team removed it; Removed lists it once; event cmp_decision_respected removed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await removeCapability(cap.Dashboards);
    const cellsBefore = await cellsOf(cap.Dashboards);
    const catalogBefore = await catalogOf();
    const { analysis } = await injectedScan(alpha, { items: [{ name: "dashboards", quote: "Dashboards are in beta." }] });

    expect(await catalogOf(), "no capability or domain row was created or changed").toEqual(catalogBefore);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await cellsOf(cap.Dashboards), "the status rows of the removed capability").toEqual(cellsBefore);
    expect(logOf(analysis)).toContain('dashboards: your team removed "Dashboards" — remembered, not shown');
    expect(countersOf(analysis).newCapabilities ?? 0, "no new capability").toBe(0);

    const [event] = await events("cmp_decision_respected");
    expect(event, "cmp_decision_respected").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", entityId: cap.Dashboards, name: "Dashboards", found: "dashboards", reason: "removed", competitorId: alpha.id, analysisId: analysis.id });
    expect(analysis.scanId, "the run names the scan it followed").not.toBeNull();
    expect(event.userId).toBeNull();
    expect(await events("cmp_decision_respected")).toHaveLength(1);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(allRows(groups).map((n) => n.toLowerCase())).not.toContain("dashboards");
    // The feed holds new abilities only: nothing an analysis does to the table is an item there.
    await openFeed(page);
    await expect(feedItems(page, /dashboards/i)).toHaveCount(0);
    await openSettings(page, "capabilities");
    await expect(removedCapability(page, "Dashboards")).toHaveCount(1);
    await expect(removedPanel(page).getByTestId("cmp-removed-capability")).toHaveCount(1);
    await expect(capRow(page, "Dashboards")).toHaveCount(0);
  });

  test("CA-03 restore a capability: back in the matrix under Reporting with the same cells, quotes and links; the Removed panel is gone; event restore via settings with the domain it left and the domain it returns to [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await removedCapability(page, "Dashboards").getByTestId("cmp-restore").click();
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(capRow(page, "Dashboards")).toHaveCount(1);

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
    expect(propsOf(event)).toMatchObject({ fromDomainId: dom.Reporting, toDomainId: dom.Reporting, domainChanged: false });
    expect(event.userId).toBe(pmId);
  });

  test("CA-04 adding a removed name by hand clears the removal: one active Dashboards row, no 409, the Removed panel is gone, event restore via add; (proposed) it sits in the domain picked in the form with its earlier cells [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await expect(removedCapability(page, "Dashboards")).toHaveCount(1);
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/competitors/capabilities");
    await addCapabilityInSettings(page, "Dashboards", "Planning");
    expect((await posted).status(), "no 409 for a removed name").toBe(201);
    await expect(page.getByText("A capability with this name already exists.")).toHaveCount(0);
    await expect(removedPanel(page)).toHaveCount(0);
    await expect(capRow(page, "Dashboards")).toHaveCount(1);

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

  test("CA-05 a renamed capability is recognised under its old name: the row is Product roadmap and Beta's cell on it shows what the analysis found; no row named Roadmap; event rename; the analysis log and cmp_decision_respected say renamed [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    // Beta's cell on Roadmap starts Not found, so the item the analysis finds under the old name can only reach it through the replaced name.
    await withTestDb((db) => db.capabilityStatus.update({ where: { competitorId_capabilityId: { competitorId: beta.id, capabilityId: cap.Roadmap } }, data: { value: "not_found", quote: null, sourceUrl: null, evidenceCount: 0 } }));
    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await editCapabilityInSettings(page, "Roadmap", { name: "Product roadmap" });
    await expect(capRow(page, "Product roadmap")).toHaveCount(1);
    await expect(capRow(page, "Roadmap")).toHaveCount(0);

    const [rename] = await events("cmp_catalog_edited", { action: "rename" });
    expect(rename, "cmp_catalog_edited rename").toBeTruthy();
    expect(propsOf(rename)).toMatchObject({ entity: "capability", action: "rename", entityId: cap.Roadmap, from: "Roadmap", to: "Product roadmap" });
    expect(rename.userId).toBe(pmId);
    expect((await capabilityRow(cap.Roadmap)).aliases, "the replaced name is kept behind the row").toEqual(["Roadmap"]);

    const quote = "Every plan includes the roadmap.";
    const { analysis } = await injectedScan(beta, { items: [{ name: "roadmap", quote }] });
    expect(await capabilitiesNamed("Roadmap"), "no row named Roadmap").toHaveLength(0);
    expect((await capabilitiesNamed("Product roadmap")).map((r) => [r.id, r.state])).toEqual([[cap.Roadmap, "active"]]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    const cell = await cellOf(beta.id, cap.Roadmap);
    expect([cell?.value, cell?.quote], "Beta's cell on the renamed row: what the analysis found under the old name").toEqual(["found", quote]);

    // PRD CA-05 + the analytics table (reason renamed): the scan log says the team renamed it, and cmp_decision_respected
    // records it. The analysis matches the old name to the renamed row (steps.ts matchStep) but writes neither.
    expect.soft(logOf(analysis).some((l) => /renamed/i.test(l) && /Product roadmap/.test(l)), "PRODUCT GAP: the analysis log says the team renamed this capability").toBe(true);
    const respected = await events("cmp_decision_respected", { reason: "renamed" });
    expect.soft(respected.map((e) => propsOf(e)), "PRODUCT GAP: cmp_decision_respected reason renamed").toEqual([expect.objectContaining({ entity: "capability", entityId: cap.Roadmap, name: "Product roadmap", found: "roadmap", competitorId: beta.id })]);

    await openMatrix(page);
    await expectControl(page, beta);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Product roadmap")).toBe("Planning");
    expect(allRows(groups).map((n) => n.toLowerCase())).not.toContain("roadmap");
    const td = await expectCell(page, "Product roadmap", BETA, "found");
    await expectCellEvidence(page, td, quote, `${beta.site.url}/pricing`);
  });

  test("CA-06 a moved capability stays where the PM put it: one Customer portal row, under Planning; every catalog row has the same name, domain, state and position before and after the analysis; event move with who, from and to [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await editCapabilityInSettings(page, "Customer portal", { domain: "Planning" });
    await expect.poll(async () => (await capabilityRow(cap["Customer portal"])).domainId).toBe(dom.Planning);
    const [move] = await events("cmp_catalog_edited", { action: "move" });
    expect(move, "cmp_catalog_edited move").toBeTruthy();
    expect(propsOf(move)).toMatchObject({ entity: "capability", action: "move", entityId: cap["Customer portal"], from: dom.Feedback, to: dom.Planning, fromName: "Feedback", toName: "Planning" });
    expect(move.userId).toBe(pmId);

    const before = await catalogOf();
    await injectedScan(alpha, { items: [{ name: "Customer portal", quote: "Customers follow their requests in the portal." }] });
    expect(await catalogOf(), "catalog rows before and after the analysis").toEqual(before);
    expect((await capabilitiesNamed("Customer portal")).map((r) => [r.id, r.domainId, r.state])).toEqual([[cap["Customer portal"], dom.Planning, "active"]]);
    expect((await cellOf(alpha.id, cap["Customer portal"]))?.quote, "the analysis filled the cell of the moved row").toBe("Customers follow their requests in the portal.");

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Customer portal")).toBe("Planning");
    expect(allRows(groups).filter((n) => n === "Customer portal")).toHaveLength(1);
  });

  // ————————————————————————————— Domains: remove, restore —————————————————————————————

  test("CA-07 removing a domain asks where its capabilities go: Remove disabled until a domain is picked; Esc closes and nothing changes; pick Reporting + Enter → Feedback gone from the matrix and Settings, its two capabilities under Reporting with their cells; Removed lists the domain with who and when; event remove with the moved capabilities [knobs: none]", async ({ browser }) => {
    const before = await catalogOf();
    const cellsBefore = [await cellsOf(cap["Feedback inbox"]), await cellsOf(cap["Customer portal"])];
    const page = await open(browser, "pm");
    await openSettings(page, "domains");
    const dialog = page.getByTestId("cmp-move-domain-dialog");
    await domainCard(page, "Feedback").getByRole("button", { name: "Remove", exact: true }).click();
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

    await domainCard(page, "Feedback").getByRole("button", { name: "Remove", exact: true }).click();
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
    expect([...groups[1].rows].sort()).toEqual(["Customer portal", "Dashboards", "Feedback inbox"]);
    await expectSeededCell(page, "Feedback inbox", alpha);
    await expectSeededCell(page, "Customer portal", alpha);

    const [event] = await events("cmp_catalog_edited", { action: "remove" });
    expect(event, "cmp_catalog_edited remove").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "remove", entityId: dom.Feedback, from: "active", to: "removed", name: "Feedback", movedCapabilities: 2, moveTo: dom.Reporting });
    expect(String(propsOf(event).movedCapabilityIds).split(",").sort()).toEqual([cap["Feedback inbox"], cap["Customer portal"]].sort());
    expect(event.userId).toBe(pmId);
  });

  // PRD question (CA-08): "the scan log says the domain was removed by the team" and "cmp_decision_respected: entity
  // domain, reason removed" cannot happen any more — the match is given only the domains in the table, by code, and
  // places a new item in one of them. Its "not built yet" half (the capability goes to an active domain) is how it works now.
  test("CA-08 a removed domain is never suggested again: no domain is created or suggested; Removed lists Feedback once; the capability found for it goes into an active domain [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await removeDomain(dom.Feedback, dom.Reporting);
    const domainsBefore = (await catalogOf()).domains;
    await injectedScan(alpha, {
      items: [{ name: "Idea voting", quote: "Customers vote on the ideas they want most." }],
      place: [{ entry: "T1", domainId: dom.Reporting, marketName: "Idea voting", description: "Collecting and ranking customer feedback." }],
    });

    expect((await catalogOf()).domains, "no domain row was created or changed").toEqual(domainsBefore);
    expect((await domainsNamed("feedback")).map((d) => [d.id, d.state])).toEqual([[dom.Feedback, "removed"]]);
    expect((await suggestedRows()).domains).toBe(0);
    const idea = await capabilitiesNamed("Idea voting");
    expect(idea.map((r) => [r.domainId, r.state, r.origin]), "the capability went into an active domain").toEqual([[dom.Reporting, "active", "ai"]]);
    expect(await events("cmp_decision_respected", { entity: "domain" }), "no domain decision was met: the removed domain is not offered").toHaveLength(0);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain.toLowerCase())).not.toContain("feedback");
    expect(groupOf(groups, "Idea voting")).toBe("Reporting");
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    await openSettings(page, "domains");
    await expect(removedDomain(page, "Feedback")).toHaveCount(1);
    await expect(removedPanel(page).getByTestId("cmp-removed-domain")).toHaveCount(1);
    await expect(domainCard(page, "Feedback")).toHaveCount(0);
  });

  test("CA-09 restore a domain: Feedback is in the table's domains again, last in the order, with no capabilities; the two moved capabilities stay under Reporting; event restore via settings [knobs: none]", async ({ browser }) => {
    await removeDomain(dom.Feedback, dom.Reporting);
    const page = await open(browser, "pm");
    await openSettings(page, "domains");
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
    // An empty domain has no group of rows in the table.
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Reporting"]);

    const [event] = await events("cmp_catalog_edited", { action: "restore" });
    expect(event, "cmp_catalog_edited restore").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "restore", entityId: dom.Feedback, from: "removed", to: "active", name: "Feedback", via: "settings" });
    expect(event.userId).toBe(pmId);
  });

  test("CA-10 removing an empty domain asks nothing: a plain confirm with no move question; the domain is listed under Removed [knobs: none]", async ({ browser }) => {
    const integrations = await withTestDb((db) => db.competitorDomain.create({ data: { workspaceId, name: "Integrations", description: "QA-CA fixture domain Integrations", position: 3 } }));
    const page = await open(browser, "pm");
    await openSettings(page, "domains");
    await domainCard(page, "Integrations").getByRole("button", { name: "Remove", exact: true }).click();
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
    await openSettings(page, "domains");
    await domainCard(page, "Planning").getByRole("button", { name: "Remove", exact: true }).click();
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
    await openSettings(page, "domains");
    await domainCard(page, "Reporting").getByRole("button", { name: "Edit", exact: true }).click();
    const name = domainsSection(page).getByTestId("cmp-domain-name");
    await expect(name).toHaveValue("Reporting");
    await name.fill("Analytics");
    await domainsSection(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText('Rename "Reporting" to "Analytics"?');
    await acceptConfirm(page);
    await expect(domainCard(page, "Analytics")).toHaveCount(1);
    await expect(domainCard(page, "Reporting")).toHaveCount(0);
    const [rename] = await events("cmp_catalog_edited", { action: "rename" });
    expect(propsOf(rename)).toMatchObject({ entity: "domain", entityId: dom.Reporting, from: "Reporting", to: "Analytics" });

    await injectedScan(alpha, {
      items: [{ name: "Scheduled reports", quote: "Reports go out on a schedule you set." }],
      place: [{ entry: "T1", domainId: dom.Reporting, marketName: "Scheduled reports", description: "Reports sent on a schedule." }],
    });
    expect(await domainsNamed("Reporting"), "no domain named Reporting").toHaveLength(0);
    expect((await catalogOf()).domains.map((d) => [d.name, d.state]).sort()).toEqual([["Analytics", "active"], ["Feedback", "active"], ["Planning", "active"]]);
    expect((await capabilitiesNamed("Scheduled reports")).map((r) => [r.domainId, r.state])).toEqual([[dom.Reporting, "active"]]);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Feedback", "Analytics"]);
    expect(groups[2]).toEqual({ domain: "Analytics", suggestedDomain: false, rows: ["Dashboards", "Scheduled reports"] });
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
  });

  // ————————————————————————————— Order, the "new" mark —————————————————————————————

  test("CA-13 the table follows the settings order: the save succeeds with a suggested and a removed domain present; after a reload Settings and the matrix show Reporting, Planning, Feedback; event reorder with the order before and after; (proposed) a domain added afterwards lands last [knobs: none]", async ({ browser }) => {
    await withTestDb(async (db) => {
      await db.competitorDomain.create({ data: { workspaceId, name: "QA Suggested Domain", position: 9999, origin: "ai", state: "suggested", suggestedById: alpha.id } });
      await db.competitorDomain.create({ data: { workspaceId, name: "QA Removed Domain", position: 7, state: "removed", removedAt: new Date(), removedById: pmId } });
    });
    const page = await open(browser, "pm");
    await openSettings(page, "domains");
    expect(await settingsDomainOrder(page)).toEqual(["Planning", "Feedback", "Reporting"]);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/competitors/domains");
    await dragDomain(page, "Reporting", "Planning");
    expect((await saved).status(), "the order saves with suggested and removed domains present").toBe(200);
    await expect.poll(() => settingsDomainOrder(page)).toEqual(["Reporting", "Planning", "Feedback"]);

    await openSettings(page, "domains");
    expect(await settingsDomainOrder(page)).toEqual(["Reporting", "Planning", "Feedback"]);
    await openMatrix(page);
    // The suggested domain has no rows, so it has no group; the three domains of the table are in the settings order.
    expect((await matrixGroups(page)).map((g) => g.domain)).toEqual(["Reporting", "Planning", "Feedback"]);

    const [event] = await events("cmp_catalog_edited", { action: "reorder" });
    expect(event, "cmp_catalog_edited reorder").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "domain", action: "reorder", from: [dom.Planning, dom.Feedback, dom.Reporting].join(","), to: [dom.Reporting, dom.Planning, dom.Feedback].join(",") });
    expect(event.userId).toBe(pmId);

    // (proposed) a domain added afterwards lands last among the domains in the table.
    await openSettings(page, "domains");
    await addDomainInSettings(page, "Pricing");
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
      data: { changedAt: source.lastScanAt, history: { create: { value: "not_found", quote: null, sourceUrl: null, at: source.lastScanAt! } } },
    }));
    const page = await open(browser, "member");
    await openMatrix(page);
    // The changed cell is on the page (and says when it changed once opened) — only the mark on the table is gone.
    const td = await expectCell(page, "Roadmap", ALPHA, "found");
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
    await expect(own.getByRole("button").first()).toHaveAttribute("aria-label", `Dashboards: ${ORG.orgName} Not found`);
    await own.getByRole("button").first().click();
    // The card is a portal on <body>.
    const hint = page.getByTestId("cmp-own-cell-hint");
    await expect(hint).toHaveText(`${ORG.orgName}'s status · Set by your team, never scanned.`);
    const card = page.locator("div", { has: hint }).filter({ has: page.getByRole("button", { name: "Found", exact: true }) }).last();
    await expect(card).not.toContainText("%");
    await expect(card).not.toContainText(/confidence/i);
    await card.getByRole("button", { name: "Found", exact: true }).click();
    await expect(own.getByRole("button").first()).toHaveAttribute("aria-label", `Dashboards: ${ORG.orgName} Found`);
    await expect(own).not.toContainText("%");

    expect((await capabilityRow(cap.Dashboards)).ourStatus).toBe("found");
    expect(await withTestDb((db) => db.competitorScan.count({ where: { workspaceId } })), "no scan is created by the edit").toBe(scansBefore);
    expect(await withTestDb((db) => db.localScanRequest.count({ where: { workspaceId, state: "waiting" } }))).toBe(0);
    const [event] = await events("cmp_catalog_edited", { action: "ourStatus" });
    expect(event, "cmp_catalog_edited ourStatus").toBeTruthy();
    expect(propsOf(event)).toMatchObject({ entity: "capability", action: "ourStatus", entityId: cap.Dashboards, from: "not_found", to: "found" });
    expect(event.userId).toBe(memberId);
  });

  test("CA-16 a PM's cell value survives the next analysis: after it the cell still shows the member's value with the edited mark, Edited by the member and the date, and Scan found with what the analysis found; after Reset it shows that; events cmp_status_overridden with from, to and reset [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "member");
    await openMatrix(page);
    const td = await expectCell(page, "Roadmap", ALPHA, "found");
    await td.getByRole("button").first().click();
    await page.getByRole("button", { name: "Correct this" }).click();
    await page.getByRole("button", { name: "Not found", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expectCell(page, "Roadmap", ALPHA, "not_found");
    await expect(td.locator('[aria-label="edited"]')).toHaveCount(1);
    await page.keyboard.press("Escape");

    // The analysis finds Roadmap on the changed page: the scanned value is Found with this quote.
    const quote = "Roadmaps are shared with the whole company.";
    await injectedScan(alpha, { items: [{ name: "Roadmap", quote }] });
    const stored = await cellOf(alpha.id, cap.Roadmap);
    expect([stored?.value, stored?.quote, stored?.overrideValue], "the analysis wrote the scanned value and kept the correction").toEqual(["found", quote, "not_found"]);

    await openMatrix(page);
    await expectControl(page, alpha);
    const after = await expectCell(page, "Roadmap", ALPHA, "not_found");
    await expect(after.locator('[aria-label="edited"]')).toHaveCount(1);
    await after.getByRole("button").first().click();
    await expect(page.getByText(`Edited by ${MEMBER.name}, ${shortDate(new Date())}`)).toBeVisible();
    await expect(page.getByText("Scan found: Found")).toBeVisible();
    await page.getByRole("button", { name: "Reset to scanned" }).click();
    await expectCell(page, "Roadmap", ALPHA, "found");
    await expect(after.locator('[aria-label="edited"]')).toHaveCount(0);

    const overrides = await events("cmp_status_overridden", { capabilityId: cap.Roadmap });
    expect(overrides).toHaveLength(2);
    expect(propsOf(overrides[1])).toMatchObject({ competitorId: alpha.id, from: "found", to: "not_found", reset: false });
    expect(propsOf(overrides[0])).toMatchObject({ competitorId: alpha.id, from: "not_found", to: "found", reset: true });
    expect(overrides.map((o) => o.userId)).toEqual([memberId, memberId]);
  });

  // ————————————————————————————— Roles, organizations —————————————————————————————

  // Daniel 2026-11-11: the roles stay, but USER and CUSTOMER_ADMIN have the same permissions by default (d232d00,
  // canManageOrgSettings).
  test("CA-17 roles — a member has the same permissions as the org admin: the same controls in Settings (add, edit, remove, drag, the Removed panel with its items) and no 'Only an admin' line; the state sent to him lists the removed items; as the member restore and remove a capability in the UI and rename, move, add, reorder, remove and restore through the routes — each succeeds and is recorded under his name; /admin stays closed to him [knobs: fake site]", async ({ browser }) => {
    test.setTimeout(180_000);
    // Something is removed (by the org admin).
    await removeCapability(cap.Dashboards);
    const removedDomainId = (await withTestDb((db) => db.competitorDomain.create({ data: { workspaceId, name: "QA Removed Domain", position: 7, state: "removed", removedAt: new Date(), removedById: pmId } }))).id;
    /** Events of this kind recorded under the member's own id. */
    const byMember = async (event: string, match: Record<string, unknown>) => (await events(event, match)).filter((e) => e.userId === memberId);

    // ——— The same controls as the org admin ———
    const page = await open(browser, "member");
    await openSettings(page, "domains", "capabilities");
    const pm = await open(browser, "pm");
    await openSettings(pm, "domains", "capabilities");
    await expect(page.getByText("Only an admin can change competitors.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add competitor" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add domain" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add capability" })).toHaveCount(1);
    for (const name of ["Roadmap", "Prioritization scoring", "Feedback inbox", "Customer portal"]) {
      await expect(capRow(page, name).getByRole("button", { name: "Remove", exact: true }), `${name}: Remove`).toHaveCount(1);
    }
    for (const name of DOMAINS) {
      await expect(domainCard(page, name).getByRole("button", { name: "Remove", exact: true }), `${name}: Remove`).toHaveCount(1);
      await expect(domainCard(page, name).getByRole("button", { name: "Edit", exact: true }), `${name}: Edit`).toHaveCount(1);
      await expect(domainCard(page, name).locator('[title="Drag to reorder"]'), `${name}: drag handle`).toHaveCount(1);
    }
    // An open capability row is a form for the member too.
    await capToggle(page, "Roadmap").click();
    await expect(capRow(page, "Roadmap").getByTestId("cmp-capability-form")).toBeVisible();
    await capToggle(page, "Roadmap").click();
    await expect(capRow(page, "Roadmap").getByTestId("cmp-capability-form")).toHaveCount(0);
    // The Removed panel, with its items, who removed them and a Restore on each.
    await expect(removedPanel(page)).toBeVisible();
    await expect(removedCapability(page, "Dashboards")).toContainText(removedBy(PM.name));
    await expect(removedCapability(page, "Dashboards").getByTestId("cmp-restore")).toBeEnabled();
    await expect(removedDomain(page, "QA Removed Domain")).toContainText(removedBy(PM.name));
    await expect(removedDomain(page, "QA Removed Domain").getByTestId("cmp-restore")).toBeEnabled();
    // Control for control, the member's page is the org admin's page.
    const controls = async (p: Page) => ({
      onlyAnAdminLine: await p.getByText("Only an admin can change competitors.", { exact: true }).count(),
      addCompetitor: await p.getByRole("button", { name: "Add competitor" }).count(),
      addDomain: await p.getByRole("button", { name: "Add domain" }).count(),
      addCapability: await p.getByRole("button", { name: "Add capability" }).count(),
      remove: await p.getByRole("button", { name: "Remove", exact: true }).count(),
      edit: await p.getByRole("button", { name: "Edit", exact: true }).count(),
      capabilityRows: await p.getByTestId("cmp-capability-row").count(),
      dragHandles: await p.locator('[title="Drag to reorder"]').count(),
      removedCapabilities: await removedPanel(p).getByTestId("cmp-removed-capability").allInnerTexts(),
      removedDomains: await removedPanel(p).getByTestId("cmp-removed-domain").allInnerTexts(),
      restore: await p.getByTestId("cmp-restore").count(),
      disabledFields: await p.locator("select:disabled, input:disabled").count(),
    });
    await expect(removedCapability(pm, "Dashboards")).toHaveCount(1);
    const memberControls = await controls(page);
    expect(memberControls, "the member's controls are the org admin's").toEqual(await controls(pm));
    expect(memberControls).toMatchObject({ onlyAnAdminLine: 0, addCompetitor: 1, addDomain: 1, addCapability: 1, capabilityRows: 4, restore: 2 });

    // The removed names and who removed them are sent to every member of the organization: by the state route and
    // inside the Settings page itself.
    type Removed = { domains: { name: string; removedByName: string | null }[]; capabilities: { name: string; removedByName: string | null }[] };
    const removedOf = async (api: APIRequestContext): Promise<Removed> => {
      const res = await api.get("/api/competitors");
      await ok(res);
      return ((await res.json()) as { state: { removed: Removed } }).state.removed;
    };
    const forMember = await removedOf(memberApi);
    expect(forMember.capabilities.map((k) => [k.name, k.removedByName]), "the member's state lists the removed capability").toEqual([["Dashboards", PM.name]]);
    expect(forMember.domains.map((d) => [d.name, d.removedByName]), "the member's state lists the removed domain").toEqual([["QA Removed Domain", PM.name]]);
    expect(forMember, "the same lists as the org admin's").toEqual(await removedOf(pmApi));
    expect(await page.content(), "the member's Settings page carries the removed domain's name").toContain("QA Removed Domain");

    // ——— In the UI, as the member ———
    // Restore from the Removed panel.
    await removedCapability(page, "Dashboards").getByTestId("cmp-restore").click();
    await expect(removedCapability(page, "Dashboards")).toHaveCount(0);
    await expect(capRow(page, "Dashboards")).toHaveCount(1);
    expect([(await capabilityRow(cap.Dashboards)).state, (await capabilityRow(cap.Dashboards)).removedById]).toEqual(["active", null]);
    expect(await byMember("cmp_catalog_edited", { entity: "capability", action: "restore", via: "settings", entityId: cap.Dashboards }), "restore, by the member").toHaveLength(1);
    // Remove a capability: the same dialog, and the Removed panel names him.
    await capRow(page, "Customer portal").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Remove Customer portal?");
    await acceptConfirm(page);
    await expect(capRow(page, "Customer portal")).toHaveCount(0);
    await expect(removedCapability(page, "Customer portal")).toContainText(removedBy(MEMBER.name));
    expect([(await capabilityRow(cap["Customer portal"])).state, (await capabilityRow(cap["Customer portal"])).removedById]).toEqual(["removed", memberId]);
    expect(await byMember("cmp_catalog_edited", { entity: "capability", action: "remove", entityId: cap["Customer portal"] }), "remove, by the member").toHaveLength(1);

    // ——— Through the routes, as the member: every call succeeds and changes the row ———
    await ok(await memberApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { name: "Member roadmap" } }));
    expect((await capabilityRow(cap.Roadmap)).name, "rename a capability").toBe("Member roadmap");
    await ok(await memberApi.patch(`/api/competitors/domains/${dom.Planning}`, { data: { name: "Member planning" } }));
    expect((await domainRow(dom.Planning)).name, "rename a domain").toBe("Member planning");
    await ok(await memberApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { domainId: dom.Feedback } }));
    expect((await capabilityRow(cap.Roadmap)).domainId, "move a capability").toBe(dom.Feedback);
    await ok(await memberApi.post("/api/competitors/capabilities", { data: { name: "Member capability", domainId: dom.Planning } }), 201);
    expect((await capabilitiesNamed("Member capability")).map((r) => [r.domainId, r.state, r.origin]), "add a capability").toEqual([[dom.Planning, "active", "manual"]]);
    await ok(await memberApi.post("/api/competitors/capabilities", { data: { name: "Customer portal", domainId: dom.Planning } }), 201);
    expect((await capabilitiesNamed("Customer portal")).map((r) => [r.id, r.domainId, r.state]), "add a removed capability back").toEqual([[cap["Customer portal"], dom.Planning, "active"]]);
    const order = [dom.Reporting, dom.Planning, dom.Feedback];
    await ok(await memberApi.put("/api/competitors/domains", { data: { order } }));
    expect(await Promise.all(order.map(async (id) => (await domainRow(id)).position)), "reorder the domains").toEqual([0, 1, 2]);
    await ok(await memberApi.post("/api/competitors/domains", { data: { name: "Member domain" } }), 201);
    expect((await domainsNamed("Member domain")).map((d) => d.state), "add a domain").toEqual(["active"]);
    await ok(await memberApi.delete(`/api/competitors/domains/${dom.Feedback}?moveTo=${dom.Planning}`));
    expect([(await domainRow(dom.Feedback)).state, (await domainRow(dom.Feedback)).removedById], "remove a domain").toEqual(["removed", memberId]);
    expect((await capabilityRow(cap["Feedback inbox"])).domainId, "its capabilities moved").toBe(dom.Planning);
    await ok(await memberApi.patch(`/api/competitors/domains/${removedDomainId}`, { data: { state: "active" } }));
    expect((await domainRow(removedDomainId)).state, "restore a domain").toBe("active");
    // Add a competitor (its first scan waits for the station) and remove it again.
    const rival = await addCompetitor(memberApi, await startSite(rowSites), "QA-CA Member Rival");
    await waitForScanWithStatus(rival.sourceId, "pending_local");
    await ok(await memberApi.delete(`/api/competitors/${rival.id}`));
    expect((await withTestDb((db) => db.competitor.findUniqueOrThrow({ where: { id: rival.id } }))).deletedAt, "remove a competitor").not.toBeNull();

    // Every one of them is recorded under the member's name; the org admin's only record is the setup's removal.
    const recorded: [string, Record<string, unknown>, number][] = [
      ["cmp_catalog_edited", { entity: "capability", action: "rename", entityId: cap.Roadmap, from: "Roadmap", to: "Member roadmap" }, 1],
      ["cmp_catalog_edited", { entity: "domain", action: "rename", entityId: dom.Planning, from: "Planning", to: "Member planning" }, 1],
      ["cmp_catalog_edited", { entity: "capability", action: "move", entityId: cap.Roadmap, from: dom.Planning, to: dom.Feedback }, 1],
      ["cmp_catalog_edited", { entity: "capability", action: "create", name: "Member capability" }, 1],
      ["cmp_catalog_edited", { entity: "capability", action: "restore", via: "add", entityId: cap["Customer portal"] }, 1],
      ["cmp_catalog_edited", { entity: "domain", action: "reorder", to: order.join(",") }, 1],
      ["cmp_catalog_edited", { entity: "domain", action: "create", name: "Member domain" }, 1],
      ["cmp_catalog_edited", { entity: "domain", action: "remove", entityId: dom.Feedback, moveTo: dom.Planning }, 1],
      ["cmp_catalog_edited", { entity: "domain", action: "restore", entityId: removedDomainId }, 1],
      ["cmp_competitor_added", { competitorId: rival.id }, 1],
      ["cmp_competitor_removed", { competitorId: rival.id }, 1],
    ];
    for (const [event, match, n] of recorded) expect(await byMember(event, match), `${event} ${JSON.stringify(match)} by the member`).toHaveLength(n);
    expect((await events("cmp_catalog_edited")).filter((e) => e.userId === pmId), "the org admin: only the setup's removal").toHaveLength(1);

    // ——— /admin stays closed: a member is not a PM-OS admin ———
    for (const path of ["/admin", "/admin/users", "/admin/competitors"]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} for the member`).toBe(404);
    }
    for (const path of ["/api/admin/organizations", "/api/admin/competitors/settings"]) {
      expect((await memberApi.get(path)).status(), `GET ${path} for the member`).toBe(404);
    }
    expect((await memberApi.patch("/api/admin/competitors/settings", { data: { remoteScanEnabled: false } })).status(), "the member cannot change Administration → Competitors").toBe(404);
    // Positive control: the route exists and answers the PM-OS admin.
    await ok(await adminApi.get("/api/admin/organizations"));
  });

  test("CA-18 (proposed) organizations are separate: with Dashboards removed in the first org, the second org keeps its Dashboards row (an analysis there fills its cell) and gets the new row its analysis finds, and the third org gets a new row [knobs: AI answer injected, fake site, run-once]", async ({ browser, playwright }) => {
    test.setTimeout(360_000);
    await removeCapability(cap.Dashboards);

    // The second org: its own catalog (Dashboards and the control capability under Reporting) and a competitor on the fake site.
    const pm2State = await loginAndSave(browser, PM2, "ca-pm2-state.json");
    const pm2Api = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: pm2State });
    const pm3State = await loginAndSave(browser, PM3, "ca-pm3-state.json");
    const pm3Api = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: pm3State });
    let gamma: Cmp | undefined;
    try {
      gamma = await addCompetitor(pm2Api, await startSite(rowSites), "QA-CA Gamma");
      const onboarding = await waitForScanWithStatus(gamma.sourceId, "pending_local");
      await expectOnlyOwnRequestsWaiting([workspaceId, workspace2Id, workspace3Id]);
      expect((await runStationPoller({ key: keyFile })).code).toBe(0);
      const first = await waitForScanEnd(onboarding.id);
      expect(first.status, `QA-CA Gamma onboarding: ${first.error ?? ""}`).toBe("ok");
      await primeAnalysis(gamma);
      const gammaId = gamma.id;
      const second = await withTestDb(async (db) => {
        const reporting = await db.competitorDomain.create({ data: { workspaceId: workspace2Id, name: "Reporting", position: 0 } });
        const dashboards = await db.capability.create({ data: { workspaceId: workspace2Id, domainId: reporting.id, name: "Dashboards", ourStatus: "not_found", position: 0 } });
        const scoring = await db.capability.create({ data: { workspaceId: workspace2Id, domainId: reporting.id, name: CONTROL, ourStatus: "not_found", position: 1 } });
        for (const k of [dashboards, scoring]) {
          await db.capabilityStatus.create({ data: { workspaceId: workspace2Id, competitorId: gammaId, capabilityId: k.id, value: "not_found", scanId: first.id } });
        }
        return { reportingId: reporting.id, dashboardsId: dashboards.id };
      });
      // Scan now by the second org's own PM.
      await injectedScan(gamma, {
        items: [{ name: "Dashboards", quote: "Dashboards for every account." }, { name: "Dashboards 2", quote: "A second dashboard for executives." }],
        place: [{ entry: "T1", domainId: second.reportingId, marketName: "Dashboards 2", description: "A dashboard for executives." }],
      }, pm2Api);

      // The second org keeps its row (its cell filled by the analysis) and gets its new row.
      expect((await capabilitiesNamed("Dashboards", workspace2Id)).map((r) => [r.id, r.state])).toEqual([[second.dashboardsId, "active"]]);
      expect((await cellOf(gammaId, second.dashboardsId))?.value, "the second org's Dashboards cell").toBe("found");
      expect((await capabilitiesNamed("Dashboards 2", workspace2Id)).map((r) => [r.domainId, r.state])).toEqual([[second.reportingId, "active"]]);
      expect(await events("cmp_decision_respected", {}, workspace2Id), "nothing of the first org's decisions applies here").toHaveLength(0);
      const page = await open(browser, pm2State);
      await openMatrix(page);
      await expectCell(page, CONTROL, "QA-CA Gamma", "found");
      const groups = await matrixGroups(page);
      expect(groups).toEqual([{ domain: "Reporting", suggestedDomain: false, rows: ["Dashboards", CONTROL, "Dashboards 2"] }]);
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
      if (gamma) await setAnswers(gamma.id, null).catch(() => undefined);
      await withTestDb((db) => db.competitor.updateMany({ where: { workspaceId: workspace2Id, deletedAt: null }, data: { deletedAt: new Date() } }));
      await pm2Api.dispose();
      await pm3Api.dispose();
    }
  });

  // CA-19 (a removed capability's news stays in the feed) was removed on 2026-11-22 by the News Feed & Notifications
  // session: the feed shows new abilities only, no table status moves, so there is no such item to keep. PRD question:
  // row CA-19 is still in the Capability Analysis PRD.

  // ————————————————————————————— Names added by hand —————————————————————————————

  test("CA-20 (proposed) a name added by hand wins over a replaced name: two rows, Product roadmap and Roadmap; the analysis adds no third row and finds Roadmap under its own name; Product roadmap no longer keeps Roadmap as a replaced name [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    await ok(await pmApi.patch(`/api/competitors/capabilities/${cap.Roadmap}`, { data: { name: "Product roadmap" } }));
    expect((await capabilityRow(cap.Roadmap)).aliases, "the rename keeps the replaced name").toEqual(["Roadmap"]);
    await ok(await pmApi.post("/api/competitors/capabilities", { data: { name: "Roadmap", domainId: dom.Planning } }), 201);
    const added = await capabilitiesNamed("Roadmap");
    expect(added.map((r) => [r.state, r.origin, r.domainId])).toEqual([["active", "manual", dom.Planning]]);
    expect(added[0].id).not.toBe(cap.Roadmap);
    expect((await capabilityRow(cap.Roadmap)).aliases, "Product roadmap no longer keeps Roadmap as a replaced name").toEqual([]);

    const before = await catalogOf();
    const quote = "A roadmap for every team.";
    await injectedScan(alpha, { items: [{ name: "roadmap", quote }] });
    expect(await catalogOf(), "no third row").toEqual(before);
    expect(before.capabilities.filter((k) => /roadmap/i.test(k.name)).map((k) => k.name).sort()).toEqual(["Product roadmap", "Roadmap"]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await events("cmp_decision_respected"), "the name is a row of the table today, not a replaced name").toHaveLength(0);
    expect((await cellOf(alpha.id, added[0].id))?.quote, "the item went to the row that carries the name today").toBe(quote);
    expect((await cellOf(alpha.id, cap.Roadmap))?.quote ?? null, "not to the renamed row").not.toBe(quote);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.find((g) => g.domain === "Planning")!.rows.filter((n) => /roadmap/i.test(n)).sort()).toEqual(["Product roadmap", "Roadmap"]);
  });

  test("CA-21 a capability added by hand is looked for at every competitor: both cells on SSO show what each analysis found, with the quote and the link; event create [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await addCapabilityInSettings(page, "SSO", "Planning");
    await expect(capRow(page, "SSO")).toHaveCount(1);
    const [sso] = await capabilitiesNamed("SSO");
    expect([sso.state, sso.origin, sso.domainId]).toEqual(["active", "manual", dom.Planning]);
    const [created] = await events("cmp_catalog_edited", { action: "create" });
    expect(created, "cmp_catalog_edited create").toBeTruthy();
    expect(propsOf(created)).toMatchObject({ entity: "capability", action: "create", entityId: sso.id, from: null, to: "SSO", name: "SSO" });
    expect(created.userId).toBe(pmId);

    const quote = { [alpha.id]: "Single sign-on with SAML on every plan.", [beta.id]: "Single sign-on through any SAML provider." };
    for (const c of [alpha, beta]) await injectedScan(c, { items: [{ name: "SSO", quote: quote[c.id] }] });
    const cells = await cellsOf(sso.id);
    expect(cells.map((s) => [s.competitorId, s.value, s.quote, s.sourceUrl]).sort()).toEqual([alpha, beta].map((c) => [c.id, "found", quote[c.id], `${c.site.url}/pricing`]).sort());

    await openMatrix(page);
    for (const c of [alpha, beta]) {
      await expectControl(page, c);
      const td = await expectCell(page, "SSO", c.name, "found");
      await expectCellEvidence(page, td, quote[c.id], `${c.site.url}/pricing`);
    }
  });

  test("CA-22 a domain added by hand receives capabilities: Usage billing is attached to Pricing; no suggested domain is created [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await open(browser, "pm");
    await openSettings(page, "domains");
    await addDomainInSettings(page, "Pricing");
    const [pricing] = await domainsNamed("Pricing");
    expect([pricing.state, pricing.origin]).toEqual(["active", "manual"]);

    await injectedScan(alpha, {
      items: [{ name: "Usage billing", quote: "You pay for what your team uses." }],
      place: [{ entry: "T1", domainId: pricing.id, marketName: "Usage billing", description: "How the product is priced and billed." }],
    });
    expect((await capabilitiesNamed("Usage billing")).map((r) => [r.domainId, r.state, r.origin])).toEqual([[pricing.id, "active", "ai"]]);
    expect((await domainsNamed("pricing")).map((d) => [d.id, d.state]), "one Pricing domain, the PM's").toEqual([[pricing.id, "active"]]);
    expect((await suggestedRows()).domains, "no suggested domain").toBe(0);

    await openMatrix(page);
    await expectControl(page, alpha);
    const groups = await matrixGroups(page);
    expect(groups.find((g) => g.domain === "Pricing")).toEqual({ domain: "Pricing", suggestedDomain: false, rows: ["Usage billing"] });
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    await expectCell(page, "Usage billing", ALPHA, "found");
  });

  // PRD question (CA-23): the row expects "No 'Invoices' row" and cmp_decision_respected (entity domain, reason
  // dismissed). Today the match is given only the domains in the table, so the declined Billing is never offered; an
  // item that is none of ours becomes a row in a domain of the table (the PM table: "Declines a suggested domain → the
  // capability moves to the closest domain"). The row asserts what holds: Billing stays declined, nothing goes into it.
  test("CA-23 a declined domain is not suggested again: no suggested domain appears and Billing is still declined; nothing is placed in Billing [knobs: AI answer injected, fake site, run-once]", async ({ browser }) => {
    test.setTimeout(180_000);
    // A suggested domain "Billing" (as a scan left it), declined through the route.
    const billing = await seedSuggestedDomain("Billing", "suggested");
    await declineDomain(billing.id);
    expect((await domainRow(billing.id)).state).toBe("dismissed");
    const domainsBefore = (await catalogOf()).domains;

    await injectedScan(alpha, {
      items: [{ name: "Invoices", quote: "Invoices are sent at the end of each month." }],
      place: [{ entry: "T1", domainId: dom.Reporting, marketName: "Invoices", description: "Invoices and payments." }],
    });
    expect((await catalogOf()).domains, "no domain row was created or changed").toEqual(domainsBefore);
    expect((await domainsNamed("billing")).map((d) => [d.id, d.state])).toEqual([[billing.id, "dismissed"]]);
    expect(await suggestedRows()).toEqual({ domains: 0, capabilities: 0 });
    expect(await withTestDb((db) => db.capability.count({ where: { domainId: billing.id } })), "nothing is placed in the declined domain").toBe(0);
    expect((await capabilitiesNamed("Invoices")).map((r) => r.domainId), "the item went to a domain of the table").toEqual([dom.Reporting]);

    const page = await open(browser, "pm");
    await openMatrix(page);
    await expectControl(page, alpha);
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
    expect((await matrixGroups(page)).map((g) => g.domain)).toEqual(["Planning", "Feedback", "Reporting"]);
  });

  test("CA-24 (proposed) restoring a capability whose domain is not in the table asks where it returns: Restore disabled until a domain is picked, the line says its domain is not in the table; pick Planning → Dashboards under Planning with its earlier cells; Reporting stays removed; event restore from Reporting to Planning [knobs: none]", async ({ browser }) => {
    const cellsBefore = await cellsOf(cap.Dashboards);
    await removeCapability(cap.Dashboards);
    await removeDomain(dom.Reporting); // it holds nothing else: no move question
    expect((await domainRow(dom.Reporting)).state).toBe("removed");

    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    const line = removedCapability(page, "Dashboards");
    await expect(line).toContainText('Its domain "Reporting" is not in the table. Pick the domain it returns to.');
    await expect(line.getByTestId("cmp-restore")).toBeDisabled();
    expect((await line.getByTestId("cmp-restore-domain").locator("option:not([disabled])").allTextContents()).sort()).toEqual(["Feedback", "Planning"]);
    await line.getByTestId("cmp-restore-domain").selectOption({ label: "Planning" });
    await expect(line.getByTestId("cmp-restore")).toBeEnabled();
    await line.getByTestId("cmp-restore").click();
    await expect(removedCapability(page, "Dashboards")).toHaveCount(0);
    await expect(removedDomain(page, "Reporting")).toHaveCount(1);
    await expect(capRow(page, "Dashboards")).toHaveCount(1);

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
    expect(propsOf(event)).toMatchObject({ fromDomainId: dom.Reporting, toDomainId: dom.Planning });
    expect(event.userId).toBe(pmId);
  });

  // ————————————————————————————— Suggestions a scan left (seeded) —————————————————————————————

  // PRD QUESTION (CA-25, CA-26): capability suggestions were removed from the product on 2026-11-11 (ebb5a47, "a
  // capability an analysis finds is just added to the table — there is nothing to accept"): no Suggested panel in
  // Settings, no accept branch in the capability route, no cmp_capability_suggestion event. Both PRD rows still
  // describe accepting one, so both rows are red on purpose until Daniel retires them or the behaviour comes back.
  // CA-25 calls the route the panel called, with the same body.
  test("CA-25 accepting a suggestion with a new name and another domain records each change: one request {state, name, domainId}; the row is Report scheduling under Planning; events rename (from, to), move (from, to) and cmp_capability_suggestion accepted [knobs: none]", async ({ browser }) => {
    const suggestion = await seedSuggestedCapability("Scheduled reports", dom.Reporting, "suggested", 9999);
    await ok(await pmApi.patch(`/api/competitors/capabilities/${suggestion.id}`, { data: { state: "active", name: "Report scheduling", domainId: dom.Planning } }));

    const row = await capabilityRow(suggestion.id);
    expect([row.name, row.state, row.domainId, row.origin], "PRD QUESTION (CA-25): the route no longer accepts a suggested capability (ebb5a47, 2026-11-11)").toEqual(["Report scheduling", "active", dom.Planning, "ai"]);
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

    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    await expect(capRow(page, "Report scheduling")).toHaveCount(1);
    // The accepted row is still the scan's find (CA-27 asserts the opposite for a name a PM adds by hand).
    await expect(capRow(page, "Report scheduling")).toContainText("PMOS AI");
    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Report scheduling")).toBe("Planning");
    expect(allRows(groups)).not.toContain("Scheduled reports");
  });

  test("CA-26 (proposed) a capability enters the table only inside a domain that is in the table: accepting a declined suggestion whose domain is declined or removed answers 400 and nothing changes; with a domain of the table picked it is accepted, last in the order; a suggestion waiting in a removed domain moves with its capabilities [knobs: none]", async ({ browser }) => {
    const message = "Pick a domain that is in the table.";
    // As the earlier scans left them: a suggested domain Billing with its suggestion Invoices, two suggestions in Reporting.
    const billing = await seedSuggestedDomain("Billing", "suggested");
    const invoices = await seedSuggestedCapability("Invoices", billing.id, "suggested", 9997);
    const scheduled = await seedSuggestedCapability("Scheduled reports", dom.Reporting, "suggested", 9998);
    const builder = await seedSuggestedCapability("Report builder", dom.Reporting, "suggested", 9999);
    await withTestDb((db) => db.capabilityStatus.create({ data: { workspaceId, competitorId: alpha.id, capabilityId: scheduled.id, value: "found", quote: "Reports go out on a schedule.", sourceUrl: `${alpha.site.url}/pricing`, evidenceCount: 1, scanId: firstScanId[alpha.id] } }));

    // The PM declines the suggested domain (its suggestion goes with it), declines Scheduled reports, then removes
    // Reporting: Dashboards and the suggestion still waiting there move to Planning, the declined one stays behind.
    await declineDomain(billing.id);
    expect([(await domainRow(billing.id)).state, (await capabilityRow(invoices.id)).state], "PRD QUESTION (CA-26): declining a suggested domain no longer declines its suggestions — capability suggestions are gone (ebb5a47, 2026-11-11)").toEqual(["dismissed", "dismissed"]);
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
    const cellsBefore = { [invoices.id]: await cellsOf(invoices.id), [scheduled.id]: await cellsOf(scheduled.id) };
    const lastPosition = Math.max(...before.capabilities.filter((k) => k.state === "active").map((k) => k.position));
    for (const [id, what] of [[invoices.id, "Invoices (its domain was declined)"], [scheduled.id, "Scheduled reports (its domain was removed)"]] as const) {
      const res = await pmApi.patch(`/api/competitors/capabilities/${id}`, { data: { state: "active" } });
      expect(res.status(), what).toBe(400);
      expect(((await res.json()) as { error: string }).error, what).toBe(message);
      expect(await cellsOf(id), `${what}: no cell is written`).toEqual(cellsBefore[id]);
    }
    expect(await catalogOf(), "nothing changes").toEqual(before);
    expect(await events("cmp_capability_suggestion", { decision: "accepted" }), "no acceptance is recorded").toHaveLength(0);

    // With a domain of the table picked the same row is accepted: it gets the next place in the order and keeps Alpha's cell.
    await ok(await pmApi.patch(`/api/competitors/capabilities/${scheduled.id}`, { data: { state: "active", domainId: dom.Planning } }));
    const accepted = await capabilityRow(scheduled.id);
    expect([accepted.state, accepted.domainId, accepted.position]).toEqual(["active", dom.Planning, lastPosition + 1]);
    expect((await cellsOf(scheduled.id)).map((s) => [s.competitorId, s.value])).toEqual([[alpha.id, "found"]]);
    const [decision] = await events("cmp_capability_suggestion", { decision: "accepted" });
    expect(propsOf(decision)).toMatchObject({ capabilityId: scheduled.id, competitorId: alpha.id, decision: "accepted", domainChanged: true });
    expect((await capabilityRow(invoices.id)).state, "Invoices stays declined").toBe("dismissed");

    const page = await open(browser, "pm");
    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groups.map((g) => g.domain)).toEqual(["Planning", "Feedback"]);
    expect(groups[0].rows).toEqual(["Roadmap", "Prioritization scoring", "Dashboards", "Scheduled reports"]);
    expect(allRows(groups)).not.toContain("Invoices");
    await expectCell(page, "Scheduled reports", ALPHA, "found");
  });

  test("CA-27 (proposed) a declined suggestion a PM adds by hand is his row: Scheduled reports → the same row, active, origin manual, no suggesting competitor and no suggestion quote, no PMOS AI mark; Billing → the same domain, active, origin manual, empty; events restore via add from dismissed [knobs: none]", async ({ browser }) => {
    const scheduled = await seedSuggestedCapability("Scheduled reports", dom.Reporting, "dismissed", 9998);
    const billing = await seedSuggestedDomain("Billing", "dismissed");
    const invoices = await seedSuggestedCapability("Invoices", billing.id, "dismissed", 9999);
    expect([scheduled.origin, scheduled.suggestedById, billing.origin, billing.suggestedById]).toEqual(["ai", alpha.id, "ai", alpha.id]);

    const page = await open(browser, "pm");
    await openSettings(page, "domains", "capabilities");
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/competitors/capabilities");
    await addCapabilityInSettings(page, "Scheduled reports", "Planning");
    expect((await posted).status(), "no 409 for a declined name").toBe(201);
    await expect(capRow(page, "Scheduled reports")).toHaveCount(1);
    await expect(capRow(page, "Scheduled reports")).not.toContainText("PMOS AI");

    const rows = await capabilitiesNamed("Scheduled reports");
    expect(rows.map((r) => [r.id, r.state, r.domainId]), "one row with the name: the declined one, now in the table").toEqual([[scheduled.id, "active", dom.Planning]]);
    expect([rows[0].origin, rows[0].suggestedById, rows[0].suggestedQuote], "it is the PM's row, not the scan's").toEqual(["manual", null, null]);
    const [restored] = await events("cmp_catalog_edited", { action: "restore", entity: "capability" });
    expect(restored, "cmp_catalog_edited restore (capability)").toBeTruthy();
    expect(propsOf(restored)).toMatchObject({ entityId: scheduled.id, from: "dismissed", to: "active", name: "Scheduled reports", via: "add" });
    expect(restored.userId).toBe(pmId);

    // The same for a declined domain.
    await addDomainInSettings(page, "Billing");
    await expect(domainCard(page, "Billing")).toContainText("0 capabilities");
    const domains = await domainsNamed("Billing");
    expect(domains.map((d) => [d.id, d.state, d.origin, d.suggestedById]), "one Billing domain: the declined one, now the PM's").toEqual([[billing.id, "active", "manual", null]]);
    expect((await capabilityRow(invoices.id)).state, "the suggestion declined with the domain stays declined").toBe("dismissed");
    const [restoredDomain] = await events("cmp_catalog_edited", { action: "restore", entity: "domain" });
    expect(restoredDomain, "cmp_catalog_edited restore (domain)").toBeTruthy();
    expect(propsOf(restoredDomain)).toMatchObject({ entityId: billing.id, from: "dismissed", to: "active", name: "Billing", via: "add" });
    expect(await events("cmp_catalog_edited", { action: "create" }), "two restores, no second row").toHaveLength(0);

    await openMatrix(page);
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Scheduled reports")).toBe("Planning");
    await expect(page.getByTestId("cmp-suggested-domain")).toHaveCount(0);
  });

  test("CA-28 (proposed) renaming a capability to a declined suggestion's name succeeds: Dashboards becomes Scheduled reports with no 'already exists' error; one row has the name, the declined row is gone; the cells stay; event rename [knobs: none]", async ({ browser }) => {
    const declined = await seedSuggestedCapability("Scheduled reports", dom.Reporting, "dismissed", 9999);
    const cellsBefore = await cellsOf(cap.Dashboards);

    const page = await open(browser, "pm");
    await openSettings(page, "capabilities");
    const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/competitors/capabilities/${cap.Dashboards}`);
    await editCapabilityInSettings(page, "Dashboards", { name: "Scheduled reports" });
    expect((await patched).status(), "no 409 for a declined name").toBe(200);
    await expect(capRow(page, "Scheduled reports")).toHaveCount(1);
    await expect(capRow(page, "Dashboards")).toHaveCount(0);
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
    const groups = await matrixGroups(page);
    expect(groupOf(groups, "Scheduled reports")).toBe("Reporting");
    expect(allRows(groups).filter((n) => n === "Scheduled reports")).toHaveLength(1);
    await expectCell(page, "Scheduled reports", ALPHA, "found");
  });
});
