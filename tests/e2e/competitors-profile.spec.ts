import { expect, test, type Page } from "@playwright/test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import { hashPasswordLikeApp, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { RESOLVED_ENV } from "./test-env";

/**
 * Competitors — story 4, the competitor profile (feature/competitors_mvp,
 * inventory P-01 … P-07). Everything the profile shows comes from rows this
 * spec seeds itself (own org + workspace, two competitors, catalog, statuses,
 * profile/events/products/insight/signals/people/media) — no scan, no PMOS AI
 * call, no "demo data" anywhere.
 *
 * P-01 full rows: identity line, tags, risk ring, fact cards, timeline incl.
 *      a projected event, products with their capabilities, deep-dive summary,
 *      signals in "What changed", people, gallery captures, sources card.
 * P-02 scan rows only (statuses + facts, none of the story-4 tables): header,
 *      website facts and statuses render; empty sections show their
 *      "arrives with…" copy; no error boundary.
 * P-03 timeline type filter narrows the events, All restores; UsageEvent
 *      cmp_profile_timeline_filtered {competitorId, type}.
 * P-04 capability deep dive: one open at a time; UsageEvent
 *      cmp_capability_dive_opened {capabilityId, value, hasInsight}.
 * P-05 Flag as wrong from the profile: CapabilityStatus.overrideValue +
 *      overrideNote "Flagged from the profile", the matrix cell shows the
 *      corrected mark, UsageEvent cmp_status_overridden surface "profile".
 * P-06 /api/competitors/media: a png from COMPETITORS_MEDIA_DIR → 200
 *      image/png; `..` traversal, absolute path, unknown extension, missing
 *      file → 404; signed-out → 404 (competitorsGuard runs the org flag
 *      before auth and an anonymous caller sees the env default, which is
 *      off in the test env — same shape as XC-02's "404 where the gate runs
 *      before auth"); feature off for the org → 404 and back to 200 when on.
 *      Limit: needs COMPETITORS_MEDIA_DIR in test-apphosting.yaml (any
 *      writable path — the spec creates the dir and its files); unset = the
 *      whole case is skipped with that reason, never a vacuous 404 sweep.
 * P-07 RBAC: a plain USER and a CUSTOMER_ADMIN of the same org see the same
 *      profile (same identity, tags, rows, stances, Flag as wrong).
 *
 * Client usage events flush every 5 s (lib/analytics/track.ts) — DB
 * assertions on them poll up to 15 s. Fixtures are recreated in beforeAll
 * and removed in afterAll (users first, then the org — cascades take the
 * rest); rerunnable without reseed, never touches other orgs.
 */

const ORG = { orgName: "QA-CMP Org", slug: "qa-cmp-org" };
const USER: TotpCreds & { name: string } = {
  name: "QA CMP User",
  email: "qa+cmp-user@pm-os.io",
  password: "Cmp-user-qa-pass1",
  totpSecret: "QACMPUSERQACMPUSERQACMPUSERQACMP", // synthetic, test-only
};
const ADMIN: TotpCreds & { name: string } = {
  name: "QA CMP Admin",
  email: "qa+cmp-admin@pm-os.io",
  password: "Cmp-admin-qa-pass1",
  totpSecret: "QACMPADMNQACMPADMNQACMPADMNQACMP", // synthetic, test-only
};

const ALPHA = { name: "QA-CMP Alpha", host: "qa-cmp-alpha.example" };
const BETA = { name: "QA-CMP Beta", host: "qa-cmp-beta.example" };
const DOMAIN = "QA-CMP Threat Intel";
const CAP = {
  darkWeb: "QA-CMP Dark web monitoring", // ours missing; Alpha has (+ insight), Beta partial
  brand: "QA-CMP Brand protection", // ours has; Alpha has, Beta missing
  vuln: "QA-CMP Vulnerability intel", // ours partial; Alpha partial (flagged in P-05), Beta unknown
};
const PRODUCT = { core: "QA-CMP Alpha Core", edge: "QA-CMP Alpha Edge" };
const INSIGHT_SUMMARY = "Alpha watches criminal forums and paste sites for leaked credentials.";
const FLAG_NOTE = "Flagged from the profile";
const MEDIA_SUBDIR = "qa-cmp";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const MEDIA_DIR = RESOLVED_ENV.COMPETITORS_MEDIA_DIR?.trim() || null;
const OUTSIDE_PNG = "qa-cmp-outside.png";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

let workspaceId: string;
let orgId: string;
let userId: string;
let alphaId: string;
let betaId: string;
let capIds: Record<keyof typeof CAP, string>;
let alphaVulnStatusId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.user.deleteMany({ where: { OR: [{ email: { startsWith: "qa+cmp-" } }, { organization: { slug: ORG.slug } }] } });
  await db.organization.deleteMany({ where: { slug: ORG.slug } });
}

async function seedFixtures(db: PrismaClient): Promise<void> {
  const seeded = await seedQaOrgWithUser(db, { ...ORG, features: { competitors: true }, user: USER });
  orgId = seeded.orgId;
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY;
  await db.user.create({
    data: {
      email: ADMIN.email,
      name: ADMIN.name,
      passwordHash: hashPasswordLikeApp(ADMIN.password),
      organizationId: orgId,
      role: "CUSTOMER_ADMIN",
      totpSecretEnc: encryptTotpSecret(ADMIN.totpSecret),
      totpEnabledAt: new Date(),
      totpLastUsedStep: null,
    },
  });

  const domain = await db.competitorDomain.create({ data: { workspaceId, name: DOMAIN, description: "QA-CMP fixture domain", color: "teal", position: 0 } });
  const mkCap = (name: string, ourStatus: string, position: number) =>
    db.capability.create({ data: { workspaceId, domainId: domain.id, name, description: "QA-CMP fixture capability", ourStatus, position } });
  const darkWeb = await mkCap(CAP.darkWeb, "missing", 0);
  const brand = await mkCap(CAP.brand, "has", 1);
  const vuln = await mkCap(CAP.vuln, "partial", 2);
  capIds = { darkWeb: darkWeb.id, brand: brand.id, vuln: vuln.id };

  // Alpha — every story-4 table filled.
  const alpha = await db.competitor.create({
    data: {
      workspaceId, name: ALPHA.name, websiteUrl: `https://${ALPHA.host}`, host: ALPHA.host, position: 0,
      sources: { create: { workspaceId, type: "website", url: `https://${ALPHA.host}` } },
      profile: {
        create: {
          ownership: "Private", hq: "Boston, MA", foundedYear: 2015, headcount: "1,200",
          tags: [{ label: "Enterprise", kind: "pos" }, { label: "Channel-led", kind: "gtm" }, { label: "MSSP", kind: "int" }],
          riskScore: 72, riskLevel: "high", riskNote: "Overlaps on 2 of 3 capabilities",
          sourcesSummary: [{ label: "Website", n: 12 }, { label: "LinkedIn", n: 3 }],
          lastFullScanAt: hoursAgo(3),
        },
      },
      events: {
        create: [
          { workspaceId, date: new Date("2015-06-01"), title: "QA-CMP Alpha founded", type: "company" },
          { workspaceId, date: new Date("2019-03-01"), title: "Series B $40M", type: "funding", sourceLabel: "Press" },
          { workspaceId, date: new Date("2023-09-01"), title: "Launched dark web alerts", type: "capability" },
          { workspaceId, date: new Date("2026-03-01"), title: "New CRO", type: "hr" },
          { workspaceId, date: new Date("2027-06-01"), title: "Enters exposure management", type: "domain", projected: true, confidence: 0.7 },
        ],
      },
      products: {
        create: [
          { workspaceId, code: "AC", name: PRODUCT.core, since: "2019", tier: "Enterprise", position: 0 },
          { workspaceId, code: "AE", name: PRODUCT.edge, since: "2024", position: 1 },
        ],
      },
      people: {
        create: {
          windowLabel: "LinkedIn · last 90 days",
          hires: [{ team: "Sales", n: 12 }, { team: "R&D", n: 5 }],
          leftCount: 3,
          leadership: "New CRO joined from QA-CMP Rival",
        },
      },
      media: {
        create: [
          { workspaceId, label: "QA-CMP Alpha dashboard", kind: "Screenshot", mediaPath: `${MEDIA_SUBDIR}/alerts.png`, sourceLabel: "Trial", capturedAt: daysAgo(3), position: 0 },
          { workspaceId, label: "QA-CMP Alpha onboarding", kind: "Clip", mediaPath: `${MEDIA_SUBDIR}/onboarding.png`, sourceLabel: "Help center", capturedAt: daysAgo(2), position: 1 },
        ],
      },
      signals: {
        create: [
          { workspaceId, kind: "funding", title: "QA-CMP Alpha raised a Series C", source: "Press", impact: "high", at: daysAgo(2) },
          { workspaceId, kind: "hiring", title: "QA-CMP Alpha opened 12 sales roles", source: "LinkedIn", impact: "medium", at: daysAgo(5) },
        ],
      },
      facts: {
        create: [
          { workspaceId, kind: "tagline", value: "Intelligence you can act on", sourceLabel: "Website" },
          { workspaceId, kind: "funding", value: "$140M total", sourceLabel: "Crunchbase" },
          { workspaceId, kind: "headcount", value: "1,200 on LinkedIn", sourceLabel: "LinkedIn" },
          { workspaceId, kind: "hiring", value: "+17 roles", sourceLabel: "LinkedIn · 30 days", tone: "warn" },
          { workspaceId, kind: "vertical", value: "Finance" },
          { workspaceId, kind: "vertical", value: "Healthcare" },
          { workspaceId, kind: "integration", value: "Splunk" },
        ],
      },
    },
    include: { products: true },
  });
  alphaId = alpha.id;
  const core = alpha.products.find((p) => p.name === PRODUCT.core)!;
  const edge = alpha.products.find((p) => p.name === PRODUCT.edge)!;
  await db.capabilityStatus.create({
    data: {
      workspaceId, competitorId: alpha.id, capabilityId: darkWeb.id, value: "has", confidence: 0.9, productId: core.id,
      quote: "Monitor criminal forums for your credentials.", sourceUrl: `https://${ALPHA.host}/dark-web`, changedAt: daysAgo(7),
      insight: {
        create: {
          summary: INSIGHT_SUMMARY, summarySource: "summary by PMOS",
          sources: [{ label: "Help center", tone: "int" }, { label: "Trial", tone: "pos" }],
          scope: "Forums, markets, paste sites", packaging: "Add-on", confidenceNote: "High — 3 sources",
          media: [{ label: "Alerts screen", kind: "Screenshot", caption: "Alert list", mediaPath: `${MEDIA_SUBDIR}/alerts.png` }],
          evidence: [{ kind: "Docs", kindTone: "int", text: "Help article on alert routing", date: "Mar 2026" }],
          riskLevel: "high", riskText: "Alpha sells this as an add-on to every enterprise deal.",
          differentiation: "QA-CMP Org ties alerts to tickets; Alpha stops at the alert.",
          ideaTitle: "Dark web alerts", evidenceCount: 3,
        },
      },
    },
  });
  await db.capabilityStatus.create({ data: { workspaceId, competitorId: alpha.id, capabilityId: brand.id, value: "has", confidence: 0.8, productId: edge.id, quote: "Takedowns within 24 hours.", changedAt: daysAgo(40) } });
  const vulnStatus = await db.capabilityStatus.create({ data: { workspaceId, competitorId: alpha.id, capabilityId: vuln.id, value: "partial", confidence: 0.7, quote: "CVE enrichment in beta." } });
  alphaVulnStatusId = vulnStatus.id;

  // Beta — a scanned competitor only: statuses + facts, none of the story-4 tables.
  const beta = await db.competitor.create({
    data: {
      workspaceId, name: BETA.name, websiteUrl: `https://${BETA.host}`, host: BETA.host, position: 1,
      sources: { create: { workspaceId, type: "website", url: `https://${BETA.host}` } },
      statuses: {
        create: [
          { workspaceId, capabilityId: darkWeb.id, value: "partial", confidence: 0.6, quote: "Paste-site monitoring (beta).", sourceUrl: `https://${BETA.host}/platform` },
          { workspaceId, capabilityId: brand.id, value: "missing", confidence: 0.9 },
          { workspaceId, capabilityId: vuln.id, value: "unknown" },
        ],
      },
      facts: {
        create: [
          { workspaceId, kind: "tagline", value: "Threat intel for everyone" },
          { workspaceId, kind: "vertical", value: "Finance" },
          { workspaceId, kind: "vertical", value: "Retail" },
          { workspaceId, kind: "integration", value: "Splunk" },
          { workspaceId, kind: "customer", value: "QA-CMP Bank" },
        ],
      },
    },
  });
  betaId = beta.id;
}

/** Playwright rows of UsageEvent for this workspace and event, newest first. */
async function usageEvents(event: string): Promise<{ props: Prisma.JsonValue; userId: string | null }[]> {
  return withTestDb((db) => db.usageEvent.findMany({ where: { workspaceId, event }, orderBy: { createdAt: "desc" }, select: { props: true, userId: true } }));
}
const propsOf = (row: { props: Prisma.JsonValue }) => (row.props ?? {}) as Record<string, unknown>;

async function openProfiles(page: Page, competitorName: string): Promise<void> {
  await page.goto("/competitors");
  await expect(page.getByRole("heading", { level: 1, name: "Competitors" })).toBeVisible();
  await page.getByRole("tab", { name: "Profiles" }).click();
  // The chip's accessible name is "<initials> <name>" (the logo span carries the initials).
  const chips = page.getByRole("group", { name: "Choose a competitor" });
  const chip = chips.getByRole("button", { name: new RegExp(`${competitorName}$`) });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: competitorName })).toBeVisible();
}

/** The capability row button in the profile (its accessible name starts with the capability name). */
const capRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });
const detailsAside = (page: Page) => page.getByRole("complementary", { name: "Profile details" });
const sideCard = (page: Page, title: string | RegExp) => detailsAside(page).locator("section", { hasText: title });

async function expectNoCrash(page: Page): Promise<void> {
  await expect(page.getByText("Application error: a client-side exception has occurred")).toHaveCount(0);
  await expect(page.getByText("This page could not be found")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/demo data/i);
}

test.describe("Competitor profile (P-01 … P-07)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await seedFixtures(db);
    });
    if (MEDIA_DIR) {
      mkdirSync(join(MEDIA_DIR, MEDIA_SUBDIR), { recursive: true });
      writeFileSync(join(MEDIA_DIR, MEDIA_SUBDIR, "alerts.png"), PNG_1X1);
      writeFileSync(join(MEDIA_DIR, MEDIA_SUBDIR, "onboarding.png"), PNG_1X1);
      writeFileSync(join(MEDIA_DIR, MEDIA_SUBDIR, "notes.txt"), "not an image");
      // A real image OUTSIDE the store — the traversal probes aim at this one.
      writeFileSync(join(MEDIA_DIR, "..", OUTSIDE_PNG), PNG_1X1);
    }
  });

  test.afterAll(async () => {
    await withTestDb(deleteFixtures);
    if (MEDIA_DIR && existsSync(join(MEDIA_DIR, MEDIA_SUBDIR))) rmSync(join(MEDIA_DIR, MEDIA_SUBDIR), { recursive: true, force: true });
    if (MEDIA_DIR) rmSync(join(MEDIA_DIR, "..", OUTSIDE_PNG), { force: true });
  });

  test("P-01 profile with full rows renders every section from its tables", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);

    // Chip line, identity, tags, risk.
    await expect(page.getByText(/Full scan 3 h ago · 2 sources · 2 UI captures/)).toBeVisible();
    await expect(page.getByRole("link", { name: ALPHA.host })).toHaveAttribute("href", `https://${ALPHA.host}`);
    await expect(page.getByText("Private · Boston, MA · founded 2015 · 1,200 people", { exact: true })).toBeVisible();
    for (const tag of ["Enterprise", "Channel-led", "MSSP"]) await expect(page.getByText(tag, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("img", { name: "Risk 72 of 100" })).toBeVisible();
    await expect(page.getByText("High risk", { exact: true })).toBeVisible();
    await expect(page.getByText("Overlaps on 2 of 3 capabilities", { exact: true })).toBeVisible();

    // Fact cards: label, joined value, source line from the fact's own label.
    const card = (label: string) => page.locator("div", { has: page.getByText(label, { exact: true }) }).filter({ hasText: label }).last();
    await expect(card("Funding")).toContainText("$140M total");
    await expect(card("Funding")).toContainText("Crunchbase");
    await expect(card("Headcount")).toContainText("1,200 on LinkedIn");
    await expect(card("Hiring · 30 days")).toContainText("+17 roles");
    await expect(card("Verticals")).toContainText("Finance · Healthcare");
    await expect(card("Integrations")).toContainText("Splunk");

    // Timeline: all five events, the projected one marked as such.
    const timeline = page.getByRole("region", { name: "Company timeline" });
    await expect(timeline.getByText(/Founded 2015 → today → \d{4} projection/)).toBeVisible();
    await expect(timeline.getByRole("button", { name: "All · 5" })).toHaveAttribute("aria-pressed", "true");
    for (const title of ["QA-CMP Alpha founded", "Series B $40M", "Launched dark web alerts", "New CRO", "Enters exposure management"]) {
      await expect(timeline.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(timeline.getByText(/projected 70%/)).toBeVisible();
    // `has` is queried relative to the outer element — the inner locator must be page-rooted.
    await expect(timeline.locator("span", { has: page.getByText("Series B $40M", { exact: true }) })).toContainText("funding");

    // Capabilities by product: header counts, product groups, rows with their marks and stance.
    await expect(page.getByText("1 domains · 2 products · 3 capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText(/vs QA-CMP Org: ahead on 1 · level on 2 · behind on 0/)).toBeVisible();
    await expect(page.getByText(PRODUCT.core, { exact: true })).toBeVisible();
    await expect(page.getByText("product · since 2019 · 1 capability", { exact: true })).toBeVisible();
    await expect(page.getByText("Enterprise", { exact: true }).nth(1)).toBeVisible(); // tier, beside the tag of the same name
    await expect(page.getByText(PRODUCT.edge, { exact: true })).toBeVisible();
    await expect(page.getByText("No product", { exact: true })).toBeVisible(); // the orphan row group
    await expect(capRow(page, CAP.darkWeb)).toContainText("QA-CMP Org missing");
    await expect(capRow(page, CAP.darkWeb)).toContainText(/Changed /);
    await expect(capRow(page, CAP.brand)).toContainText("Level");
    await expect(capRow(page, CAP.vuln)).toContainText("Partial");
    await expect(capRow(page, CAP.vuln)).toContainText("No change");

    // Deep dive: the insight's summary, cards, evidence, risk text, idea.
    await capRow(page, CAP.darkWeb).click();
    await expect(page.getByText(INSIGHT_SUMMARY, { exact: true })).toBeVisible();
    await expect(page.getByText("summary by PMOS", { exact: true })).toBeVisible();
    await expect(page.getByText("Help center", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Forums, markets, paste sites", { exact: true })).toBeVisible();
    await expect(page.getByText("Add-on", { exact: true })).toBeVisible();
    await expect(page.getByText("High — 3 sources", { exact: true })).toBeVisible();
    await expect(page.getByText("UI & media · 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Evidence · 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Help article on alert routing", { exact: true })).toBeVisible();
    await expect(page.getByText("Risk to QA-CMP Org · high", { exact: true })).toBeVisible();
    await expect(page.getByText("Alpha sells this as an add-on to every enterprise deal.", { exact: true })).toBeVisible();
    await expect(page.getByText(/idea “Dark web alerts” · 3 pieces of evidence/)).toBeVisible();

    // Side column: signals, people, gallery, sources.
    const changed = sideCard(page, "What changed · 30 days");
    await expect(changed).toContainText("2 signals");
    await expect(changed).toContainText("QA-CMP Alpha raised a Series C");
    await expect(changed).toContainText(/Press · /);
    await expect(changed.getByText("High", { exact: true })).toBeVisible();
    await expect(changed).toContainText("QA-CMP Alpha opened 12 sales roles");
    const people = sideCard(page, "People");
    await expect(people).toContainText("LinkedIn · last 90 days");
    await expect(people).toContainText("Sales");
    await expect(people).toContainText("+12");
    await expect(people).toContainText("−3");
    await expect(people).toContainText("New CRO joined from QA-CMP Rival");
    const gallery = sideCard(page, "UI gallery");
    await expect(gallery).toContainText("2 captures");
    await expect(gallery.getByRole("img", { name: "QA-CMP Alpha dashboard" })).toBeVisible();
    await expect(gallery).toContainText("QA-CMP Alpha dashboard · Trial");
    await expect(gallery.getByRole("link", { name: /QA-CMP Alpha onboarding/ })).toHaveAttribute("href", `/api/competitors/media?p=${encodeURIComponent(`${MEDIA_SUBDIR}/onboarding.png`)}`);
    const sources = sideCard(page, "Sources");
    await expect(sources).toContainText("2 · last full scan 3 h ago");
    await expect(sources).toContainText("Website · 12");
    await expect(sources).toContainText("LinkedIn · 3");

    await expectNoCrash(page);
  });

  test("P-02 profile with scan rows only renders header, facts and statuses; empty sections say what arrives later", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, BETA.name);

    // The profile's own copy (C.profile.neverScanned) — capitalised, unlike the page header's.
    await expect(page.getByText(/Not scanned yet · 1 source · 0 UI captures/)).toBeVisible();
    await expect(page.getByRole("link", { name: BETA.host })).toBeVisible();
    await expect(page.getByText("“Threat intel for everyone”", { exact: true })).toBeVisible();
    // Fact cards: the website kinds always show; funding/headcount/hiring cards only with rows.
    const card = (label: string) => page.locator("div", { has: page.getByText(label, { exact: true }) }).filter({ hasText: label }).last();
    await expect(card("Verticals")).toContainText("Finance · Retail");
    await expect(card("Integrations")).toContainText("Splunk");
    await expect(card("Customers")).toContainText("QA-CMP Bank");
    await expect(card("Pricing")).toContainText("—");
    await expect(page.getByText("Funding", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Headcount", { exact: true })).toHaveCount(0);
    // The website facts list (story 2) still opens and lists them.
    await page.getByRole("button", { name: /From the website · 5/ }).click();
    await expect(page.getByText("Retail", { exact: true })).toBeVisible();
    await expect(page.getByText("QA-CMP Bank", { exact: true }).first()).toBeVisible();

    // Statuses render with their marks; no products → flat rows.
    await expect(page.getByText("1 domains · 0 products · 3 capabilities", { exact: true })).toBeVisible();
    await expect(capRow(page, CAP.darkWeb)).toContainText("Partial");
    await expect(capRow(page, CAP.darkWeb)).toContainText("QA-CMP Org missing");
    await expect(capRow(page, CAP.brand)).toContainText("QA-CMP Org ahead");
    await expect(capRow(page, CAP.vuln)).toContainText("No signal");
    await expect(page.getByText("No product", { exact: true })).toHaveCount(0);

    // Empty sections: their "arrives with…" copy, never a crash.
    const timeline = page.getByRole("region", { name: "Company timeline" });
    await expect(timeline).toContainText("No dated events yet — funding, hiring, domain entrances and website changes arrive with their sources (LinkedIn, press, Wayback).");
    await expect(sideCard(page, "People")).toContainText("LinkedIn · arrives with its story");
    await expect(sideCard(page, "UI gallery")).toContainText("arrives with the product-UI story");
    await expect(sideCard(page, "Sources")).toContainText("no scan yet");
    await capRow(page, CAP.darkWeb).click();
    await expect(page.getByText("from the competitor's website", { exact: true })).toBeVisible();
    await expect(page.getByText("“Paste-site monitoring (beta).”", { exact: true })).toBeVisible();
    await expect(page.getByText("arrives with the battle-cards story", { exact: true })).toBeVisible();
    await expect(page.getByText("Differentiation / risk vs QA-CMP Org", { exact: true })).toBeVisible();

    await expectNoCrash(page);
  });

  test("P-03 timeline type filter narrows the events, All restores, and the filter is recorded", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    const timeline = page.getByRole("region", { name: "Company timeline" });
    await expect(timeline.getByText("QA-CMP Alpha founded", { exact: true })).toBeVisible();

    await timeline.getByRole("button", { name: "Funding · 1" }).click();
    await expect(timeline.getByRole("button", { name: "Funding · 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(timeline.getByRole("button", { name: "All · 5" })).toHaveAttribute("aria-pressed", "false");
    await expect(timeline.getByText("Series B $40M", { exact: true })).toBeVisible();
    for (const hidden of ["QA-CMP Alpha founded", "Launched dark web alerts", "New CRO", "Enters exposure management"]) {
      await expect(timeline.getByText(hidden, { exact: true })).toHaveCount(0);
    }

    await timeline.getByRole("button", { name: "All · 5" }).click();
    await expect(timeline.getByRole("button", { name: "All · 5" })).toHaveAttribute("aria-pressed", "true");
    for (const title of ["QA-CMP Alpha founded", "Series B $40M", "Launched dark web alerts", "New CRO", "Enters exposure management"]) {
      await expect(timeline.getByText(title, { exact: true })).toBeVisible();
    }

    // The client queue flushes within 5 s — poll the table.
    await expect
      .poll(async () => (await usageEvents("cmp_profile_timeline_filtered")).map(propsOf), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([{ competitorId: alphaId, type: "funding" }, { competitorId: alphaId, type: "all" }]));
    expect((await usageEvents("cmp_profile_timeline_filtered")).every((r) => r.userId === userId)).toBe(true);
  });

  test("P-04 capability deep dive: one open at a time, and each opening is recorded", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    const dives = page.getByText("What it does", { exact: true });
    await expect(dives).toHaveCount(0);

    await capRow(page, CAP.darkWeb).click();
    await expect(dives).toHaveCount(1);
    await expect(page.getByText(INSIGHT_SUMMARY, { exact: true })).toBeVisible();

    // Opening a second capability closes the first.
    await capRow(page, CAP.brand).click();
    await expect(dives).toHaveCount(1);
    await expect(page.getByText(INSIGHT_SUMMARY, { exact: true })).toHaveCount(0);
    await expect(page.getByText("“Takedowns within 24 hours.”", { exact: true })).toBeVisible();

    // Clicking the open row again closes it.
    await capRow(page, CAP.brand).click();
    await expect(dives).toHaveCount(0);

    await expect
      .poll(async () => (await usageEvents("cmp_capability_dive_opened")).map(propsOf), { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining([
          { competitorId: alphaId, capabilityId: capIds.darkWeb, value: "has", hasInsight: true },
          { competitorId: alphaId, capabilityId: capIds.brand, value: "has", hasInsight: false },
        ]),
      );
  });

  test("P-05 Flag as wrong from the profile saves the override, marks the matrix cell, records surface profile", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    await expect(capRow(page, CAP.vuln)).toContainText("Partial");
    await expect(capRow(page, CAP.vuln)).toContainText("Level");

    await capRow(page, CAP.vuln).click();
    await page.getByRole("button", { name: "Flag as wrong" }).click();
    await expect(page.getByText("Set to", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Missing", exact: true }).click();

    // The row now shows the corrected value and the stance that follows from it.
    await expect(page.getByText("Set to", { exact: true })).toHaveCount(0);
    await expect(capRow(page, CAP.vuln)).toContainText("QA-CMP Org ahead");
    await expect(capRow(page, CAP.vuln)).not.toContainText("Partial");
    await expect(page.getByText(/Edited by QA CMP User, .* · scan said Partial/)).toBeVisible();

    const cell = await withTestDb((db) => db.capabilityStatus.findUniqueOrThrow({ where: { id: alphaVulnStatusId } }));
    expect(cell.overrideValue).toBe("missing");
    expect(cell.overrideNote).toBe(FLAG_NOTE);
    expect(cell.overrideUserId).toBe(userId);
    expect(cell.overrideAt).not.toBeNull();
    expect(cell.value, "the scanned value is kept under the override").toBe("partial");

    // Server-written event, no flush to wait for.
    const overrides = (await usageEvents("cmp_status_overridden")).map(propsOf);
    expect(overrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ competitorId: alphaId, capabilityId: capIds.vuln, from: "partial", to: "missing", hasNote: true, reset: false, surface: "profile" }),
      ]),
    );

    // The matrix shows the corrected mark with the edited flag.
    await page.getByRole("tab", { name: "Parity matrix" }).click();
    const row = page.locator("tbody tr", { hasText: CAP.vuln });
    const matrixCell = row.getByRole("button", { name: `${CAP.vuln}: Missing`, exact: true });
    await expect(matrixCell).toBeVisible();
    await expect(matrixCell.locator('[aria-label="edited"]')).toHaveCount(1);
    await expect(row.getByRole("button", { name: `${CAP.vuln}: Partial`, exact: true })).toHaveCount(0);
    // Beta's cell in the same row is untouched.
    await expect(row.getByRole("button", { name: `${CAP.vuln}: Unknown`, exact: true })).toBeVisible();
  });

  test("P-06 media route serves only files inside the store, to signed-in members of an org with the feature on", async ({ page, request }) => {
    test.skip(!MEDIA_DIR, "COMPETITORS_MEDIA_DIR is not set in test-apphosting.yaml — without a store every path 404s and the sweep would be vacuous");
    const url = (p: string) => `/api/competitors/media?p=${encodeURIComponent(p)}`;
    await loginWithTotp(page, USER);

    const ok = await page.request.get(url(`${MEDIA_SUBDIR}/alerts.png`));
    expect(ok.status(), await ok.text()).toBe(200);
    expect(ok.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await ok.body()).equals(PNG_1X1)).toBe(true);

    // Traversal probes aim at a real png one level above the store, by every
    // spelling: leading `..`, `..` after a real folder, backslashes, an
    // absolute path to it. Then: an in-store file with an unknown extension,
    // a missing file, and an empty path.
    // A leading `..` that would land back inside the store is refused too
    // (fixed 2026-10-27: mediaFilePath rejects any `..` outright).
    for (const bad of [
      `../${MEDIA_SUBDIR}/alerts.png`, `../${OUTSIDE_PNG}`, `../../${OUTSIDE_PNG}`, `${MEDIA_SUBDIR}/../../${OUTSIDE_PNG}`, `${MEDIA_SUBDIR}/..\\..\\${OUTSIDE_PNG}`,
      join(MEDIA_DIR!, "..", OUTSIDE_PNG), "/etc/hosts", join(MEDIA_DIR!, MEDIA_SUBDIR, "alerts.png"),
      `${MEDIA_SUBDIR}/notes.txt`, `${MEDIA_SUBDIR}/missing.png`, "",
    ]) {
      const res = await page.request.get(url(bad));
      expect(res.status(), `p=${JSON.stringify(bad)}`).toBe(404);
      expect(await res.json(), `p=${JSON.stringify(bad)}`).toEqual({ error: "Not found" });
    }

    // Signed out: the org gate runs before auth, an anonymous caller sees the env default (off here) → 404, no bytes.
    const anon = await request.get(url(`${MEDIA_SUBDIR}/alerts.png`));
    expect(anon.status()).toBe(404);
    expect(await anon.json()).toEqual({ error: "Not found" });

    // Feature off for the org: 404 with the same session; back on: 200 again.
    await withTestDb((db) => db.organization.update({ where: { id: orgId }, data: { features: { competitors: false } } }));
    try {
      const off = await page.request.get(url(`${MEDIA_SUBDIR}/alerts.png`));
      expect(off.status()).toBe(404);
      expect(await off.json()).toEqual({ error: "Not found" });
    } finally {
      await withTestDb((db) => db.organization.update({ where: { id: orgId }, data: { features: { competitors: true } } }));
    }
    expect((await page.request.get(url(`${MEDIA_SUBDIR}/alerts.png`))).status()).toBe(200);
  });

  test("P-07 RBAC: a plain member sees the same profile as the org admin", async ({ browser }) => {
    const snapshot = async (creds: TotpCreds) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await loginWithTotp(page, creds);
        await openProfiles(page, ALPHA.name);
        await capRow(page, CAP.darkWeb).click();
        await expect(page.getByText(INSIGHT_SUMMARY, { exact: true })).toBeVisible();
        const rows = page.getByRole("button", { name: /^QA-CMP (Dark web monitoring|Brand protection|Vulnerability intel)/ });
        await expect(rows).toHaveCount(3);
        return {
          identity: await page.getByText("Private · Boston, MA · founded 2015 · 1,200 people", { exact: true }).count(),
          risk: await page.getByRole("img", { name: "Risk 72 of 100" }).count(),
          tags: await Promise.all(["Enterprise", "Channel-led", "MSSP"].map((t) => page.getByText(t, { exact: true }).count())),
          rows: await rows.allInnerTexts(),
          products: [await page.getByText(PRODUCT.core, { exact: true }).count(), await page.getByText(PRODUCT.edge, { exact: true }).count()],
          flagAsWrong: await page.getByRole("button", { name: "Flag as wrong" }).count(),
          signals: (await sideCard(page, "What changed · 30 days").innerText()).replace(/\s+/g, " "),
          people: (await sideCard(page, "People").innerText()).replace(/\s+/g, " "),
          sources: (await sideCard(page, "Sources").innerText()).replace(/\s+/g, " "),
        };
      } finally {
        await context.close();
      }
    };
    const admin = await snapshot(ADMIN);
    const user = await snapshot(USER);
    expect(user).toEqual(admin);
    expect(admin.identity).toBe(1);
    expect(admin.risk).toBe(1);
    expect(admin.flagAsWrong).toBe(1);
    expect(admin.rows.join("\n")).toContain("QA-CMP Org missing");
  });
});
