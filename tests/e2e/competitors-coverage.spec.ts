import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import { hashPasswordLikeApp, hydrated, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";

/**
 * Competitors — Capability Analysis, the coverage model of 2026-11-22 (feature/competitor_website_analysis):
 * a capability cell is a score 0-5, a domain's header carries domain scores and "N Gap(s)" / "N Diff" chips, a PM
 * sets and locks a score, every user has their own relevance level per company, and Settings → Capabilities is a
 * list of short rows that open downward.
 *
 * Rows CM-01 … CM-05. One QA org (QA-CM Org) whose setup is done, two users of it (PM, role USER; PM Two, role
 * CUSTOMER_ADMIN — the same permissions). Before every row the whole table is written again with Prisma, the way
 * an analysis leaves it: eight companies (seven scored, one with no analysis yet), three domains, six scored
 * capabilities, three features. No company has a website source: nothing here scans, no station is involved, and
 * no model is ever called.
 *
 * Knobs — the only deviations from reality, listed on each test:
 *   seeded rows   the table's rows are written with Prisma instead of by an analysis run (the pipeline has its own
 *                 rows). Everything the page shows is computed by the product from those rows.
 *   testAnswer    the re-evaluation routes accept `testAnswer` — the raw JSON text PMOS AI would have answered —
 *                 when COMPETITORS_TEST_KNOBS=on (src/lib/competitors/reevaluate-api.ts). The page itself never
 *                 sends it, so the test adds the field to the page's own PATCH on its way out (page.route +
 *                 route.continue): the request, the route, the parsing, the checks and every write are the real
 *                 ones. A re-evaluation request that would leave without a testAnswer is aborted and fails the
 *                 row, so no row can reach a model.
 * DB, routes and rendering are never mocked.
 */

const ORG = { orgName: "QA-CM Org", slug: "qa-cm-org" };
type Creds = TotpCreds & { name: string };
// Synthetic, test-only credentials.
const PM: Creds = { name: "QA CM PM", email: "qa+cm-pm@pm-os.io", password: "Cm-pm-qa-pass1", totpSecret: "QACMPMAAQACMPMAAQACMPMAAQACMPMAA" };
const PM2: Creds = { name: "QA CM PM Two", email: "qa+cm-pm2@pm-os.io", password: "Cm-pm2-qa-pass1", totpSecret: "QACMPMBBQACMPMBBQACMPMBBQACMPMBB" };
const SCRATCH = join(tmpdir(), "pmos-qa-cm");

/** The companies in column order. Hotel has no cell at all: its analysis has not run. */
const COMPANIES = ["Alpha", "Beta", "Gamma", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"] as const;
type Company = (typeof COMPANIES)[number];
const SCORED: readonly Company[] = COMPANIES.slice(0, 7);
const companyName = (c: Company) => `QA-CM ${c}`;
const DOMAINS = ["Planning", "Feedback", "Reporting"] as const;
type DomainName = (typeof DOMAINS)[number];
const SAME_TEXT = "Planning what to build and when: roadmaps, priorities and release notes.";
/** Planning's PMOS AI definition is the same text as what it covers; Feedback's differs and it names who does the work. */
const DOMAIN_TEXTS: Record<DomainName, { summary: string; description: string; doneBy: string }> = {
  Planning: { summary: SAME_TEXT, description: SAME_TEXT, doneBy: "" },
  Feedback: { summary: "Collecting what customers ask for.", description: "QA-CM definition: count inboxes, portals and votes. Leave out support ticketing.", doneBy: "Product managers and support leads." },
  Reporting: { summary: "Numbers about the product work.", description: "QA-CM definition: dashboards and exports.", doneBy: "" },
};
/** capability → its domain, the organization's own score, and the score of Alpha … Golf (the SCORED order). */
const CAPS = [
  { name: "Roadmap", domain: "Planning", own: 4, scores: [5, 3, 4, 2, 1, 0, 3] },
  { name: "Prioritization scoring", domain: "Planning", own: 0, scores: [2, 0, 1, 0, 0, 0, 0] }, // a gap
  { name: "Release notes hub", domain: "Planning", own: 4, scores: [0, 0, 0, 0, 0, 0, 0] }, // only the organization
  { name: "Feedback inbox", domain: "Feedback", own: 0, scores: [4, 4, 2, 3, 0, 1, 5] }, // a gap
  { name: "Customer portal", domain: "Feedback", own: 0, scores: [1, 0, 0, 0, 0, 0, 0] }, // a gap
  { name: "Dashboards", domain: "Reporting", own: 2, scores: [2, 5, 0, 1, 3, 0, 1] },
] as const satisfies readonly { name: string; domain: DomainName; own: number; scores: readonly number[] }[];
type CapName = (typeof CAPS)[number]["name"];
/** feature → its capability, the organization's own mark, the companies that have it. */
const FEATURES = [
  { name: "Timeline view", capability: "Roadmap", own: "found", at: ["Alpha"] },
  { name: "Swimlanes", capability: "Roadmap", own: "found", at: [] }, // only the organization
  { name: "Email forwarding", capability: "Feedback inbox", own: "not_found", at: ["Beta"] },
] as const satisfies readonly { name: string; capability: CapName; own: string; at: readonly Company[] }[];
const reasoningOf = (company: string, capability: string, score: number) => `QA-CM reasoning: ${company} is at ${score} on ${capability}.`;

const envProblems: string[] = [];
if (RESOLVED_ENV.COMPETITORS_TEST_KNOBS?.trim() !== "on") envProblems.push(`COMPETITORS_TEST_KNOBS must be "on" (got ${RESOLVED_ENV.COMPETITORS_TEST_KNOBS ?? "<unset>"}): without it the re-evaluation would call a model`);

// ————— Shared state —————
let orgId: string;
let workspaceId: string;
let pmId: string;
let pm2Id: string;
const stateFile = { pm: "", pm2: "" };
let pmApi: APIRequestContext;
const openContexts: BrowserContext[] = [];
/** Ids of the rows as seeded before the current test. */
let company: Record<Company, string>;
let cap: Record<CapName, string>;
let dom: Record<DomainName, string>;

// ————— Fixtures —————
async function deleteFixtures(db: PrismaClient): Promise<void> {
  const ws = await db.workspace.findMany({ where: { organization: { slug: ORG.slug } }, select: { id: true } });
  // CompetitorRelevance has no foreign key: it does not go with the organization.
  await db.competitorRelevance.deleteMany({ where: { workspaceId: { in: ws.map((w) => w.id) } } });
  await db.user.deleteMany({ where: { OR: [{ email: { startsWith: "qa+cm-" } }, { organization: { slug: ORG.slug } }] } });
  await db.organization.deleteMany({ where: { slug: ORG.slug } });
}

async function seedFixtures(db: PrismaClient): Promise<void> {
  const one = await seedQaOrgWithUser(db, { ...ORG, features: { competitors: true }, user: PM });
  orgId = one.orgId;
  workspaceId = one.workspaceId;
  pmId = one.userId;
  // The organization's setup is done (set by PM-OS in reality): the pages show the table.
  await db.organization.update({ where: { id: orgId }, data: { competitorsSetup: "done" } });
  process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY;
  pm2Id = (await db.user.create({
    data: { email: PM2.email, name: PM2.name, passwordHash: hashPasswordLikeApp(PM2.password), organizationId: orgId, role: "CUSTOMER_ADMIN", totpSecretEnc: encryptTotpSecret(PM2.totpSecret), totpEnabledAt: new Date(), totpLastUsedStep: null },
  })).id;
}

/** The table as an analysis leaves it. Written again before every test, so no test depends on another. */
async function seedTable(db: PrismaClient): Promise<void> {
  await db.competitorRelevance.deleteMany({ where: { workspaceId } });
  await db.usageEvent.deleteMany({ where: { workspaceId } });
  await db.competitor.deleteMany({ where: { workspaceId } }); // cascades to the cells
  await db.capability.deleteMany({ where: { workspaceId } }); // cascades to the features
  await db.competitorDomain.deleteMany({ where: { workspaceId } });
  await db.productLine.deleteMany({ where: { workspaceId } });
  for (const [position, name] of ["QA-CM Line One", "QA-CM Line Two"].entries()) await db.productLine.create({ data: { workspaceId, name, position } });
  const c = {} as Record<Company, string>;
  for (const [position, name] of COMPANIES.entries()) {
    const host = `${name.toLowerCase()}.qa-cm.invalid`;
    c[name] = (await db.competitor.create({
      data: {
        workspaceId, name: companyName(name), websiteUrl: `https://${host}`, host, position,
        // CM-04: a search for other addresses that PMOS AI could not decide. PM-OS is alerted; the customer is told nothing.
        ...(name === "Alpha" ? { addressSearch: { status: "undecided", at: new Date().toISOString(), trigger: "scan", candidates: 3, added: 0, note: "QA-CM: PMOS AI's answer is unusable", scanId: null } } : {}),
      },
    })).id;
  }
  const d = {} as Record<DomainName, string>;
  for (const [position, name] of DOMAINS.entries()) d[name] = (await db.competitorDomain.create({ data: { workspaceId, name, position, ...DOMAIN_TEXTS[name] } })).id;
  const k = {} as Record<CapName, string>;
  for (const [position, row] of CAPS.entries()) {
    k[row.name] = (await db.capability.create({
      data: {
        workspaceId, domainId: d[row.domain], name: row.name, description: `QA-CM: what ${row.name} covers.`, position, origin: "ai",
        ourScore: row.own, ourStatus: row.own > 0 ? "found" : "not_found", ourScoreReasoning: reasoningOf(ORG.orgName, row.name, row.own),
      },
    })).id;
    for (const [i, name] of SCORED.entries()) {
      const score = row.scores[i];
      await db.capabilityStatus.create({ data: { workspaceId, competitorId: c[name], capabilityId: k[row.name], score, value: score > 0 ? "found" : "not_found", scoreReasoning: reasoningOf(companyName(name), row.name, score) } });
    }
  }
  for (const [position, f] of FEATURES.entries()) {
    const feature = await db.feature.create({ data: { workspaceId, capabilityId: k[f.capability], name: f.name, position, origin: "ai", ourStatus: f.own } });
    for (const name of f.at) {
      const url = `https://${name.toLowerCase()}.qa-cm.invalid/product`;
      await db.featureStatus.create({ data: { workspaceId, competitorId: c[name], featureId: feature.id, value: "found", quote: `QA-CM quote: ${f.name} at ${name}.`, sourceUrl: url, description: `QA-CM: how ${f.name} works at ${name}.`, evidenceCount: 1, evidence: [{ quote: `QA-CM quote: ${f.name} at ${name}.`, url, pageKind: "product page", strength: "describes", checked: true }] } });
    }
  }
  company = c;
  cap = k;
  dom = d;
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

async function open(browser: Browser, who: keyof typeof stateFile, viewport?: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ storageState: stateFile[who], ...(viewport ? { viewport } : {}) });
  openContexts.push(ctx);
  return ctx.newPage();
}

// ————— DB reads —————
const cellRow = (c: Company, k: CapName) => withTestDb((db) => db.capabilityStatus.findUniqueOrThrow({ where: { competitorId_capabilityId: { competitorId: company[c], capabilityId: cap[k] } } }));
const capabilityRow = (k: CapName) => withTestDb((db) => db.capability.findUniqueOrThrow({ where: { id: cap[k] } }));
const relevanceRows = () => withTestDb(async (db) => (await db.competitorRelevance.findMany({ where: { workspaceId }, select: { userId: true, competitorId: true, level: true } })).sort((a, b) => a.userId.localeCompare(b.userId) || a.competitorId.localeCompare(b.competitorId)));
const sorted = <T extends { userId: string; competitorId: string }>(rows: T[]) => [...rows].sort((a, b) => a.userId.localeCompare(b.userId) || a.competitorId.localeCompare(b.competitorId));

// ————— The table —————
const parity = (page: Page) => page.locator('section[aria-label="Parity matrix"]');
async function openMatrix(page: Page): Promise<void> {
  await page.goto("/competitors");
  await expect(page.getByRole("heading", { level: 1, name: "Competitors" })).toBeVisible({ timeout: 30_000 });
  await hydrated(page.getByTestId("cmp-domains-toggle-all"));
}
/** A capability's row (its description (i) carries the capability's name). */
const capRow = (page: Page, name: string) => parity(page).locator("tbody tr", { has: page.getByRole("button", { name: `${name}: show or hide the description`, exact: true }) });
/** A domain's header row (its (i) carries the domain's name). */
const domainHeader = (page: Page, name: string) => parity(page).locator("tbody tr", { has: page.getByRole("button", { name: `${name}: show or hide what this domain covers`, exact: true }) });
const featureRow = (page: Page, name: string) => page.getByTestId("cmp-feature-row").filter({ hasText: name });
/** The names of the capability rows on screen, top to bottom. */
const shownCapabilities = (page: Page) => page.getByTestId("cmp-description-info").evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(": show or hide the description", "")));
/** The company columns on screen, left to right. */
const shownCompanies = async (page: Page) => (await page.getByTestId("cmp-company-column").allInnerTexts()).map((t) => t.split("\n").map((s) => s.trim()).find((s) => s.startsWith("QA-CM ")) ?? t);
const companyColumn = (page: Page, c: Company) => page.getByTestId("cmp-company-column").filter({ hasText: companyName(c) });
/** The scored cell (the button with the number) of a capability row: "own", or a company on screen. */
async function scoreCell(page: Page, k: CapName, column: Company | "own"): Promise<Locator> {
  const index = column === "own" ? 1 : 2 + (await shownCompanies(page)).indexOf(companyName(column));
  expect(index, `column of ${column}`).toBeGreaterThan(0);
  return capRow(page, k).locator("td").nth(index).getByTestId("cmp-score-cell");
}
const marksOf = (row: Locator) => row.getByTestId("cmp-score-mark").allTextContents();
/** Everything that is scrolled, anywhere on the page: 0 while nothing has moved. */
const scrolled = (page: Page) => page.evaluate(() => window.scrollY + [...document.querySelectorAll("*")].reduce((sum, el) => sum + el.scrollTop, 0));

// ————— The testAnswer knob —————
/** The answer PMOS AI would give for a row: one entry per company, by name. */
const answerOf = (scores: Record<string, number>, reasoning: (name: string, score: number) => string) => JSON.stringify({ companies: Object.entries(scores).map(([name, score]) => ({ company: name, score, reasoning: reasoning(name, score) })) });

/**
 * Adds `testAnswer` to the page's own re-evaluation requests (release, add reasoning, try again) on their way to
 * the real route. `next()` gives the answer for the next such request; with none, the request is aborted and the
 * row fails — a re-evaluation never leaves this test for a model.
 */
async function injectAnswers(page: Page, next: () => string | null, seen: Array<Record<string, unknown>>): Promise<void> {
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== "PATCH") return route.continue();
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    seen.push(body);
    const reevaluates = body.release === true || body.reevaluate === true || body.reasoning !== undefined;
    if (!reevaluates) return route.continue();
    const answer = next();
    if (answer === null) return route.abort();
    return route.continue({ postData: JSON.stringify({ ...body, testAnswer: answer }) });
  };
  await page.route("**/api/competitors/statuses/*/score", handler);
  await page.route("**/api/competitors/capabilities/*/score", handler);
}

test.describe("Capability Analysis — the coverage model", () => {
  test.skip(envProblems.length > 0, envProblems.join("; "));

  test.beforeAll(async ({ browser, playwright }) => {
    if (envProblems.length) return;
    test.setTimeout(240_000);
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await seedFixtures(db);
    });
    mkdirSync(SCRATCH, { recursive: true });
    stateFile.pm = await loginAndSave(browser, PM, "cm-pm-state.json");
    stateFile.pm2 = await loginAndSave(browser, PM2, "cm-pm2-state.json");
    pmApi = await playwright.request.newContext({ baseURL: LOCAL_BASE_URL, storageState: stateFile.pm });
  });

  test.beforeEach(async () => {
    if (envProblems.length) return;
    await withTestDb(seedTable);
  });

  test.afterEach(async () => {
    for (const ctx of openContexts.splice(0)) await ctx.close().catch(() => undefined);
  });

  test.afterAll(async () => {
    if (envProblems.length) return;
    await withTestDb(deleteFixtures);
    await pmApi?.dispose();
  });

  test("CM-01 the scored table: numbers 0-5 with the row's top score underlined and no check marks; domain scores and 'N Gap(s)' / 'N Diff' chips in a domain's header; 'Differentiator' on capability and feature rows; first header 'Domains'; only the first domain open, no features open; close / open all domains and a domain's features; no product line filter; six of eight companies at first; Offering Proximity shows six and leaves out a company with no score; cards float above the table and a clicked card catches the wheel; feature rows cannot be changed [knobs: seeded rows]", async ({ browser }) => {
    // A short window, so the page has somewhere to scroll once every domain is open.
    const page = await open(browser, "pm", { width: 1500, height: 620 });
    await openMatrix(page);
    const table = parity(page).locator("table");

    await test.step("the header: 'Domains' first, then the organization and the first six of the eight companies", async () => {
      await expect(table.locator("thead th").first()).toHaveText("Domains");
      await expect(table.locator("thead")).not.toContainText("Capability");
      expect(await shownCompanies(page)).toEqual(COMPANIES.slice(0, 6).map(companyName));
    });

    await test.step("when the page loads only the first domain is open and no capability shows its features", async () => {
      expect(await shownCapabilities(page)).toEqual(["Roadmap", "Prioritization scoring", "Release notes hub"]);
      for (const d of DOMAINS) await expect(domainHeader(page, d)).toHaveCount(1);
      await expect(page.getByTestId("cmp-feature-row")).toHaveCount(0);
      await expect(page.getByTestId("cmp-features-toggle").first()).toHaveAttribute("aria-expanded", "false");
    });

    await test.step("a capability cell is the score's number; the row's top score is underlined; no check mark", async () => {
      const roadmap = capRow(page, "Roadmap");
      // The organization, then Alpha … Foxtrot.
      expect(await marksOf(roadmap)).toEqual(["4", "5", "3", "4", "2", "1", "0"]);
      await expect(roadmap.locator("svg.lucide-check")).toHaveCount(0);
      const top = roadmap.locator('[data-testid="cmp-score-mark"][data-top="true"]');
      await expect(top).toHaveCount(1);
      await expect(top).toHaveText("5");
      await expect(top).toHaveCSS("text-decoration-line", "underline");
      await expect(top).toHaveAttribute("aria-label", "5 of 5, the highest in this row");
      const own = (await scoreCell(page, "Roadmap", "own")).getByTestId("cmp-score-mark");
      await expect(own).toHaveText("4");
      await expect(own).toHaveCSS("text-decoration-line", "none");
      // Only the organization has a score above 0 here: its 4 is the row's top one.
      const hub = capRow(page, "Release notes hub");
      expect(await marksOf(hub)).toEqual(["4", "0", "0", "0", "0", "0", "0"]);
      await expect(hub.locator('[data-testid="cmp-score-mark"][data-top="true"]')).toHaveText("4");
      await expect(table.locator("tbody svg.lucide-check")).toHaveCount(0);
    });

    await test.step("a domain's header: each company's domain score (the average of its capability scores) and the chips", async () => {
      const planning = domainHeader(page, "Planning");
      // (4+0+4)/3, (5+2+0)/3, (3+0+0)/3, (4+1+0)/3, (2+0+0)/3, (1+0+0)/3, 0
      expect(await planning.getByTestId("cmp-domain-score").allTextContents()).toEqual(["2.7", "2.3", "1.0", "1.7", "0.7", "0.3", "0.0"]);
      const topDomain = planning.locator('[data-testid="cmp-domain-score"][data-top="true"]');
      await expect(topDomain).toHaveText("2.7");
      await expect(topDomain).toHaveCSS("text-decoration-line", "underline");
      await expect(planning.getByTestId("cmp-domain-gaps")).toHaveText("1 Gap");
      await expect(planning.getByTestId("cmp-domain-only")).toHaveText("1 Diff");
      await expect(planning).not.toContainText("covered");
      const feedback = domainHeader(page, "Feedback");
      expect(await feedback.getByTestId("cmp-domain-score").allTextContents()).toEqual(["0.0", "2.5", "2.0", "1.0", "1.5", "0.0", "0.5"]);
      await expect(feedback.getByTestId("cmp-domain-gaps")).toHaveText("2 Gaps");
      await expect(feedback.getByTestId("cmp-domain-only")).toHaveCount(0);
      const reporting = domainHeader(page, "Reporting");
      expect(await reporting.getByTestId("cmp-domain-score").allTextContents()).toEqual(["2.0", "2.0", "5.0", "0.0", "1.0", "3.0", "0.0"]);
      await expect(reporting.getByTestId("cmp-domain-gaps")).toHaveCount(0);
      await expect(reporting.getByTestId("cmp-domain-only")).toHaveCount(0);
      await expect(table.locator("tbody")).not.toContainText("covered");
    });

    await test.step("the row chips: 'Gap' on a gap, 'Differentiator' on a row only the organization has", async () => {
      await expect(capRow(page, "Prioritization scoring").getByText("Gap", { exact: true })).toBeVisible();
      await expect(capRow(page, "Release notes hub").getByTestId("cmp-differentiator")).toHaveText("Differentiator");
      await expect(capRow(page, "Roadmap").getByTestId("cmp-differentiator")).toHaveCount(0);
      await expect(table).not.toContainText(/only us/i);
    });

    await test.step("the features of a domain's capabilities open and close together; a feature only the organization has is a 'Differentiator'", async () => {
      const all = domainHeader(page, "Planning").getByTestId("cmp-features-toggle-all");
      await expect(all).toHaveAttribute("aria-label", "Open the features of all capabilities in this domain");
      await all.click();
      await expect(page.getByTestId("cmp-feature-row")).toHaveCount(2);
      await expect(featureRow(page, "Swimlanes").getByTestId("cmp-differentiator")).toHaveText("Differentiator");
      await expect(featureRow(page, "Timeline view").getByTestId("cmp-differentiator")).toHaveCount(0);
      // A feature row is read-only in the table: its name is plain text, with nothing to add, rename or remove.
      for (const name of ["Swimlanes", "Timeline view"]) {
        const first = featureRow(page, name).locator("td").first();
        await expect(first.locator("button, input, textarea")).toHaveCount(0);
      }
      await expect(table.getByRole("button", { name: /add feature|rename|remove|restore/i })).toHaveCount(0);
      await expect(table).not.toContainText("Add feature");
      await expect(all).toHaveAttribute("aria-label", "Close the features of all capabilities in this domain");
      await all.click();
      await expect(page.getByTestId("cmp-feature-row")).toHaveCount(0);
    });

    await test.step("one control closes and opens all domains", async () => {
      const all = page.getByTestId("cmp-domains-toggle-all");
      await expect(all).toHaveAttribute("aria-label", "Open all domains");
      await all.click();
      expect(await shownCapabilities(page)).toEqual(CAPS.map((c) => c.name));
      await expect(all).toHaveAttribute("aria-label", "Close all domains");
      await all.click();
      expect(await shownCapabilities(page)).toEqual([]);
      for (const d of DOMAINS) await expect(domainHeader(page, d)).toHaveCount(1);
      await all.click();
      expect(await shownCapabilities(page)).toEqual(CAPS.map((c) => c.name));
    });

    await test.step("cards are drawn at the end of the page, above the table; a card opened by a click catches the wheel", async () => {
      expect(await scrolled(page), "nothing is scrolled yet").toBe(0);
      const cell = await scoreCell(page, "Roadmap", "Alpha");
      await cell.click();
      const card = page.getByTestId("cmp-score-card");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("cmp-score-reasoning")).toHaveText(reasoningOf(companyName("Alpha"), "Roadmap", 5));
      expect(await card.evaluate((el) => el.parentElement === document.body), "the card is a child of <body>, not of the table").toBe(true);
      await expect(table.getByTestId("cmp-score-card")).toHaveCount(0);
      const box = (await card.boundingBox())!;
      // Where it floats (Floating.tsx): under the cell it was opened from when the whole card fits there, else above
      // it — whole inside the window, and never on top of its own cell.
      const from = (await cell.boundingBox())!;
      const win = page.viewportSize()!;
      expect.soft(box.y >= 0 && box.y + box.height <= win.height, `the card is whole inside the window (card ${Math.round(box.y)}–${Math.round(box.y + box.height)} of ${win.height})`).toBe(true);
      expect.soft(box.y >= from.y + from.height || box.y + box.height <= from.y, `the card does not cover the cell it was opened from (card ${Math.round(box.y)}–${Math.round(box.y + box.height)}, cell ${Math.round(from.y)}–${Math.round(from.y + from.height)})`).toBe(true);
      // Wheel over the table, outside the card: the page does not move under the open card.
      await page.mouse.move(box.x + box.width + 40, box.y + 10);
      await page.mouse.wheel(0, 600);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scrolled(page), { timeout: 1500, intervals: [300] }).toBe(0);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      // Positive control: with the card closed the same wheel scrolls the page.
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scrolled(page)).toBeGreaterThan(0);
      // The other cards float the same way.
      await page.getByRole("button", { name: "Roadmap: show or hide the description", exact: true }).click();
      const description = page.getByTestId("cmp-description-card");
      await expect(description).toContainText("QA-CM: what Roadmap covers.");
      expect(await description.evaluate((el) => el.parentElement === document.body)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(description).toHaveCount(0);
      await page.getByRole("button", { name: "Feedback: show or hide what this domain covers", exact: true }).click();
      const info = page.getByTestId("cmp-domain-card");
      await expect(info).toContainText(DOMAIN_TEXTS.Feedback.summary);
      expect(await info.evaluate((el) => el.parentElement === document.body)).toBe(true);
      await info.getByTestId("cmp-domain-more").click();
      await expect(info.getByTestId("cmp-domain-done-by")).toContainText(DOMAIN_TEXTS.Feedback.doneBy);
      // Esc closes a card (the standing keyboard rule; the two cards above close that way).
      await page.keyboard.press("Escape");
      await expect.soft(info, "Esc closes the domain's card").toHaveCount(0, { timeout: 2000 });
      if (await info.count()) await info.getByRole("button", { name: "Close" }).click();
      await expect(info).toHaveCount(0);
      // Opening the domain's card did not close the domain it sits in.
      expect(await shownCapabilities(page)).toEqual(CAPS.map((c) => c.name));
    });

    await test.step("no product line filter above the table; the Competitor filter adds a company to the six", async () => {
      const filters = parity(page).getByRole("button", { name: /^(Domain|Competitor|Status|Gaps only|Product lines?)/ });
      expect((await filters.allInnerTexts()).map((t) => t.replace(/\s*\d+\s*$/, "").trim())).toEqual(["Domain", "Competitor", "Status", "Gaps only"]);
      await parity(page).getByRole("button", { name: /^Competitor/ }).click();
      await page.getByRole("button", { name: companyName("Golf"), exact: true }).click();
      await page.keyboard.press("Escape");
      expect(await shownCompanies(page)).toEqual(COMPANIES.slice(0, 7).map(companyName));
      expect(await marksOf(capRow(page, "Roadmap"))).toEqual(["4", "5", "3", "4", "2", "1", "0", "3"]);
    });

    await test.step("Offering Proximity: six of the seven scored companies (two closest, two in the middle, two farthest); the company with no score is not there", async () => {
      const rows = page.getByTestId("cmp-closest-card").locator("li");
      await expect(rows).toHaveCount(6);
      // Average score over the six capabilities on a 0-100 scale: Alpha 47, Beta 40, Golf 30, Gamma 23, Delta 20, Echo 13, Foxtrot 3.
      expect((await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim())).toEqual([
        expect.stringMatching(/QA-CM Alpha 47$/), expect.stringMatching(/QA-CM Beta 40$/), expect.stringMatching(/QA-CM Golf 30$/),
        expect.stringMatching(/QA-CM Gamma 23$/), expect.stringMatching(/QA-CM Echo 13$/), expect.stringMatching(/QA-CM Foxtrot 3$/),
      ]);
      await expect(page.getByTestId("cmp-closest-card")).not.toContainText("QA-CM Hotel");
      await expect(page.getByTestId("cmp-closest-card")).not.toContainText("QA-CM Delta");
    });
  });

  test("CM-02 a PM sets and locks a score, releases it and adds reasoning: the set score is locked and marked; a re-evaluation whose answer cannot be used shows 'The re-evaluation did not finish. Try again.' and changes no score; 'Try again' scores the row and leaves a locked score alone; reasoning is saved and the row is scored with it [knobs: seeded rows, testAnswer]", async ({ browser }) => {
    // A tall window: every card of this row has room under its cell (where a card goes is CM-01's subject).
    const page = await open(browser, "pm", { width: 1500, height: 1200 });
    let answer: string | null = null;
    const sent: Array<Record<string, unknown>> = [];
    await injectAnswers(page, () => answer, sent);
    await openMatrix(page);
    const card = page.getByTestId("cmp-score-card");
    const alphaCell = await scoreCell(page, "Roadmap", "Alpha");

    await test.step("set the score: 5 → 2, locked, marked as edited, said in the card", async () => {
      await alphaCell.click();
      await expect(card.getByTestId("cmp-score-reasoning")).toHaveText(reasoningOf(companyName("Alpha"), "Roadmap", 5));
      await expect(card.getByTestId("cmp-score-release")).toHaveCount(0);
      await card.getByTestId("cmp-score-change").click();
      await card.getByTestId("cmp-score-pick-2").click();
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(alphaCell.getByTestId("cmp-score-mark")).toHaveText("2");
      await expect(alphaCell.getByLabel("Edited")).toBeVisible();
      await expect(card).toContainText("PMOS AI does not change it.");
      // The card names who set the score (copy.ts score.lockedBy).
      await expect.soft(card, "the card names the PM who set the score").toContainText(`Score set by ${PM.name}. PMOS AI does not change it.`, { timeout: 2000 });
      const row = await cellRow("Alpha", "Roadmap");
      expect({ score: row.score, value: row.value, by: row.scoreLockedById, locked: row.scoreLockedAt !== null }).toEqual({ score: 2, value: "found", by: pmId, locked: true });
      // Beta's 3 and Gamma's 4 are now the highest… Gamma's 4 ties with the organization's 4: both are underlined.
      expect(await capRow(page, "Roadmap").locator('[data-testid="cmp-score-mark"][data-top="true"]').allTextContents()).toEqual(["4", "4"]);
      expect(sent.at(-1)).toEqual({ score: 2 });
    });

    // A second locked score, set through the same route: the answer below tries to change it.
    const gamma = await cellRow("Gamma", "Roadmap");
    expect((await pmApi.patch(`/api/competitors/statuses/${gamma.id}/score`, { data: { score: 5 } })).status()).toBe(200);

    await test.step("release it on an answer that cannot be used: the generic line, 'Try again', every score as it was", async () => {
      // Alpha has one of Roadmap's features: a score of 0 for it is against the features, and Beta is left out.
      answer = answerOf({ [ORG.orgName]: 4, [companyName("Alpha")]: 0 }, (name, score) => `QA-CM bad answer: ${name} ${score}.`);
      await card.getByTestId("cmp-score-release").click();
      const failed = card.getByTestId("cmp-score-failed");
      await expect(failed).toBeVisible({ timeout: 20_000 });
      await expect(failed).toContainText("The re-evaluation did not finish. Try again.");
      await expect(failed.getByTestId("cmp-score-retry")).toHaveText("Try again");
      // Never the technical reason on the page.
      await expect(card).not.toContainText(/could not be used|not returned|main features/i);
      expect(sent.at(-1)).toEqual({ release: true });
      const k = await capabilityRow("Roadmap");
      expect(k.reevaluatingAt).toBeNull();
      expect(k.reevaluateError, "the reason is kept for PM-OS").toContain("PMOS AI's answer could not be used");
      const alpha = await cellRow("Alpha", "Roadmap");
      expect({ score: alpha.score, locked: alpha.scoreLockedAt !== null, by: alpha.scoreLockedById }, "released, and the failed re-evaluation changed no score").toEqual({ score: 2, locked: false, by: null });
      expect((await cellRow("Beta", "Roadmap")).score).toBe(3);
      expect(k.ourScore).toBe(4);
      await expect(alphaCell.getByTestId("cmp-score-mark")).toHaveText("2");
      await expect(alphaCell.getByLabel("Edited")).toHaveCount(0);
    });

    const good: Record<string, number> = { [ORG.orgName]: 3, ...Object.fromEntries(SCORED.map((c, i) => [companyName(c), [4, 1, 1, 2, 2, 1, 5][i]])) };
    const goodReasoning = (name: string, score: number) => `QA-CM re-evaluated: ${name} is now at ${score} on Roadmap.`;

    await test.step("'Try again' on a good answer: every company is scored again, the locked score stays", async () => {
      answer = answerOf(good, goodReasoning);
      await card.getByTestId("cmp-score-retry").click();
      await expect(card.getByTestId("cmp-score-failed")).toHaveCount(0, { timeout: 20_000 });
      await expect(alphaCell.getByTestId("cmp-score-mark")).toHaveText("4");
      await expect(card.getByTestId("cmp-score-reasoning")).toHaveText(goodReasoning(companyName("Alpha"), 4));
      expect(sent.at(-1)).toEqual({ reevaluate: true });
      // The organization, Alpha, Beta, Gamma (locked at 5 — the answer said 1), Delta, Echo, Foxtrot.
      expect(await marksOf(capRow(page, "Roadmap"))).toEqual(["3", "4", "1", "5", "2", "2", "1"]);
      await expect((await scoreCell(page, "Roadmap", "Gamma")).getByLabel("Edited")).toBeVisible();
      const k = await capabilityRow("Roadmap");
      expect({ at: k.reevaluatingAt, error: k.reevaluateError, own: k.ourScore, reasoning: k.ourScoreReasoning }).toEqual({ at: null, error: null, own: 3, reasoning: goodReasoning(ORG.orgName, 3) });
      const g = await cellRow("Gamma", "Roadmap");
      expect({ score: g.score, locked: g.scoreLockedAt !== null, reasoning: g.scoreReasoning }).toEqual({ score: 5, locked: true, reasoning: reasoningOf(companyName("Gamma"), "Roadmap", 4) });
      // A company off screen (Golf) is scored too; a company with no score (Hotel) gets no cell.
      expect((await cellRow("Golf", "Roadmap")).score).toBe(5);
      expect(await withTestDb((db) => db.capabilityStatus.count({ where: { competitorId: company.Hotel } }))).toBe(0);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    });

    await test.step("add reasoning to a cell: saved under the PM's name, shown in the card, the row is scored with it", async () => {
      const note = "QA-CM note: Beta shipped a public roadmap last week.";
      answer = answerOf({ ...good, [companyName("Beta")]: 3 }, goodReasoning);
      const betaCell = await scoreCell(page, "Roadmap", "Beta");
      await betaCell.click();
      await card.getByTestId("cmp-score-add-reasoning").click();
      await card.getByTestId("cmp-score-reasoning-input").fill(note);
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(betaCell.getByTestId("cmp-score-mark")).toHaveText("3", { timeout: 20_000 });
      await expect(card).toContainText("Reasoning added by your team");
      await expect(card).toContainText(note);
      await expect(card.getByTestId("cmp-score-add-reasoning")).toHaveText("Edit reasoning");
      expect(sent.at(-1)).toEqual({ reasoning: note });
      const b = await cellRow("Beta", "Roadmap");
      expect({ score: b.score, note: b.pmReasoning, by: b.pmReasoningById, locked: b.scoreLockedAt !== null }).toEqual({ score: 3, note, by: pmId, locked: false });
    });

    // Every re-evaluation of this row left with a testAnswer (the three above); none was aborted.
    expect(sent.filter((b) => b.release === true || b.reevaluate === true || b.reasoning !== undefined)).toHaveLength(3);
  });

  test("CM-03 the relevance level is the user's own: set it from the circle on a company's icon, it stays after a reload, a second user of the organization does not see it and sets their own, choosing the current level clears it; the level is 1, 2 or 3 [knobs: seeded rows]", async ({ browser }) => {
    const page = await open(browser, "pm");
    await openMatrix(page);
    const chip = (p: Page, c: Company) => companyColumn(p, c).getByTestId("cmp-relevance-chip");

    await test.step("no level yet: an empty circle on every company", async () => {
      await expect(page.getByTestId("cmp-relevance-chip")).toHaveCount(6);
      for (const c of COMPANIES.slice(0, 6)) {
        await expect(chip(page, c)).toHaveAttribute("aria-label", "Set level");
        await expect(chip(page, c)).toHaveText("");
      }
    });

    await test.step("the PM sets Alpha to 1 and Beta to 2", async () => {
      await chip(page, "Alpha").click();
      const menu = page.getByTestId("cmp-relevance-menu");
      await expect(menu).toHaveAttribute("aria-label", "Relevance to you");
      expect(await menu.evaluate((el) => el.parentElement === document.body), "the picker floats above the table").toBe(true);
      await expect(menu.getByRole("menuitemradio")).toHaveText(["1", "2", "3"]);
      await menu.getByRole("menuitemradio", { name: "Level 1 — most relevant" }).click();
      await expect(menu).toHaveCount(0);
      await expect(chip(page, "Alpha")).toHaveText("1");
      await expect(chip(page, "Alpha")).toHaveAttribute("aria-label", "Level 1");
      await chip(page, "Beta").click();
      await menu.getByRole("menuitemradio", { name: "Level 2", exact: true }).click();
      await expect(chip(page, "Beta")).toHaveText("2");
      expect(await relevanceRows()).toEqual(sorted([{ userId: pmId, competitorId: company.Alpha, level: 1 }, { userId: pmId, competitorId: company.Beta, level: 2 }]));
    });

    await test.step("it stays after a reload", async () => {
      await openMatrix(page);
      await expect(chip(page, "Alpha")).toHaveText("1");
      await expect(chip(page, "Beta")).toHaveText("2");
      await expect(chip(page, "Gamma")).toHaveText("");
    });

    const other = await open(browser, "pm2");
    await test.step("a second user of the same organization sees no level, and sets their own", async () => {
      await openMatrix(other);
      // The same table…
      expect(await marksOf(capRow(other, "Roadmap"))).toEqual(["4", "5", "3", "4", "2", "1", "0"]);
      // …with none of the PM's levels.
      for (const c of COMPANIES.slice(0, 6)) await expect(chip(other, c)).toHaveAttribute("aria-label", "Set level");
      await chip(other, "Alpha").click();
      await other.getByTestId("cmp-relevance-menu").getByRole("menuitemradio", { name: "Level 3 — least relevant" }).click();
      await expect(chip(other, "Alpha")).toHaveText("3");
      expect(await relevanceRows()).toEqual(sorted([
        { userId: pmId, competitorId: company.Alpha, level: 1 }, { userId: pmId, competitorId: company.Beta, level: 2 }, { userId: pm2Id, competitorId: company.Alpha, level: 3 },
      ]));
      // The PM still has their own.
      await openMatrix(page);
      await expect(chip(page, "Alpha")).toHaveText("1");
    });

    await test.step("choosing the current level clears it — for this user only", async () => {
      await chip(page, "Alpha").click();
      const current = page.getByTestId("cmp-relevance-menu").getByRole("menuitemradio", { name: "Level 1 — click to clear" });
      await expect(current).toHaveAttribute("aria-checked", "true");
      await current.click();
      await expect(chip(page, "Alpha")).toHaveAttribute("aria-label", "Set level");
      await expect(chip(page, "Alpha")).toHaveText("");
      expect(await relevanceRows()).toEqual(sorted([{ userId: pmId, competitorId: company.Beta, level: 2 }, { userId: pm2Id, competitorId: company.Alpha, level: 3 }]));
      await openMatrix(other);
      await expect(chip(other, "Alpha")).toHaveText("3");
    });

    await test.step("the route takes 1, 2, 3 or null and nothing else", async () => {
      const bad = await pmApi.patch(`/api/competitors/${company.Gamma}/relevance`, { data: { level: 4 } });
      expect(bad.status()).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("The level is 1, 2 or 3.");
      expect(await withTestDb((db) => db.competitorRelevance.count({ where: { competitorId: company.Gamma } }))).toBe(0);
    });
  });

  test("CM-04 Settings → Competitors: a capability is a short row that opens downward with name, domain, what it covers, the PMOS AI text and the product lines as one dropdown, with no 'Own product'; a changed PMOS AI text, domain and product line are saved and are there after a reload; a domain's card says a text once when the PMOS AI definition is the same, its edit form has three sections and 'Who does the work'; an undecided address search tells the customer nothing [knobs: seeded rows]", async ({ browser }) => {
    const page = await open(browser, "pm");
    const AI_TEXT = "QA-CM: count public roadmaps and release plans. Leave out internal sprint boards.";
    const openSettings = async () => {
      await page.goto("/settings/competitors");
      await hydrated(page.getByTestId("cmp-section-capabilities"));
    };
    const capabilities = page.getByTestId("cmp-capabilities");
    const capItem = (name: string) => capabilities.getByTestId("cmp-capability").filter({ has: page.getByRole("button", { name: `${name}: open or close its details`, exact: true }) });
    await openSettings();

    await test.step("an undecided search for a company's other addresses is not told to the customer", async () => {
      const alpha = page.locator(`[data-testid="cmp-competitor"][data-name="${companyName("Alpha")}"]`);
      await expect(alpha).toBeVisible();
      await expect(alpha.getByTestId("cmp-address-search")).toHaveCount(0);
      await expect(page.getByTestId("cmp-competitors")).not.toContainText(/could not tell/i);
      await expect(page.locator("body")).not.toContainText("PMOS AI could not tell which of the addresses");
    });

    await test.step("Capabilities opens to short rows: name and domain on one line, nothing else until a row is clicked", async () => {
      await expect(page.getByTestId("cmp-section-capabilities")).toHaveAttribute("aria-expanded", "false");
      await expect(capabilities.getByTestId("cmp-capability")).toHaveCount(0);
      await page.getByTestId("cmp-section-capabilities").click();
      await expect(capabilities.getByTestId("cmp-capability")).toHaveCount(6);
      await expect(capabilities.getByTestId("cmp-capability-form")).toHaveCount(0);
      const row = capItem("Roadmap").getByTestId("cmp-capability-row");
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await expect(row).toContainText("Roadmap");
      await expect(row).toContainText("Planning");
      await expect(capItem("Roadmap")).not.toContainText("QA-CM: what Roadmap covers.");
    });

    const form = capItem("Roadmap").getByTestId("cmp-capability-form");
    await test.step("a click opens the row downward: the five fields, each with its label; no 'Own product'", async () => {
      await capItem("Roadmap").getByTestId("cmp-capability-row").click();
      await expect(form).toBeVisible();
      await expect(capabilities.getByTestId("cmp-capability-form")).toHaveCount(1);
      // Downward: the opened part starts under the row's line.
      const line = (await capItem("Roadmap").getByTestId("cmp-capability-row").boundingBox())!;
      expect((await form.boundingBox())!.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
      await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Roadmap");
      await expect(form.getByTestId("cmp-capability-domain").locator("option:checked")).toHaveText("Planning");
      await expect(form.getByTestId("cmp-capability-covers")).toHaveValue("QA-CM: what Roadmap covers.");
      for (const label of ["Name", "Domain", "What it covers", "PMOS AI text", "Product lines"]) await expect(form.getByText(label, { exact: true }).first()).toBeVisible();
      // No text of its own yet: PMOS AI uses what it covers.
      await expect(form.getByTestId("cmp-capability-same")).toBeChecked();
      await expect(form.getByTestId("cmp-capability-ai-text")).toHaveCount(0);
      // The product lines are one dropdown, not a row of chips.
      await expect(form.getByRole("button", { name: /^Product lines/ })).toHaveCount(1);
      await expect(form).not.toContainText("QA-CM Line One");
      await expect(form).not.toContainText(/own product/i);
      await expect(page.getByTestId("cmp-capabilities")).not.toContainText(/own product/i);
    });

    await test.step("change the PMOS AI text, the domain and a product line; Save sends only what changed", async () => {
      await form.getByTestId("cmp-capability-same").uncheck();
      await form.getByTestId("cmp-capability-ai-text").fill(AI_TEXT);
      await form.getByTestId("cmp-capability-domain").selectOption({ label: "Reporting" });
      await form.getByRole("button", { name: /^Product lines/ }).click();
      await page.getByRole("button", { name: "QA-CM Line Two", exact: true }).click();
      await page.keyboard.press("Escape");
      const saved = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith(`/api/competitors/capabilities/${cap.Roadmap}`));
      await form.getByRole("button", { name: "Save", exact: true }).click();
      expect((await saved).postDataJSON()).toEqual({ domainId: dom.Reporting, aiDefinition: AI_TEXT, productLines: ["QA-CM Line Two"] });
      // The row closes and now sits under Reporting.
      await expect(capabilities.getByTestId("cmp-capability-form")).toHaveCount(0);
      await expect(capItem("Roadmap").getByTestId("cmp-capability-row")).toContainText("Reporting");
      const k = await capabilityRow("Roadmap");
      expect({ domainId: k.domainId, aiDefinition: k.aiDefinition, productLines: k.productLines, description: k.description, name: k.name }).toEqual({ domainId: dom.Reporting, aiDefinition: AI_TEXT, productLines: ["QA-CM Line Two"], description: "QA-CM: what Roadmap covers.", name: "Roadmap" });
    });

    await test.step("after a reload the row shows what was saved", async () => {
      await openSettings();
      await page.getByTestId("cmp-section-capabilities").click();
      await capItem("Roadmap").getByTestId("cmp-capability-row").click();
      await expect(form.getByTestId("cmp-capability-domain").locator("option:checked")).toHaveText("Reporting");
      await expect(form.getByTestId("cmp-capability-same")).not.toBeChecked();
      await expect(form.getByTestId("cmp-capability-ai-text")).toHaveValue(AI_TEXT);
      await expect(form.getByTestId("cmp-capability-covers")).toHaveValue("QA-CM: what Roadmap covers.");
      // One line is ticked in the dropdown: its count shows on the button.
      await expect(form.getByRole("button", { name: /^Product lines/ })).toContainText("1");
      // The table follows: Roadmap is now a row of Reporting.
      await page.goto("/competitors");
      await hydrated(page.getByTestId("cmp-domains-toggle-all"));
      await page.getByTestId("cmp-domains-toggle-all").click();
      expect(await shownCapabilities(page)).toEqual(["Prioritization scoring", "Release notes hub", "Feedback inbox", "Customer portal", "Roadmap", "Dashboards"]);
    });

    await test.step("Domains: a card says a text once when the PMOS AI definition is the same; the edit form has three sections and 'Who does the work'", async () => {
      await openSettings();
      await page.getByTestId("cmp-section-domains").click();
      const domains = page.getByTestId("cmp-domains");
      const card = (name: string) => domains.locator("div.rounded-xl.px-5.py-4", { has: page.locator("span.font-title", { hasText: new RegExp(`^${name}$`) }) });
      // Planning: the definition is the same text as what it covers — shown once, with a line that says so.
      await expect(card("Planning").getByTestId("cmp-domain-covers")).toHaveText(SAME_TEXT);
      await expect(card("Planning").getByText(SAME_TEXT, { exact: true })).toHaveCount(1);
      await expect(card("Planning").getByTestId("cmp-domain-same-note")).toHaveText("PMOS AI uses the same text as its definition.");
      await expect(card("Planning").getByText("PMOS AI definition", { exact: true })).toHaveCount(0);
      // Feedback: two different texts — both shown, and who does the work.
      await expect(card("Feedback").getByTestId("cmp-domain-covers")).toHaveText(DOMAIN_TEXTS.Feedback.summary);
      await expect(card("Feedback")).toContainText(DOMAIN_TEXTS.Feedback.description);
      await expect(card("Feedback").getByTestId("cmp-domain-same-note")).toHaveCount(0);
      await expect(card("Feedback").getByTestId("cmp-domain-card-done-by")).toHaveText(DOMAIN_TEXTS.Feedback.doneBy);
      // The edit form: 1. the name; 2. the info section (what it covers, who does the work); 3. the PMOS AI definition.
      await card("Feedback").getByRole("button", { name: "Edit" }).click();
      const editor = domains.locator("div.rounded-xl.px-5.py-4", { has: page.getByTestId("cmp-domain-name") });
      await expect(editor.getByTestId("cmp-domain-name")).toHaveValue("Feedback");
      await expect(editor.locator("fieldset")).toHaveCount(2);
      await expect(editor.getByRole("group", { name: "Info section" })).toBeVisible();
      await expect(editor.getByRole("group", { name: "PMOS AI definition" })).toBeVisible();
      await expect(editor.getByRole("group", { name: "Info section" }).getByLabel("What it covers")).toHaveValue(DOMAIN_TEXTS.Feedback.summary);
      await expect(editor.getByRole("group", { name: "Info section" }).getByLabel("Who does the work")).toHaveValue(DOMAIN_TEXTS.Feedback.doneBy);
      await expect(editor.getByTestId("cmp-domain-same")).not.toBeChecked();
      await page.keyboard.press("Escape");
      await expect(domains.getByTestId("cmp-domain-name")).toHaveCount(0);
    });
  });
  test("CM-05 a company's column is dragged to a new place: the columns and their cells move at once, the order is saved for the organization, and a second user sees it after a reload [knobs: seeded rows]", async ({ browser }) => {
    const page = await open(browser, "pm");
    await openMatrix(page);
    const names = (list: readonly Company[]) => list.map(companyName);
    expect(await shownCompanies(page)).toEqual(names(COMPANIES.slice(0, 6)));
    const from = companyColumn(page, "Gamma");
    const onto = companyColumn(page, "Alpha");
    await expect(from).toHaveAttribute("title", "Drag to change the order of the companies");

    // HTML5 drag and drop with the real mouse: each step waits for what the PM sees — the dragged column fades, the
    // marker shows where it will land, then the drop.
    const f = (await from.boundingBox())!;
    const t = (await onto.boundingBox())!;
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith("/api/competitors/order"));
    await page.mouse.move(f.x + f.width / 2, f.y + f.height - 14);
    await page.mouse.down();
    await page.mouse.move(f.x + f.width / 2 - 12, f.y + f.height - 14, { steps: 4 });
    await expect(from).toHaveClass(/opacity-40/);
    // Onto the left half of Alpha's column: Gamma lands before Alpha.
    await page.mouse.move(t.x + t.width / 4, t.y + t.height - 14, { steps: 10 });
    await page.mouse.move(t.x + t.width / 4 - 2, t.y + t.height - 16, { steps: 2 });
    await expect(page.getByTestId("cmp-column-drop-marker")).toBeVisible();
    await page.mouse.up();

    const order = ["Gamma", "Alpha", "Beta", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"] as const;
    const res = await saved;
    expect(res.status(), await res.text()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ ids: order.map((c) => company[c]) });
    await expect(page.getByTestId("cmp-column-drop-marker")).toHaveCount(0);
    expect(await shownCompanies(page)).toEqual(names(order.slice(0, 6)));
    // The cells went with their column: the organization, then Gamma, Alpha, Beta, Delta, Echo, Foxtrot.
    expect(await marksOf(capRow(page, "Roadmap"))).toEqual(["4", "4", "5", "3", "2", "1", "0"]);
    const stored = await withTestDb((db) => db.competitor.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { position: "asc" }, select: { name: true, position: true } }));
    expect(stored).toEqual(order.map((c, position) => ({ name: companyName(c), position })));
    const [event] = await withTestDb((db) => db.usageEvent.findMany({ where: { workspaceId, event: "cmp_columns_reordered" }, select: { userId: true, props: true } }));
    expect(event).toEqual({ userId: pmId, props: { companies: 8 } });

    // The order is the organization's: a second user sees it, in the table and in the Settings list.
    const other = await open(browser, "pm2");
    await openMatrix(other);
    expect(await shownCompanies(other)).toEqual(names(order.slice(0, 6)));
    await other.goto("/settings/competitors");
    await expect(other.getByTestId("cmp-competitor").first()).toBeVisible();
    expect(await other.getByTestId("cmp-competitor").evaluateAll((els) => els.map((el) => el.getAttribute("data-name")))).toEqual(names(order));

    // A list that is not exactly the organization's companies is refused, and nothing moves.
    const bad = await pmApi.patch("/api/competitors/order", { data: { ids: order.slice(0, 7).map((c) => company[c]) } });
    expect(bad.status()).toBe(409);
    expect((await withTestDb((db) => db.competitor.findMany({ where: { workspaceId }, orderBy: { position: "asc" }, select: { name: true } }))).map((c) => c.name)).toEqual(names(order));
  });
});
