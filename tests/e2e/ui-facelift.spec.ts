import { expect, test, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginAsRoomLensAdmin, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

/**
 * UI facelift v1 (feature/ui_facelift_v1) — the parts with new behaviour,
 * not the restyle itself:
 *
 * UF1 Ideas page: the one-row filter toolbar (search + popover filters on
 *     one line), the single-select Status popover whose "All" option also
 *     reveals the unchanged Jira backlog, the review card titled "Review in
 *     Progress", the "Jira Merge" button disabled (with its hint) while no
 *     Jira integration exists, and — scoring being parked — no "score"
 *     label / "No score yet" text anywhere on the list or in the drawer.
 * UF2 Settings → Ideas → Customers: every row carries a "Chip color for
 *     <name>" swatch; picking a palette color sends PATCH { id, color } and
 *     survives a reload; two names that differ only by a leading "The" show
 *     "Possible duplicate of …" with a Merge button; merging removes the
 *     row and lists the dropped spelling under "Also known as"; the alias's
 *     × splits it back out into its own row.
 * UF3 Idea drawer edit: add a customer by typing + Enter, remove a
 *     ticket-derived one, toggle a product-line chip, Save → the idea shows
 *     the new customer (as a suggestion — off-catalog) and product line, and
 *     the removed customer sits under the "dismissed" toggle (a dismissal on
 *     its tickets, never a deletion). DB + ledger checked.
 * UF4 Admin → Ideas "Import runs": the card renders; a fresh org shows
 *     "No imports yet for this organization." and its runs API returns
 *     { runs: [] }; a completed batch shows up after Refresh; the API is
 *     401 signed-out and 404 for a signed-in non-admin (admin existence is
 *     not advertised — the admin-restriction rule, not a 403).
 *
 * LLM-free: fixtures are Prisma-seeded exactly as the import would persist
 * them (customer-reporters / ideas-jira-merge pattern), QA-UF prefixed,
 * delete-and-recreate in beforeAll + delete in afterAll. Ideas gating: the
 * env guard pins IDEAS_ENABLED off, so beforeAll sets the RoomLens per-org
 * override {ideas: true} and afterAll clears it (all-pages.spec.ts depends
 * on the default). Jira precondition: the seed strips connections from the
 * QA workspace; this spec only removes the token-less row ideas-jira-push
 * plants for itself, and fails loudly on any other connection (never
 * deletes credentials). All tests write data.
 */

const ROOMLENS_SLUG = "roomlens";

// Fixture names — synthetic, obviously QA. The Whitfield pair is the one
// deliberate substring (the merge test needs "The X" vs "X").
const NEW_TITLE = "QA-UF scheduled exports";
const UNCHANGED_TITLE = "QA-UF backlog alpha";
const TICKET_ID = "QA-UF-T1";
const JIRA_KEY = "QA-UF-J1";
const PRODUCT_LINE = "QA-UF Line";
const CATALOGED = "QA-UF Cataloged Co"; // on the ticket; UF3 removes it
const ADDED = "QA-UF Added Co"; // off-catalog; UF3 adds it by hand
const SWATCH = "QA-UF Swatch Co"; // UF2 recolors it
const WHITFIELD = "QA-UF Whitfield Group"; // UF2 keeps this spelling
const THE_WHITFIELD = "The QA-UF Whitfield Group"; // UF2 merges this one in
const FRESH_ORG = { name: "QA-UF Fresh Org", slug: "qa-uf-fresh" };
const PJ_TOKENLESS_CLOUD = "qa-pj-cloud"; // ideas-jira-push's own fixture row

const SUGGESTED_TITLE = "Suggested customer — not in the catalog yet";
const NOT_CONNECTED_HINT = "Connect Jira in Settings → Integrations to export";

const FIXTURE_CUSTOMERS = [CATALOGED, ADDED, SWATCH, WHITFIELD, THE_WHITFIELD];

let workspaceId: string;
let newIdeaId: string;
let ticketDbId: string;
let freshOrgId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({
    where: { workspaceId, title: { in: [NEW_TITLE, UNCHANGED_TITLE] } },
  });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId, externalId: TICKET_ID } });
  await db.jiraIdeaSnapshot.deleteMany({ where: { workspaceId, key: JIRA_KEY } });
  await db.customer.deleteMany({
    where: {
      workspaceId,
      OR: FIXTURE_CUSTOMERS.map((name) => ({
        name: { equals: name, mode: "insensitive" as const },
      })),
    },
  });
  await db.productLine.deleteMany({ where: { workspaceId, name: PRODUCT_LINE } });
  await db.organization.deleteMany({ where: { slug: FRESH_ORG.slug } });
}

test.describe("UI facelift v1 — ideas toolbar, customer colors/merge, drawer edit, admin import runs", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `ui-facelift spec could not reach the QA org — did you run ` +
              `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
          );
        });
      if (!org?.workspace) {
        throw new Error("RoomLens org/workspace missing — run `npm run test:db:setup`.");
      }
      workspaceId = org.workspace.id;

      // Ideas on for the org via the per-org override (env default stays off).
      await db.organization.update({
        where: { id: org.id },
        data: { features: { ideas: true } },
      });

      // Jira must be NOT connected for UF1. Only ideas-jira-push's token-less
      // fixture row is ours to remove; anything else is a real credential.
      await db.jiraConnection.deleteMany({ where: { workspaceId, cloudId: PJ_TOKENLESS_CLOUD } });
      const foreign = await db.jiraConnection.findUnique({ where: { workspaceId } });
      if (foreign) {
        throw new Error(
          `QA workspace has a Jira connection (cloudId ${foreign.cloudId}) — the seed ` +
            `should have removed it; run \`npm run test:db:setup\` (never deleted by QA).`
        );
      }

      await deleteFixtures(db);

      await db.productLine.create({
        data: { workspaceId, name: PRODUCT_LINE, description: "QA fixture line", color: "indigo" },
      });
      for (const [name, color] of [
        [CATALOGED, "teal"],
        [SWATCH, "slate"],
        [WHITFIELD, "blue"],
        [THE_WHITFIELD, "lime"],
      ] as const) {
        await db.customer.create({
          data: { workspaceId, name, description: "QA fixture customer", color },
        });
      }

      // One ticket → the New idea (UF3 edits it). One Jira snapshot → the
      // unchanged backlog idea (UF1's Status "All" reveals it).
      const t1 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: TICKET_ID,
          subject: "Scheduled exports please",
          body: "QA fixture ticket — run exports on a schedule.",
          requester: "Rivka Stern (QA)",
          affectedCustomers: [CATALOGED],
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      ticketDbId = t1.id;
      await db.jiraIdeaSnapshot.create({
        data: {
          workspaceId,
          key: JIRA_KEY,
          title: UNCHANGED_TITLE,
          body: "QA fixture Jira idea.",
          components: [],
        },
      });
      newIdeaId = (
        await db.idea.create({
          data: {
            workspaceId,
            title: NEW_TITLE,
            details: "QA fixture idea — new this batch.",
            products: ["Other"],
            batchStatus: "new",
            decision: "pending",
            origin: "zendesk",
            newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: t1.id }] },
          },
        })
      ).id;
      await db.idea.create({
        data: {
          workspaceId,
          title: UNCHANGED_TITLE,
          details: "QA fixture idea — untouched Jira backlog.",
          products: ["Other"],
          batchStatus: "unchanged",
          decision: "pending",
          origin: "jira",
          existingVotes: 2,
          sources: { create: [{ kind: "jira", jiraKey: JIRA_KEY }] },
        },
      });

      // A fresh org with a workspace and no import batches (UF4).
      freshOrgId = (
        await db.organization.create({
          data: {
            name: FRESH_ORG.name,
            slug: FRESH_ORG.slug,
            workspace: { create: { name: `${FRESH_ORG.name} Workspace` } },
          },
        })
      ).id;
    });
  });

  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      // Back to the env default (ideas off) — all-pages.spec.ts depends on it.
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    });
  });

  /** An idea row on the Final page (the only cursor-pointer divs there). */
  function ideaRow(page: Page, title: string) {
    return page.locator("div.cursor-pointer", { hasText: title });
  }

  /** The open idea drawer (fixed right-hand panel). */
  function drawerOf(page: Page) {
    return page.locator("div.fixed.bottom-0.right-0.top-0");
  }

  /** The Customers panel on /settings/ideas/customers, by its exact title. */
  function customersPanel(page: Page) {
    return page.locator("section", { has: page.getByText("Customers", { exact: true }) });
  }

  /** A customer row by its exact name cell (names may be substrings of each other). */
  function customerRow(page: Page, name: string) {
    return customersPanel(page)
      .locator("li")
      .filter({ has: page.locator("div.font-medium", { hasText: new RegExp(`^${name}$`) }) });
  }

  async function gotoIdeas(page: Page) {
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    // Positive anchor before any absence assert: the state fetch has landed.
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
  }

  test("UF1 ideas page: one-row toolbar, Status popover with All, Review in Progress card, Jira Merge disabled, no score text", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);

    // Review card title + the Jira gate: no integration → disabled, hinted.
    await expect(page.getByText("Review in Progress", { exact: true })).toBeVisible();
    const jiraMerge = page.getByRole("button", { name: "Jira Merge" });
    await expect(jiraMerge).toBeVisible();
    await expect(jiraMerge).toBeDisabled();
    await expect(page.locator(`span[title="${NOT_CONNECTED_HINT}"]`)).toBeVisible();

    // Toolbar: search, the popover triggers and the Pending Review toggle
    // sit on ONE row (same vertical position), no chip row until a filter
    // is active.
    const search = page.getByPlaceholder("Search ideas…");
    const statusTrigger = page.getByRole("button", { name: /^Status/ });
    const productTrigger = page.getByRole("button", { name: /^Product Line/ });
    const pendingToggle = page.getByRole("button", { name: "Pending Review", exact: true });
    for (const el of [search, statusTrigger, productTrigger, pendingToggle]) {
      await expect(el).toBeVisible();
    }
    const rowY = (await search.boundingBox())!.y;
    for (const el of [statusTrigger, productTrigger, pendingToggle]) {
      const box = (await el.boundingBox())!;
      expect(Math.abs(box.y - rowY), "toolbar control off the search row").toBeLessThan(8);
    }
    await expect(page.getByText("Filters", { exact: true })).toHaveCount(0);

    // Default view hides the unchanged Jira backlog.
    await expect(ideaRow(page, UNCHANGED_TITLE)).toHaveCount(0);

    // Status → All: single-select, popover closes, trigger shows the value,
    // and the unchanged idea joins the list.
    const popover = page.locator("div.z-\\[25\\]");
    await statusTrigger.click();
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: "All", exact: true })).toBeVisible();
    await popover.getByRole("button", { name: "All", exact: true }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Status: All", exact: true })).toBeVisible();
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_TITLE)).toBeVisible();

    // Status → New REPLACES All (single-select): unchanged hides again.
    await page.getByRole("button", { name: "Status: All", exact: true }).click();
    await popover.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("button", { name: "Status: New", exact: true })).toBeVisible();
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_TITLE)).toHaveCount(0);

    // Picking the active value again clears the filter.
    await page.getByRole("button", { name: "Status: New", exact: true }).click();
    await popover.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("button", { name: "Status", exact: true })).toBeVisible();
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_TITLE)).toHaveCount(0);

    // Scoring is parked: no score column label, no "No score yet" — on the
    // list and inside the drawer.
    await expect(page.getByText("score", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No score yet")).toHaveCount(0);
    await ideaRow(page, NEW_TITLE).click();
    const drawer = drawerOf(page);
    await expect(drawer.getByRole("heading", { name: NEW_TITLE })).toBeVisible();
    await expect(drawer.getByText(/\bscore\b/i)).toHaveCount(0);
    await expect(drawer.getByText("No score yet")).toHaveCount(0);
  });

  test("UF2 Settings → Customers: color swatch per row persists a palette pick; near-duplicate names merge into an alias and split back out", async ({
    page,
  }) => {
    // Merge confirms via window.confirm.
    page.on("dialog", (dialog) => dialog.accept());

    await loginAsRoomLens(page);
    await page.goto("/settings/ideas/customers");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const panel = customersPanel(page);
    await expect(customerRow(page, SWATCH)).toBeVisible();

    // Every row has its swatch button.
    const rows = panel.locator("li");
    const swatches = panel.getByRole("button", { name: /^Chip color for / });
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await swatches.count()).toBe(await rows.count());

    // Pick Red for the swatch fixture (seeded slate): one PATCH { id, color }.
    const swatchButton = panel.getByRole("button", { name: `Chip color for ${SWATCH}` });
    await swatchButton.click();
    const patch = page.waitForResponse(
      (r) => r.url().includes("/api/ideas/lists/customers") && r.request().method() === "PATCH"
    );
    await panel.getByRole("button", { name: "Red", exact: true }).click();
    const patchRes = await patch;
    expect(patchRes.status()).toBe(200);
    const body = patchRes.request().postDataJSON() as Record<string, unknown>;
    expect(body.color).toBe("red");
    expect(typeof body.id).toBe("string");
    expect(body.name).toBeUndefined();
    // Red's foreground (#a32a2a) paints the swatch; still after a reload.
    await expect(swatchButton.locator("span")).toHaveCSS("background-color", "rgb(163, 42, 42)");
    await page.reload();
    await expect(
      panel.getByRole("button", { name: `Chip color for ${SWATCH}` }).locator("span")
    ).toHaveCSS("background-color", "rgb(163, 42, 42)");
    const listed = await page.request.get("/api/ideas/lists/customers");
    expect(listed.status()).toBe(200);
    const { items } = (await listed.json()) as {
      items: { id: string; name: string; color: string | null; aliases: string[] }[];
    };
    expect(items.find((i) => i.name === SWATCH)?.color).toBe("red");
    expect(items.find((i) => i.name === SWATCH)?.id).toBe(body.id);

    // Near-duplicates: both spellings flag each other.
    const plainRow = customerRow(page, WHITFIELD);
    const theRow = customerRow(page, THE_WHITFIELD);
    await expect(plainRow.getByText(`Possible duplicate of "${THE_WHITFIELD}"`)).toBeVisible();
    await expect(theRow.getByText(`Possible duplicate of "${WHITFIELD}"`)).toBeVisible();

    // Merge "The …" into the plain spelling: row gone, alias listed.
    await theRow.getByRole("button", { name: `Merge into "${WHITFIELD}"` }).click();
    await expect(plainRow.getByText("Also known as")).toBeVisible();
    await expect(plainRow.getByText(THE_WHITFIELD, { exact: true })).toBeVisible();
    await expect(theRow).toHaveCount(0);
    await expect(panel.getByText(/Possible duplicate of/)).toHaveCount(0);
    const afterMerge = (await (await page.request.get("/api/ideas/lists/customers")).json()) as {
      items: { name: string; aliases: string[] }[];
    };
    expect(afterMerge.items.map((i) => i.name)).not.toContain(THE_WHITFIELD);
    expect(afterMerge.items.find((i) => i.name === WHITFIELD)?.aliases).toEqual([THE_WHITFIELD]);

    // × on the alias splits it back out into its own row (duplicate hint returns).
    await plainRow.getByRole("button", { name: `Split out ${THE_WHITFIELD}` }).click();
    await expect(theRow).toBeVisible();
    await expect(plainRow.getByText("Also known as")).toHaveCount(0);
    await expect(theRow.getByText(`Possible duplicate of "${WHITFIELD}"`)).toBeVisible();
    await expect(plainRow.getByText(`Possible duplicate of "${THE_WHITFIELD}"`)).toBeVisible();
    const afterSplit = (await (await page.request.get("/api/ideas/lists/customers")).json()) as {
      items: { name: string; aliases: string[] }[];
    };
    expect(afterSplit.items.map((i) => i.name)).toContain(THE_WHITFIELD);
    expect(afterSplit.items.find((i) => i.name === WHITFIELD)?.aliases).toEqual([]);
  });

  test("UF3 idea drawer edit: add a customer by Enter, remove a ticket-derived one, toggle a product line, Save reflects all three", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);
    await ideaRow(page, NEW_TITLE).click();
    const drawer = drawerOf(page);
    await expect(drawer.getByRole("heading", { name: NEW_TITLE })).toBeVisible();
    // Starting point: the cataloged ticket customer, no product line yet.
    await expect(drawer.getByText(CATALOGED, { exact: true })).toBeVisible();
    await expect(drawer.getByText(PRODUCT_LINE, { exact: true })).toHaveCount(0);

    await drawer.getByRole("button", { name: "Edit", exact: true }).click();

    // While editing, the header keeps showing the SAVED chips — the edit
    // list is the "Customers" section below, so scope to it.
    // (`has` resolves relative to the outer element, so the inner locator
    // must be page-rooted, not drawer-rooted.)
    const customersEdit = drawer
      .locator("div.flex.flex-col")
      .filter({ has: page.getByText("Customers", { exact: true }) })
      .last();
    await expect(customersEdit.getByPlaceholder("Add customer…")).toBeVisible();

    // Add by typing + Enter.
    const input = customersEdit.getByPlaceholder("Add customer…");
    await input.fill(ADDED);
    await input.press("Enter");
    await expect(customersEdit.getByText(ADDED, { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");

    // Remove the ticket-derived customer from this idea.
    await customersEdit
      .getByText(CATALOGED, { exact: true })
      .getByTitle("Remove from this idea")
      .click();
    await expect(customersEdit.getByText(CATALOGED, { exact: true })).toHaveCount(0);
    await expect(customersEdit.getByText(ADDED, { exact: true })).toBeVisible();

    // Toggle the product-line chip on.
    const lineChip = drawer.getByRole("button", { name: PRODUCT_LINE, exact: true });
    await expect(lineChip).toHaveAttribute("aria-pressed", "false");
    await lineChip.click();
    await expect(lineChip).toHaveAttribute("aria-pressed", "true");

    const saved = page.waitForResponse(
      (r) => r.url().includes("/api/ideas/mutate") && r.request().method() === "POST"
    );
    await drawer.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);

    // View mode again: product line chip, the added name as a suggestion
    // (off-catalog), the removed name gone from the chips…
    await expect(drawer.getByRole("heading", { name: NEW_TITLE })).toBeVisible();
    await expect(drawer.getByText(PRODUCT_LINE, { exact: true })).toBeVisible();
    await expect(
      drawer.locator(`span[title="${SUGGESTED_TITLE}"]`, { hasText: ADDED })
    ).toBeVisible();
    await expect(drawer.getByText(CATALOGED, { exact: true })).toHaveCount(0);
    // …and reachable under the dismissed toggle (a dismissal, not a deletion).
    const toggle = drawer.getByRole("button", { name: /1 dismissed customer/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(drawer.locator("span.line-through", { hasText: CATALOGED })).toBeVisible();

    // The list row carries the same chips.
    const row = ideaRow(page, NEW_TITLE);
    await expect(row.getByText(PRODUCT_LINE, { exact: true })).toBeVisible();
    await expect(row.getByText(`${ADDED} ⚑`)).toBeVisible();
    await expect(row.getByText(CATALOGED, { exact: true })).toHaveCount(0);

    // Persisted the way the model says: products + addedCustomers on the
    // idea, the removal as a dismissal on the ticket, an edit on the ledger.
    await withTestDb(async (db) => {
      const idea = await db.idea.findUniqueOrThrow({ where: { id: newIdeaId } });
      expect(idea.products as string[]).toContain(PRODUCT_LINE);
      expect(idea.addedCustomers as string[]).toEqual([ADDED]);
      const ticket = await db.zendeskTicketRaw.findUniqueOrThrow({ where: { id: ticketDbId } });
      expect(ticket.affectedCustomers as string[]).toEqual([CATALOGED]);
      expect(ticket.dismissedCustomers as string[]).toEqual([CATALOGED]);
      const edits = await db.reviewEvent.count({
        where: { workspaceId, ideaId: newIdeaId, action: "edit" },
      });
      expect(edits).toBeGreaterThan(0);
    });
  });

  test("UF4 Admin → Ideas: Import runs card, empty state + { runs: [] } for a fresh org, a batch shows after Refresh, API hidden from non-admins", async ({
    page,
    browser,
  }) => {
    // Two logins of different users (admin here, a plain user below) — each
    // may wait for TOTP window headroom.
    test.setTimeout(120_000);

    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/ideas");
    const runsCard = page.locator("section", {
      has: page.getByRole("heading", { name: "Import runs" }),
    });
    await expect(runsCard).toBeVisible();
    // Hydration anchor: the first org's runs (rows or the empty text) come
    // from a client fetch, so once they show, React owns the <select>.
    // Changing it earlier is a raw DOM change React never sees.
    await expect(
      runsCard.locator("tbody tr").or(runsCard.getByText("No imports yet for this organization.")).first()
    ).toBeVisible();

    // The fresh org: empty state in the card, empty list from the API.
    await page.locator("select").first().selectOption({ label: `${FRESH_ORG.name} (${FRESH_ORG.slug})` });
    await expect(runsCard.getByText("No imports yet for this organization.")).toBeVisible();
    const empty = await page.request.get(`/api/admin/organizations/${freshOrgId}/ideas-runs`);
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual({ runs: [] });

    // Positive control: a completed batch appears after Refresh.
    const freshWorkspace = await withTestDb((db) =>
      db.workspace.findUniqueOrThrow({ where: { organizationId: freshOrgId } })
    );
    const started = new Date(Date.now() - 90_000);
    await withTestDb((db) =>
      db.ideaBatch.create({
        data: {
          workspaceId: freshWorkspace.id,
          startedAt: started,
          completedAt: new Date(started.getTime() + 42_000),
          heartbeatAt: new Date(started.getTime() + 42_000),
          status: "completed",
          stats: { imported: 3, frs: 2, matched: 1, split: 0, bugs: 0, needsDetails: 0 },
        },
      })
    );
    await runsCard.getByRole("button", { name: "Refresh" }).click();
    await expect(runsCard.getByText("Completed", { exact: true })).toBeVisible();
    await expect(runsCard.getByText("2 FRs · 1 merged · 0 split · 0 parked")).toBeVisible();
    await expect(runsCard.getByText("No imports yet for this organization.")).toHaveCount(0);
    const one = (await (
      await page.request.get(`/api/admin/organizations/${freshOrgId}/ideas-runs`)
    ).json()) as { runs: { status: string; durationMs: number }[] };
    expect(one.runs).toHaveLength(1);
    expect(one.runs[0].status).toBe("completed");
    expect(one.runs[0].durationMs).toBe(42_000);

    // Not signed in → 401. Signed in as a plain USER → 404 (admin existence
    // is not advertised; see src/lib/admin-auth.ts apiAdmin).
    const anon = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    try {
      const res = await anon.request.get(`/api/admin/organizations/${freshOrgId}/ideas-runs`);
      expect(res.status()).toBe(401);
    } finally {
      await anon.close();
    }
    const userCtx = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    try {
      const userPage = await userCtx.newPage();
      await loginAsRoomLens(userPage);
      const res = await userPage.request.get(
        `/api/admin/organizations/${freshOrgId}/ideas-runs`
      );
      expect(res.status()).toBe(404);
    } finally {
      await userCtx.close();
    }
  });
});
