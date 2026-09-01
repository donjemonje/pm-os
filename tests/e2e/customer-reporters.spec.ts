import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { loginAsRoomLens } from "./helpers";
import { RESOLVED_ENV } from "./test-env";

/**
 * Customers & reporters on ideas (feature/customer-reporters):
 * - Settings → Ideas gains a "Customers" catalog (same CRUD panel/API as
 *   product lines and platforms via the shared KINDS registry).
 * - An idea's customers/reporters are DERIVED at read time from its source
 *   tickets (union of affectedCustomers minus dismissedCustomers; reporters
 *   = distinct requesters).
 * - Off-catalog names render as amber "suggested" chips with ✓ approve
 *   (into the catalog) and ✕ dismiss (reversible soft-dismiss with restore).
 *
 * The import path calls the Vertex LLM, so no test imports a CSV. Fixtures
 * are seeded directly with Prisma in beforeAll: ZendeskTicketRaw rows with
 * affectedCustomers + Ideas linked via IdeaSource — exactly what the LLM
 * stage would have written. Everything from there (derivation, chips,
 * mutations, catalog CRUD) is LLM-free.
 *
 * Ideas gating: the env guard pins IDEAS_ENABLED off (all-pages.spec.ts
 * asserts the 404), so — same pattern as admin.spec.ts A2 — this spec sets
 * the RoomLens per-org override {ideas: true} in beforeAll and clears it in
 * afterAll. The seed's `features: {}` reset stays untouched on purpose.
 *
 * State discipline: beforeAll deletes and recreates every fixture row (all
 * names/ids carry a QA-CR / "QA " prefix), afterAll deletes them and clears
 * the override, so the suite reruns green without re-seeding and a mid-test
 * failure can't leak into other specs. All tests write data.
 */

const ROOMLENS_SLUG = "roomlens";

// Fixture names — synthetic, obviously QA, mutually non-substring.
const IDEA_TITLE = "QA-CR batch export scheduling";
const IDEA2_TITLE = "QA-CR watermark presets";
const CATALOGED = "QA Blue Studio"; // in the Customers catalog from beforeAll
const SUGGESTED_APPROVE = "QA Nimbus Post"; // off-catalog; CR2 approves it
const SUGGESTED_DISMISS = "QA Drift Cabin"; // off-catalog; CR3 dismisses+restores it
const SUGGESTED_SOLO = "QA Solo Harbor"; // off-catalog on idea 2 only; never reviewed
const SETTINGS_CUSTOMER = "QA Settings Customer"; // CR1 creates + deletes it
const REPORTER_1 = "Rivka Stern (QA)";
const REPORTER_2 = "Avi Peretz (QA)";
const TICKET_PREFIX = "QA-CR-";

// Chip title attributes (IdeaDrawer.tsx idea-view chips).
const SUGGESTED_TITLE = "Suggested customer — not in the catalog yet";

const FIXTURE_CUSTOMER_NAMES = [
  CATALOGED,
  SUGGESTED_APPROVE,
  SUGGESTED_DISMISS,
  SUGGESTED_SOLO,
  SETTINGS_CUSTOMER,
];

let workspaceId: string;

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  // Same resolved env as the app (yaml wins over shell); the env guard has
  // already pinned the database to pmos_test before this runs.
  process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/** Delete every fixture row this spec ever creates (idempotent). ReviewEvents
 * and IdeaSources cascade with their Idea. */
async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({
    where: { workspaceId, title: { in: [IDEA_TITLE, IDEA2_TITLE] } },
  });
  await db.zendeskTicketRaw.deleteMany({
    where: { workspaceId, externalId: { startsWith: TICKET_PREFIX } },
  });
  await db.customer.deleteMany({
    where: {
      workspaceId,
      OR: FIXTURE_CUSTOMER_NAMES.map((name) => ({
        name: { equals: name, mode: "insensitive" as const },
      })),
    },
  });
}

test.describe("Ideas — customers & reporters", () => {
  test.beforeAll(async () => {
    await withDb(async (db) => {
      const org = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `customer-reporters spec could not reach the QA org — did you run ` +
              `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
          );
        });
      if (!org?.workspace) {
        throw new Error(
          "RoomLens org/workspace missing — run `npm run test:db:setup`."
        );
      }
      workspaceId = org.workspace.id;

      // Ideas on for the org via the per-org override (env default stays off).
      await db.organization.update({
        where: { id: org.id },
        data: { features: { ideas: true } },
      });

      await deleteFixtures(db);

      await db.customer.create({
        data: { workspaceId, name: CATALOGED, description: "QA fixture — cataloged customer" },
      });

      // Tickets exactly as the catalog stage (v5) would have persisted them:
      // requester from the export, affectedCustomers from extraction
      // (catalog-normalized or verbatim), dismissedCustomers untouched.
      const t1 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}1`,
          subject: "Scheduled batch exports",
          body: "QA fixture ticket — please let us schedule exports overnight.",
          requester: REPORTER_1,
          affectedCustomers: [CATALOGED, SUGGESTED_APPROVE, SUGGESTED_DISMISS],
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      const t2 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}2`,
          subject: "Batch export timing",
          body: "QA fixture ticket — exports should run off-peak.",
          requester: REPORTER_2,
          affectedCustomers: [CATALOGED],
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      const t3 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}3`,
          subject: "Watermark presets",
          body: "QA fixture ticket — save watermark settings as presets.",
          requester: REPORTER_2,
          affectedCustomers: [SUGGESTED_SOLO],
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });

      // Idea 1: two tickets → derived customers are the union, reporters both
      // requesters. Idea 2 exists so the customer filter has a row to exclude.
      await db.idea.create({
        data: {
          workspaceId,
          title: IDEA_TITLE,
          details: "QA fixture idea — scheduling for batch exports.",
          products: ["Other"],
          batchStatus: "new",
          decision: "pending",
          origin: "zendesk",
          newVotes: 2,
          sources: {
            create: [
              { kind: "zendesk", ticketId: t1.id },
              { kind: "zendesk", ticketId: t2.id },
            ],
          },
        },
      });
      await db.idea.create({
        data: {
          workspaceId,
          title: IDEA2_TITLE,
          details: "QA fixture idea — watermark presets.",
          products: ["Other"],
          batchStatus: "new",
          decision: "pending",
          origin: "zendesk",
          newVotes: 1,
          sources: { create: [{ kind: "zendesk", ticketId: t3.id }] },
        },
      });
    });
  });

  test.afterAll(async () => {
    await withDb(async (db) => {
      await deleteFixtures(db);
      // Back to the env default (ideas off) — all-pages.spec.ts depends on it.
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    });
  });

  /** The Customers panel on /settings/ideas, scoped by its exact title. */
  function customersPanel(page: Page) {
    return page.locator("section", {
      has: page.getByText("Customers", { exact: true }),
    });
  }

  /** An idea row on /ideas (the only cursor-pointer divs on the page). */
  function ideaRow(page: Page, title: string) {
    return page.locator("div.cursor-pointer", { hasText: title });
  }

  /** The open idea drawer (fixed right-hand panel). */
  function drawerOf(page: Page) {
    return page.locator("div.fixed.bottom-0.right-0.top-0");
  }

  async function openIdeaDrawer(page: Page, title: string) {
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    await ideaRow(page, title).click();
    const drawer = drawerOf(page);
    await expect(drawer.getByRole("heading", { name: title })).toBeVisible();
    return drawer;
  }

  /** ReviewEvents of one action whose payload names the given customer. */
  async function eventCount(action: string, name: string): Promise<number> {
    return withDb(async (db) => {
      const events = await db.reviewEvent.findMany({ where: { workspaceId, action } });
      return events.filter(
        (e) => (e.payload as { name?: string } | null)?.name === name
      ).length;
    });
  }

  test("CR1 Settings → Ideas: Customers panel add, duplicate rejection, delete", async ({
    page,
  }) => {
    // Delete confirms via window.confirm.
    page.on("dialog", (dialog) => dialog.accept());

    await loginAsRoomLens(page);
    await page.goto("/settings/ideas");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const panel = customersPanel(page);
    // Server-rendered initial items include the seeded catalog row.
    await expect(panel.getByText(CATALOGED, { exact: true })).toBeVisible();

    // Add — name + description land in the list.
    await panel.getByPlaceholder("Customer name").fill(SETTINGS_CUSTOMER);
    await panel
      .getByPlaceholder(/aliases or tier/)
      .fill("QA fixture — settings CRUD");
    await panel.getByRole("button", { name: "Add" }).click();
    // 15s: first hit on the customers API — local runs `next dev`, and the
    // on-demand route compile can hold the POST past the default 5s expect
    // timeout (seen 2026-08-31; form correctly disabled mid-flight, product
    // fine). Same timing-by-design class as the TOTP window waits.
    await expect(panel.getByText(SETTINGS_CUSTOMER, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByText("QA fixture — settings CRUD")).toBeVisible();

    // Persisted, not just optimistic UI.
    await page.reload();
    await expect(panel.getByText(SETTINGS_CUSTOMER, { exact: true })).toBeVisible();

    // Duplicate names are rejected case-insensitively.
    await panel.getByPlaceholder("Customer name").fill(SETTINGS_CUSTOMER.toLowerCase());
    await panel.getByRole("button", { name: "Add" }).click();
    await expect(panel.getByText(/already exists/)).toBeVisible();

    // Delete — gone from the list and stays gone after a reload.
    await panel.getByLabel(`Delete ${SETTINGS_CUSTOMER}`).click();
    await expect(panel.getByText(SETTINGS_CUSTOMER, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(panel.getByText(CATALOGED, { exact: true })).toBeVisible();
    await expect(panel.getByText(SETTINGS_CUSTOMER, { exact: true })).toHaveCount(0);
  });

  test("CR2 idea drawer derives reporters and customers; approving a suggested customer flips it teal and adds it to the catalog", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    const drawer = await openIdeaDrawer(page, IDEA_TITLE);

    // Reporters: distinct requesters of the linked tickets.
    const reported = drawer.getByText(/Reported by /);
    await expect(reported).toBeVisible();
    await expect(reported).toContainText(REPORTER_1);
    await expect(reported).toContainText(REPORTER_2);

    // Cataloged customer renders as a plain teal chip (no suggestion title).
    const catChip = drawer.getByText(CATALOGED, { exact: true });
    await expect(catChip).toBeVisible();
    await expect(catChip).toHaveClass(/47,160,143/);
    await expect(
      drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, { hasText: CATALOGED })
    ).toHaveCount(0);

    // Off-catalog customer renders as an amber suggested chip with actions.
    const suggested = drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, {
      hasText: SUGGESTED_APPROVE,
    });
    await expect(suggested).toBeVisible();
    await expect(suggested).toHaveClass(/border-amber-400/);

    // ✓ approve → catalog gains the name and the chip flips teal live (the
    // customer catalog rides on the /api/ideas state refresh — no reload).
    await suggested.getByTitle("Add to the Customers catalog").click();
    await expect(
      drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, { hasText: SUGGESTED_APPROVE })
    ).toHaveCount(0);
    const approvedChip = drawer.getByText(SUGGESTED_APPROVE, { exact: true });
    await expect(approvedChip).toBeVisible();
    await expect(approvedChip).toHaveClass(/47,160,143/);

    // The name is really in the Customers catalog (same session's cookies).
    const res = await page.request.get("/api/ideas/lists/customers");
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as { items: { name: string }[] };
    expect(items.map((i) => i.name)).toContain(SUGGESTED_APPROVE);

    // The review decision is on the ledger.
    expect(await eventCount("approve_customer", SUGGESTED_APPROVE)).toBeGreaterThan(0);
  });

  test("CR3 dismiss is reversible: chip leaves the row, dismissed toggle appears, restore brings it back", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    const drawer = await openIdeaDrawer(page, IDEA_TITLE);

    const suggested = drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, {
      hasText: SUGGESTED_DISMISS,
    });
    await expect(suggested).toBeVisible();

    // ✕ dismiss → chip leaves the visible list, muted toggle appears.
    await suggested.getByTitle("Dismiss this suggestion").click();
    await expect(suggested).toHaveCount(0);
    const toggle = drawer.getByRole("button", { name: /1 dismissed customer/ });
    await expect(toggle).toBeVisible();

    // Expanding shows the strikethrough chip with a restore affordance.
    await toggle.click();
    await expect(
      drawer.locator("span.line-through", { hasText: SUGGESTED_DISMISS })
    ).toBeVisible();

    // Restore → dismissed section disappears, the suggestion is back (still
    // amber: dismissing never touched the catalog).
    await drawer.getByTitle("Restore this customer").click();
    await expect(drawer.getByText(/dismissed customer/)).toHaveCount(0);
    await expect(
      drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, { hasText: SUGGESTED_DISMISS })
    ).toBeVisible();

    // Both directions are ReviewEvents — the regret path leaves a trail.
    expect(await eventCount("dismiss_customer", SUGGESTED_DISMISS)).toBeGreaterThan(0);
    expect(await eventCount("undismiss_customer", SUGGESTED_DISMISS)).toBeGreaterThan(0);
  });

  test("CR4 ideas list: rows carry customer chips (suggested flagged) and the Customer filter narrows rows", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();

    const row1 = ideaRow(page, IDEA_TITLE);
    const row2 = ideaRow(page, IDEA2_TITLE);
    await expect(row1).toBeVisible();
    await expect(row2).toBeVisible();

    // Row chips: cataloged names plain, off-catalog names flagged ⚑.
    await expect(row1.getByText(CATALOGED, { exact: true })).toBeVisible();
    await expect(row2.getByText(`${SUGGESTED_SOLO} ⚑`)).toBeVisible();

    // Customer filter: select the cataloged name → only the idea whose
    // tickets name it stays visible.
    await page.getByPlaceholder("All customers").click();
    await page.getByRole("button", { name: CATALOGED, exact: true }).click();
    // Close the dropdown via its backdrop before asserting.
    await page.locator("div.z-\\[24\\]").click();
    await expect(row1).toBeVisible();
    await expect(row2).toHaveCount(0);

    // Clear via the selected chip → both rows return.
    await page.getByRole("button", { name: `${CATALOGED} ✕` }).click();
    await expect(row1).toBeVisible();
    await expect(row2).toBeVisible();
  });
});
