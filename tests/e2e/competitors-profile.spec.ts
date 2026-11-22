import { expect, test, type Page } from "@playwright/test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptTotpSecret } from "../../src/lib/two-factor";
import { hashPasswordLikeApp, loginWithTotp, seedQaOrgWithUser, withTestDb, type TotpCreds } from "./helpers";
import { RESOLVED_ENV } from "./test-env";

/**
 * Competitors — story 4, the competitor profile (feature/competitors_mvp,
 * inventory P-01 … P-07). The profile reads ONLY what the scan pipeline
 * produces: Competitor → CompetitorSource → CompetitorScan, CapabilityStatus
 * (+ StatusHistory), ProfileFact, CompetitorMedia. This spec seeds exactly
 * those tables itself (own org + workspace, two competitors, one domain with
 * three capabilities) — no scan run, no PMOS AI call, no "demo data".
 *
 * P-01 Alpha, every table filled: chip line "Last scan 3 h ago · 2 sources ·
 *      2 UI captures", host link, identity line from the ownership/hq/
 *      founded/headcount facts plus the tagline, the matrix-derived risk ring
 *      (1 of 3 → 33 → Medium), fact cards with their source labels, the
 *      timeline from the three dated facts (Founded / funding / milestone with
 *      Company and Funding chips, the sourced one a link), capabilities grouped
 *      under the two products named by the statuses plus "No product named"
 *      for the orphan, row stance + "Changed <date>" / "No change", the deep
 *      dive (quote, source link, Product, Confidence, History · 1 "until",
 *      "Where <org> stands", disabled Attach to idea), the side column (What
 *      changed from a recent cell change + a recent fact, UI gallery with the
 *      two captures, Sources with "<type> · N pages" from each source's scan).
 * P-02 Beta, website scan only (statuses + undated facts, no media): tagline
 *      as identity, risk 1 of 2 → High, Funding/Headcount/Hiring cards absent
 *      while the website kinds show "—", flat rows (0 products, no "No product
 *      named"), the timeline's "No dated facts yet" copy, NO UI gallery
 *      section, "Nothing changed in the last 30 days.", Sources "Website · 6
 *      pages"; the facts list opens and lists the facts; no crash.
 * P-03 timeline type filter narrows to the funding fact, All restores;
 *      UsageEvent cmp_profile_timeline_filtered {competitorId, type}.
 * P-04 capability deep dive: one open at a time; UsageEvent
 *      cmp_capability_dive_opened {competitorId, capabilityId, value, hasHistory}.
 * P-05 Flag as wrong from the profile: CapabilityStatus.overrideValue +
 *      overrideNote "Flagged from the profile", the Corrected card, the matrix
 *      cell shows the corrected mark, UsageEvent cmp_status_overridden
 *      surface "profile". The override is reset at the end so the other cases
 *      do not depend on run order.
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
 *      profile (identity, risk, rows, products, side column, Flag as wrong).
 *
 * Values (since 66e394c, 2026-11-11): a cell is found / low / not_found, the
 * org's own column is found / not_found; there is no "partial" and no
 * "unknown" — a capability a competitor was never looked at for has no cell.
 * The seed and the assertions below were moved to those values on 2026-11-22
 * (they still wrote has / partial / missing / unknown, which the page cannot
 * render: every UI row was red from that commit on).
 *
 * Not covered here: the fact list's add/correct/reset/dismiss editing (no
 * spec covers it yet — flagged to Dana).
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
  darkWeb: "QA-CMP Dark web monitoring", // ours not found; Alpha found (changed 7 d ago, 1 history row), Beta low confidence
  brand: "QA-CMP Brand protection", // ours found; Alpha found (changed 40 d ago), Beta not found
  vuln: "QA-CMP Vulnerability intel", // ours found; Alpha low confidence (no product, flagged in P-05), Beta no cell
};
const PRODUCT = { core: "QA-CMP Alpha Core", edge: "QA-CMP Alpha Edge" };
const QUOTE = {
  darkWeb: "Monitor criminal forums for your credentials.",
  darkWebBefore: "Paste-site monitoring only.",
  brand: "Takedowns within 24 hours.",
  vuln: "CVE enrichment in beta.",
  betaDarkWeb: "Paste-site monitoring (beta).",
};
const FUNDING = "Series B $40M";
const MILESTONE = "Launched dark web alerts";
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
/** lib/competitors/time.ts shortDate — "Oct 20" this year, "Oct 20, 2025" otherwise. */
const shortDate = (d: Date) =>
  d.toLocaleDateString("en-US", d.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

let workspaceId: string;
let orgId: string;
let userId: string;
let alphaId: string;
let capIds: Record<keyof typeof CAP, string>;
let alphaVulnStatusId: string;
const DARKWEB_CHANGED = daysAgo(7);

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.user.deleteMany({ where: { OR: [{ email: { startsWith: "qa+cmp-" } }, { organization: { slug: ORG.slug } }] } });
  await db.organization.deleteMany({ where: { slug: ORG.slug } });
}

/** A source with one finished scan, the way the pipeline leaves them. */
function scannedSource(type: string, url: string, lastScanAt: Date, pagesFetched: number, trigger: string): Prisma.CompetitorSourceCreateWithoutCompetitorInput {
  return {
    workspaceId, type, url, lastScanAt, lastStatus: "ok",
    scans: {
      create: {
        workspaceId, trigger, status: "ok", fetchMode: trigger === "import" ? "bundle" : "plain", badge: "full",
        startedAt: new Date(lastScanAt.getTime() - 90_000), finishedAt: lastScanAt, heartbeatAt: lastScanAt,
        pagesFetched, pagesChanged: pagesFetched, statusesChanged: 3, factsChanged: 5, aiCalls: 2, errorKind: "none",
      },
    },
  };
}

async function seedFixtures(db: PrismaClient): Promise<void> {
  const seeded = await seedQaOrgWithUser(db, { ...ORG, features: { competitors: true, competitorsProfiles: true }, user: USER });
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
  const darkWeb = await mkCap(CAP.darkWeb, "not_found", 0);
  const brand = await mkCap(CAP.brand, "found", 1);
  const vuln = await mkCap(CAP.vuln, "found", 2);
  capIds = { darkWeb: darkWeb.id, brand: brand.id, vuln: vuln.id };

  // Alpha — two scanned sources, statuses with products and history, facts incl. dated ones, two captures.
  const old = daysAgo(60); // facts the scans found long ago — outside "What changed · 30 days"
  const alpha = await db.competitor.create({
    data: {
      workspaceId, name: ALPHA.name, websiteUrl: `https://${ALPHA.host}`, host: ALPHA.host, position: 0,
      sources: {
        create: [
          scannedSource("website", `https://${ALPHA.host}`, hoursAgo(3), 12, "scheduled"),
          scannedSource("helpcenter", `https://help.${ALPHA.host}`, hoursAgo(6), 4, "import"),
        ],
      },
      facts: {
        create: [
          { workspaceId, kind: "tagline", value: "Intelligence you can act on", sourceLabel: "Website", sourceUrl: `https://${ALPHA.host}/`, changedAt: old },
          { workspaceId, kind: "ownership", value: "Private", sourceLabel: "About page", changedAt: old },
          { workspaceId, kind: "hq", value: "Boston, MA", sourceLabel: "About page", changedAt: old },
          { workspaceId, kind: "founded", value: "2015", sourceLabel: "About page", factDate: new Date("2015-06-01T00:00:00Z"), changedAt: old },
          { workspaceId, kind: "headcount", value: "1,200", sourceLabel: "Jobs page", changedAt: old },
          // The one recent fact: a dated funding round found 2 days ago, with its press page.
          { workspaceId, kind: "funding", value: FUNDING, sourceLabel: "Press", sourceUrl: `https://${ALPHA.host}/press/series-b`, factDate: new Date("2019-03-01T00:00:00Z"), changedAt: daysAgo(2) },
          { workspaceId, kind: "hiring", value: "+17 roles", sourceLabel: "Jobs page", tone: "warn", changedAt: old },
          { workspaceId, kind: "milestone", value: MILESTONE, sourceLabel: "Press", factDate: new Date("2023-09-01T00:00:00Z"), changedAt: old },
          { workspaceId, kind: "vertical", value: "Finance", changedAt: old },
          { workspaceId, kind: "vertical", value: "Healthcare", changedAt: old },
          { workspaceId, kind: "integration", value: "Splunk", sourceLabel: "Integrations page", changedAt: old },
          { workspaceId, kind: "certification", value: "SOC 2", sourceLabel: "Trust page", changedAt: old },
          { workspaceId, kind: "customer", value: "QA-CMP Bank", changedAt: old },
          { workspaceId, kind: "pricingTier", value: "Enterprise", sourceLabel: "Pricing page", changedAt: old },
        ],
      },
      media: {
        create: [
          { workspaceId, label: "QA-CMP Alpha dashboard", kind: "Screenshot", mediaPath: `${MEDIA_SUBDIR}/alerts.png`, sourceLabel: "Trial", capturedAt: daysAgo(3), position: 0 },
          { workspaceId, label: "QA-CMP Alpha onboarding", kind: "Clip", mediaPath: `${MEDIA_SUBDIR}/onboarding.png`, sourceLabel: "Help center", capturedAt: daysAgo(2), position: 1 },
        ],
      },
    },
  });
  alphaId = alpha.id;
  await db.capabilityStatus.create({
    data: {
      workspaceId, competitorId: alpha.id, capabilityId: darkWeb.id, value: "found", confidence: 0.9, product: PRODUCT.core,
      quote: QUOTE.darkWeb, sourceUrl: `https://${ALPHA.host}/dark-web`, changedAt: DARKWEB_CHANGED,
      history: { create: { value: "low", quote: QUOTE.darkWebBefore, sourceUrl: `https://${ALPHA.host}/platform`, at: DARKWEB_CHANGED } },
    },
  });
  await db.capabilityStatus.create({ data: { workspaceId, competitorId: alpha.id, capabilityId: brand.id, value: "found", confidence: 0.8, product: PRODUCT.edge, quote: QUOTE.brand, sourceUrl: `https://${ALPHA.host}/brand`, changedAt: daysAgo(40) } });
  const vulnStatus = await db.capabilityStatus.create({ data: { workspaceId, competitorId: alpha.id, capabilityId: vuln.id, value: "low", confidence: 0.7, quote: QUOTE.vuln } });
  alphaVulnStatusId = vulnStatus.id;

  // Beta — one website scan: statuses without products, undated facts, no media.
  await db.competitor.create({
    data: {
      workspaceId, name: BETA.name, websiteUrl: `https://${BETA.host}`, host: BETA.host, position: 1,
      sources: { create: scannedSource("website", `https://${BETA.host}`, hoursAgo(5), 6, "scheduled") },
      statuses: {
        create: [
          { workspaceId, capabilityId: darkWeb.id, value: "low", confidence: 0.6, quote: QUOTE.betaDarkWeb, sourceUrl: `https://${BETA.host}/platform` },
          { workspaceId, capabilityId: brand.id, value: "not_found", confidence: 0.9 },
          // No cell for vuln: Beta was never looked at for it.
        ],
      },
      facts: {
        create: [
          { workspaceId, kind: "tagline", value: "Threat intel for everyone", changedAt: old },
          { workspaceId, kind: "vertical", value: "Finance", changedAt: old },
          { workspaceId, kind: "vertical", value: "Retail", changedAt: old },
          { workspaceId, kind: "integration", value: "Splunk", changedAt: old },
          { workspaceId, kind: "customer", value: "QA-CMP Bank", changedAt: old },
        ],
      },
    },
  });
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
const timelineOf = (page: Page) => page.getByRole("region", { name: "Company timeline" });
/** A fact-grid card: the innermost div holding the label (the `has` locator must be page-rooted). */
const factCard = (page: Page, label: string) => page.locator("div", { has: page.getByText(label, { exact: true }) }).filter({ hasText: label }).last();
/** The low-confidence mark of a capability row: a check in a dashed ring, named by its title. */
const lowMark = (page: Page, name: string) => capRow(page, name).locator('[title^="Low confidence"]');
/** Deep-dive marker — one per open row. */
const dives = (page: Page) => page.getByText("Evidence", { exact: true });

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

  test("P-01 profile with every pipeline table filled renders each section from its rows", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);

    // Chip line: most recent source scan, sources with a scan, media rows.
    await expect(page.getByText(/Last scan 3 h ago · 2 sources · 2 UI captures/)).toBeVisible();
    await expect(page.getByRole("link", { name: ALPHA.host })).toHaveAttribute("href", `https://${ALPHA.host}`);
    // Identity line from the company facts, the tagline beside it.
    await expect(page.getByText("Private · Boston, MA · founded 2015 · 1,200", { exact: true })).toBeVisible();
    await expect(page.getByText("“Intelligence you can act on”", { exact: true })).toBeVisible();
    // Risk from the matrix: behind on dark web (found there, not found at the org), level on the other two → 1 of 3 → 33 → Medium.
    await expect(page.getByRole("img", { name: "Risk 33 of 100" })).toBeVisible();
    await expect(page.getByText("Medium", { exact: true })).toBeVisible();
    await expect(page.getByText("Ahead of QA-CMP Org on 1 of 3 capabilities", { exact: true })).toBeVisible();

    // Fact cards: label, joined values, the fact's own source label under the value.
    await expect(factCard(page, "Funding")).toContainText(FUNDING);
    await expect(factCard(page, "Funding")).toContainText("Press");
    await expect(factCard(page, "Headcount")).toContainText("1,200");
    await expect(factCard(page, "Headcount")).toContainText("Jobs page");
    await expect(factCard(page, "Hiring")).toContainText("+17 roles");
    await expect(factCard(page, "Verticals")).toContainText("Finance · Healthcare");
    await expect(factCard(page, "Verticals")).toContainText("Website"); // no label on the fact → "Website"
    await expect(factCard(page, "Certifications")).toContainText("SOC 2");
    await expect(factCard(page, "Certifications")).toContainText("Trust page");
    await expect(factCard(page, "Integrations")).toContainText("Splunk");
    await expect(factCard(page, "Customers named")).toContainText("QA-CMP Bank");
    await expect(factCard(page, "Pricing tiers")).toContainText("Enterprise");
    // Every fact, collapsed by default; the dated ones carry their year.
    await page.getByRole("button", { name: /From the website · 14/ }).click();
    await expect(page.getByText("Boston, MA", { exact: true }).last()).toBeVisible();
    const foundedRow = page.locator("li", { has: page.getByText("2015", { exact: true }) });
    await expect(foundedRow.first()).toContainText("2015");
    await expect(page.locator("li", { has: page.getByText(FUNDING, { exact: true }) }).first()).toContainText("2019");
    await page.getByRole("button", { name: /From the website · 14/ }).click();

    // Timeline: only the dated facts — Founded (kind founded), the funding round, the milestone.
    const timeline = timelineOf(page);
    // Caption copy since dae2458 (timeline clusters, 2026-10-29): lib/competitors/copy.ts timeline.note.
    await expect(timeline.getByText("2015 → today · dated facts from the competitor's sources · scroll sideways for earlier years", { exact: true })).toBeVisible();
    await expect(timeline.getByRole("button", { name: "All · 3" })).toHaveAttribute("aria-pressed", "true");
    await expect(timeline.getByRole("button", { name: "Company · 2" })).toBeVisible();
    await expect(timeline.getByRole("button", { name: "Funding · 1" })).toBeVisible();
    await expect(timeline.getByRole("button", { name: /Products/ })).toHaveCount(0);
    await expect(timeline.getByRole("button", { name: /Hiring/ })).toHaveCount(0);
    for (const title of ["Founded", FUNDING, MILESTONE]) await expect(timeline.getByText(title, { exact: true })).toBeVisible();
    await expect(timeline.getByText("+17 roles", { exact: true })).toHaveCount(0); // undated → not on the timeline
    // `has` is queried relative to the outer element — the inner locator must be page-rooted.
    await expect(timeline.locator("span", { has: page.getByText(FUNDING, { exact: true }) }).last()).toContainText("Mar 2019 · funding"); // ProfilePanel tlWhen: "Mon YYYY" since dae2458
    await expect(timeline.locator("span", { has: page.getByText("Founded", { exact: true }) }).last()).toContainText("Jun 2015 · company");
    await expect(timeline.getByRole("link", { name: new RegExp(FUNDING.replace("$", "\\$")) })).toHaveAttribute("href", `https://${ALPHA.host}/press/series-b`);

    // Capabilities: grouped under the products the statuses name, the orphan under "No product named".
    await expect(page.getByText("1 domains · 2 products · 3 capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText(/vs QA-CMP Org: ahead on 1 · level on 2 · behind on 0/)).toBeVisible();
    await expect(page.getByText(`domain · 2 products · 3 capabilities · ${PRODUCT.core}, ${PRODUCT.edge}`, { exact: true })).toBeVisible();
    await expect(page.getByText("QA-CMP Org behind on 1", { exact: true })).toBeVisible();
    await expect(page.getByText("level on 2", { exact: true })).toBeVisible();
    await expect(page.getByText(PRODUCT.core, { exact: true })).toBeVisible();
    await expect(page.getByText(PRODUCT.edge, { exact: true })).toBeVisible();
    await expect(page.getByText("product · 1 capability", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No product named", { exact: true })).toBeVisible();
    await expect(page.getByText("the pages do not say which product provides these", { exact: true })).toBeVisible();
    await expect(capRow(page, CAP.darkWeb)).toContainText("QA-CMP Org missing");
    await expect(capRow(page, CAP.darkWeb)).toContainText(`Changed ${shortDate(DARKWEB_CHANGED)}`);
    await expect(capRow(page, CAP.brand)).toContainText("Level");
    await expect(capRow(page, CAP.brand)).toContainText(/Changed /);
    await expect(lowMark(page, CAP.vuln)).toHaveCount(1);
    await expect(lowMark(page, CAP.darkWeb)).toHaveCount(0);
    await expect(capRow(page, CAP.vuln)).toContainText("Level");
    await expect(capRow(page, CAP.vuln)).toContainText("No change");

    // Deep dive: the quote and its page, the Product card, the history row, where the org stands.
    await capRow(page, CAP.darkWeb).click();
    await expect(page.getByText("quoted from the competitor's pages", { exact: true })).toBeVisible();
    await expect(page.getByText(`“${QUOTE.darkWeb}”`, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `${ALPHA.host}/dark-web` })).toHaveAttribute("href", `https://${ALPHA.host}/dark-web`);
    await expect(page.getByText("Product", { exact: true })).toBeVisible();
    await expect(page.getByText(PRODUCT.core, { exact: true })).toHaveCount(2); // group header + the Product card
    // No Confidence card since 66e394c: confidence shows only as the low-confidence mark.
    await expect(page.getByText("Confidence", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Corrected", { exact: true })).toHaveCount(0);
    await expect(page.getByText("History · 1", { exact: true })).toBeVisible();
    await expect(page.getByText(`“${QUOTE.darkWebBefore}”`, { exact: true })).toBeVisible();
    await expect(page.getByText(`until ${shortDate(DARKWEB_CHANGED)}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/Where QA-CMP Org stands: not found/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach to idea" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Flag as wrong" })).toBeEnabled();

    // Side column: recent changes (the dark-web cell 7 d ago, the funding fact 2 d ago; the 40 d cell and 60 d facts are out).
    const changed = sideCard(page, "What changed · 30 days");
    await expect(changed).toContainText("2 signals");
    await expect(changed).toContainText(`Funding: ${FUNDING}`);
    await expect(changed).toContainText(`Press · ${shortDate(daysAgo(2))}`);
    await expect(changed).toContainText(`${CAP.darkWeb}: now found`);
    await expect(changed).toContainText(`Website · ${shortDate(DARKWEB_CHANGED)}`);
    await expect(changed.getByText("High", { exact: true })).toHaveCount(1); // found there, not found at the org
    await expect(changed.getByText("Low", { exact: true })).toHaveCount(1); // the fact
    await expect(changed).not.toContainText(CAP.brand);
    await expect(changed).not.toContainText("Splunk");
    const gallery = sideCard(page, "UI gallery");
    await expect(gallery).toContainText("2 captures");
    await expect(gallery.getByRole("img", { name: "QA-CMP Alpha dashboard" })).toBeVisible();
    await expect(gallery).toContainText("QA-CMP Alpha dashboard · Trial");
    // A capture is a button that opens the Lightbox; the media URL is the lightbox's link (ui/Lightbox.tsx).
    await gallery.getByRole("button", { name: /QA-CMP Alpha onboarding/ }).click();
    const lightbox = page.getByRole("dialog", { name: "QA-CMP Alpha onboarding" });
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("QA-CMP Alpha onboarding · Help center");
    await expect(lightbox.getByRole("link")).toHaveAttribute("href", `/api/competitors/media?p=${encodeURIComponent(`${MEDIA_SUBDIR}/onboarding.png`)}`);
    await lightbox.getByRole("button", { name: "Close" }).click();
    await expect(lightbox).toHaveCount(0);
    const sources = sideCard(page, "Sources");
    await expect(sources).toContainText("2 · last scan 3 h ago");
    await expect(sources).toContainText("Website · 12 pages");
    await expect(sources).toContainText("Help center · 4 pages");

    await expectNoCrash(page);
  });

  test("P-02 profile with a website scan only: header, facts and statuses render; empty sections show their empty state", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, BETA.name);

    await expect(page.getByText(/Last scan 5 h ago · 1 source · 0 UI captures/)).toBeVisible();
    await expect(page.getByRole("link", { name: BETA.host })).toBeVisible();
    // No ownership/hq/founded/headcount facts → the tagline is the identity line.
    await expect(page.getByText("“Threat intel for everyone”", { exact: true })).toBeVisible();
    // Risk: dark web low confidence vs our not found (behind), brand not found vs our found (ahead), vuln no cell (no signal) → 1 of 2 → High.
    await expect(page.getByRole("img", { name: "Risk 50 of 100" })).toBeVisible();
    await expect(page.getByText("High risk", { exact: true })).toBeVisible();
    await expect(page.getByText("Ahead of QA-CMP Org on 1 of 2 capabilities", { exact: true })).toBeVisible();
    // Fact cards: Funding/Headcount/Hiring only with rows; the website kinds always, "—" when empty.
    await expect(factCard(page, "Verticals")).toContainText("Finance · Retail");
    await expect(factCard(page, "Integrations")).toContainText("Splunk");
    await expect(factCard(page, "Customers named")).toContainText("QA-CMP Bank");
    await expect(factCard(page, "Pricing tiers")).toContainText("—");
    await expect(factCard(page, "Certifications")).toContainText("—");
    await expect(page.getByText("Funding", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Headcount", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Hiring", { exact: true })).toHaveCount(0);
    // The facts list still opens and lists them.
    await page.getByRole("button", { name: /From the website · 5/ }).click();
    await expect(page.getByText("Retail", { exact: true })).toBeVisible();
    await expect(page.getByText("QA-CMP Bank", { exact: true }).first()).toBeVisible();

    // Statuses without a product → flat rows, no product groups, no orphan header.
    await expect(page.getByText("1 domains · 0 products · 3 capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText(/vs QA-CMP Org: ahead on 1 · level on 0 · behind on 1/)).toBeVisible();
    await expect(page.getByText("domain · 0 products · 3 capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText("No product named", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^product · /)).toHaveCount(0);
    await expect(lowMark(page, CAP.darkWeb)).toHaveCount(1);
    await expect(capRow(page, CAP.darkWeb)).toContainText("QA-CMP Org missing");
    await expect(capRow(page, CAP.darkWeb)).toContainText("No change");
    await expect(capRow(page, CAP.brand)).toContainText("Not found");
    await expect(capRow(page, CAP.brand)).toContainText("QA-CMP Org ahead");
    await expect(capRow(page, CAP.vuln)).toContainText("No signal");
    await expect(capRow(page, CAP.vuln)).not.toContainText("No change"); // no cell: nothing that could have changed

    // Empty sections: the timeline's copy, no gallery section at all, nothing changed, the one source.
    const timeline = timelineOf(page);
    await expect(timeline).toContainText("No dated facts yet — funding rounds, acquisitions and launches appear here once a source states their dates.");
    await expect(timeline.getByRole("button")).toHaveCount(0);
    await expect(sideCard(page, "UI gallery")).toHaveCount(0);
    await expect(page.getByText("UI gallery", { exact: true })).toHaveCount(0);
    const changed = sideCard(page, "What changed · 30 days");
    await expect(changed).toContainText("0 signals");
    await expect(changed).toContainText("Nothing changed in the last 30 days.");
    const sources = sideCard(page, "Sources");
    await expect(sources).toContainText("1 · last scan 5 h ago");
    await expect(sources).toContainText("Website · 6 pages");
    await expect(sources).not.toContainText("Help center");

    // Deep dive on a row without a product: evidence, no Product card, no history.
    await capRow(page, CAP.darkWeb).click();
    await expect(page.getByText(`“${QUOTE.betaDarkWeb}”`, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `${BETA.host}/platform` })).toBeVisible();
    await expect(page.getByText("Product", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/History · /)).toHaveCount(0);
    await expect(page.getByText(/Where QA-CMP Org stands: not found/)).toBeVisible();
    // A row with no evidence says so.
    await capRow(page, CAP.vuln).click();
    await expect(page.getByText("No evidence captured", { exact: true })).toBeVisible();

    await expectNoCrash(page);
  });

  test("P-03 timeline type filter narrows the dated facts, All restores, and the filter is recorded", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    const timeline = timelineOf(page);
    await expect(timeline.getByText("Founded", { exact: true })).toBeVisible();

    await timeline.getByRole("button", { name: "Funding · 1" }).click();
    await expect(timeline.getByRole("button", { name: "Funding · 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(timeline.getByRole("button", { name: "All · 3" })).toHaveAttribute("aria-pressed", "false");
    await expect(timeline.getByText(FUNDING, { exact: true })).toBeVisible();
    for (const hidden of ["Founded", MILESTONE]) await expect(timeline.getByText(hidden, { exact: true })).toHaveCount(0);

    await timeline.getByRole("button", { name: "Company · 2" }).click();
    await expect(timeline.getByText(FUNDING, { exact: true })).toHaveCount(0);
    for (const title of ["Founded", MILESTONE]) await expect(timeline.getByText(title, { exact: true })).toBeVisible();

    await timeline.getByRole("button", { name: "All · 3" }).click();
    await expect(timeline.getByRole("button", { name: "All · 3" })).toHaveAttribute("aria-pressed", "true");
    for (const title of ["Founded", FUNDING, MILESTONE]) await expect(timeline.getByText(title, { exact: true })).toBeVisible();

    // The client queue flushes within 5 s — poll the table.
    await expect
      .poll(async () => (await usageEvents("cmp_profile_timeline_filtered")).map(propsOf), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([{ competitorId: alphaId, type: "funding" }, { competitorId: alphaId, type: "company" }, { competitorId: alphaId, type: "all" }]));
    expect((await usageEvents("cmp_profile_timeline_filtered")).every((r) => r.userId === userId)).toBe(true);
  });

  test("P-04 capability deep dive: one open at a time, and each opening is recorded", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    await expect(dives(page)).toHaveCount(0);

    await capRow(page, CAP.darkWeb).click();
    await expect(dives(page)).toHaveCount(1);
    await expect(page.getByText(`“${QUOTE.darkWeb}”`, { exact: true })).toBeVisible();
    await expect(page.getByText("History · 1", { exact: true })).toBeVisible();

    // Opening a second capability closes the first.
    await capRow(page, CAP.brand).click();
    await expect(dives(page)).toHaveCount(1);
    await expect(page.getByText(`“${QUOTE.darkWeb}”`, { exact: true })).toHaveCount(0);
    await expect(page.getByText(`“${QUOTE.brand}”`, { exact: true })).toBeVisible();
    await expect(page.getByText(/History · /)).toHaveCount(0);

    // Clicking the open row again closes it.
    await capRow(page, CAP.brand).click();
    await expect(dives(page)).toHaveCount(0);

    await expect
      .poll(async () => (await usageEvents("cmp_capability_dive_opened")).map(propsOf), { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining([
          { competitorId: alphaId, capabilityId: capIds.darkWeb, value: "found", hasHistory: true },
          { competitorId: alphaId, capabilityId: capIds.brand, value: "found", hasHistory: false },
        ]),
      );
  });

  test("P-05 Flag as wrong from the profile saves the override, marks the matrix cell, records surface profile", async ({ page }) => {
    await loginWithTotp(page, USER);
    await openProfiles(page, ALPHA.name);
    await expect(lowMark(page, CAP.vuln)).toHaveCount(1);
    await expect(capRow(page, CAP.vuln)).toContainText("Level");

    try {
      await capRow(page, CAP.vuln).click();
      await page.getByRole("button", { name: "Flag as wrong" }).click();
      await expect(page.getByText("Set to", { exact: true })).toBeVisible();
      // A PM corrects a cell to found or not found; "low confidence" is a value only the analysis sets.
      await expect(page.getByRole("button", { name: "Low confidence", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Not found", exact: true }).click();

      // The row now shows the corrected value and the stance that follows from it; the dive shows the Corrected card.
      await expect(page.getByText("Set to", { exact: true })).toHaveCount(0);
      await expect(capRow(page, CAP.vuln)).toContainText("QA-CMP Org ahead");
      await expect(lowMark(page, CAP.vuln)).toHaveCount(0);
      await expect(capRow(page, CAP.vuln)).toContainText("Not found");
      await expect(page.getByText("Corrected", { exact: true })).toBeVisible();
      await expect(page.getByText(/Edited by QA CMP User, .* · scan said Low confidence/)).toBeVisible();
      // The risk ring follows the matrix: still 1 of 3 behind (vuln moved from level to ahead-for-us).
      await expect(page.getByRole("img", { name: "Risk 33 of 100" })).toBeVisible();
      await expect(page.getByText(/vs QA-CMP Org: ahead on 1 · level on 1 · behind on 1/)).toBeVisible();

      const cell = await withTestDb((db) => db.capabilityStatus.findUniqueOrThrow({ where: { id: alphaVulnStatusId } }));
      expect(cell.overrideValue).toBe("not_found");
      expect(cell.overrideNote).toBe(FLAG_NOTE);
      expect(cell.overrideUserId).toBe(userId);
      expect(cell.overrideAt).not.toBeNull();
      expect(cell.value, "the scanned value is kept under the override").toBe("low");

      // Server-written event, no flush to wait for.
      const overrides = (await usageEvents("cmp_status_overridden")).map(propsOf);
      expect(overrides).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ competitorId: alphaId, capabilityId: capIds.vuln, from: "low", to: "not_found", hasNote: true, reset: false, surface: "profile" }),
        ]),
      );

      // The matrix shows the corrected mark with the edited flag.
      await page.getByRole("tab", { name: "Parity matrix" }).click();
      const row = page.locator("tbody tr", { hasText: CAP.vuln });
      // Columns: the capability, the org, Alpha, Beta.
      const matrixCell = row.locator("td").nth(2).getByRole("button", { name: `${CAP.vuln}: Not found`, exact: true });
      await expect(matrixCell).toBeVisible();
      await expect(matrixCell.locator('[aria-label="edited"]')).toHaveCount(1);
      await expect(row.getByRole("button", { name: `${CAP.vuln}: Low confidence`, exact: true })).toHaveCount(0);
      // Beta has no cell in this row (it reads "Not found" too): the one edited mark of the row is Alpha's.
      await expect(row.locator('[aria-label="edited"]')).toHaveCount(1);
    } finally {
      // Leave the cell as the scan found it so no other case depends on this one having run.
      await withTestDb((db) => db.capabilityStatus.update({ where: { id: alphaVulnStatusId }, data: { overrideValue: null, overrideNote: null, overrideUserId: null, overrideAt: null } }));
    }
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
      await withTestDb((db) => db.organization.update({ where: { id: orgId }, data: { features: { competitors: true, competitorsProfiles: true } } }));
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
        await expect(page.getByText(`“${QUOTE.darkWeb}”`, { exact: true })).toBeVisible();
        const rows = page.getByRole("button", { name: /^QA-CMP (Dark web monitoring|Brand protection|Vulnerability intel)/ });
        await expect(rows).toHaveCount(3);
        return {
          identity: await page.getByText("Private · Boston, MA · founded 2015 · 1,200", { exact: true }).count(),
          risk: await page.getByRole("img", { name: "Risk 33 of 100" }).count(),
          rows: await rows.allInnerTexts(),
          products: [await page.getByText(PRODUCT.core, { exact: true }).count(), await page.getByText(PRODUCT.edge, { exact: true }).count()],
          orphanGroup: await page.getByText("No product named", { exact: true }).count(),
          history: await page.getByText("History · 1", { exact: true }).count(),
          flagAsWrong: await page.getByRole("button", { name: "Flag as wrong" }).count(),
          changed: (await sideCard(page, "What changed · 30 days").innerText()).replace(/\s+/g, " "),
          gallery: (await sideCard(page, "UI gallery").innerText()).replace(/\s+/g, " "),
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
    expect(admin.orphanGroup).toBe(1);
    expect(admin.history).toBe(1);
    expect(admin.flagAsWrong).toBe(1);
    expect(admin.rows.join("\n")).toContain("QA-CMP Org missing");
    expect(admin.sources).toContain("Help center · 4 pages");
  });
});
