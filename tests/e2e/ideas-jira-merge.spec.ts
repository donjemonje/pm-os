import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { loginAsRoomLens } from "./helpers";
import { RESOLVED_ENV } from "./test-env";

/**
 * Ideas ↔ Jira match stage (feature/ideas-jira-merge):
 * - The Jira backlog re-enters each batch as Unchanged ideas. They need no
 *   review, so the Final page hides them unless the Unchanged chip is active,
 *   and the Import Status chips are single-select (a click replaces the
 *   selection; clicking the active chip clears it).
 * - Unchanged (and Deleted) ideas are approval-exempt: no approve controls
 *   render for them, and the server refuses decision "reviewed" outright.
 * - The Merge view chips are Merge/Single/Unchanged: unchanged ideas and the
 *   Jira sources backing only unchanged ideas hide under Merge/Single and
 *   show under Unchanged; edit mode always shows the full source pool.
 * - A manual reassign on the merge page recomputes status and votes: adding
 *   ticket evidence to a Jira-origin idea flips it to Updated and moves
 *   newVotes by the zendesk-source delta; removing it flips it back.
 *
 * The import path itself calls the Vertex LLM (catalog + match), so nothing
 * here imports a CSV. Fixtures are seeded with Prisma exactly as the import
 * would have written them: JiraIdeaSnapshot rows + Jira-origin ideas linked
 * by jiraKey, ZendeskTicketRaw rows + zendesk IdeaSources. Everything the
 * tests exercise (chips, visibility, decision + reassign mutations) is
 * LLM-free.
 *
 * Ideas gating: same pattern as customer-reporters.spec.ts — the env guard
 * pins IDEAS_ENABLED off, so beforeAll sets the RoomLens per-org override
 * {ideas: true} and afterAll clears it (all-pages.spec.ts depends on the
 * default).
 *
 * State discipline: beforeAll deletes and recreates every fixture row (all
 * ids carry a QA-JM prefix), afterAll deletes them. JM2 restores the decision
 * it flips and JM4 reverses its own reassign, so no test depends on another
 * having run. All tests write data.
 */

const ROOMLENS_SLUG = "roomlens";

// Fixture names — synthetic, obviously QA, mutually non-substring.
const NEW_TITLE = "QA-JM scheduled exports";
const UNCHANGED_A_TITLE = "QA-JM backlog alpha";
const UNCHANGED_B_TITLE = "QA-JM backlog beta";
const UPDATED_TITLE = "QA-JM updated gamma";
const TICKET_PREFIX = "QA-JM-T";
const JIRA_PREFIX = "QA-JM-J";
const JIRA_A = `${JIRA_PREFIX}1`; // backs unchanged alpha only
const JIRA_B = `${JIRA_PREFIX}2`; // backs unchanged beta only
const JIRA_C = `${JIRA_PREFIX}3`; // backs the updated idea
const TICKET_ORPHAN_SUBJECT = "QA-JM orphan ticket for reassign";

const ALL_TITLES = [NEW_TITLE, UNCHANGED_A_TITLE, UNCHANGED_B_TITLE, UPDATED_TITLE];

let workspaceId: string;
let newId: string;
let unchangedAId: string;
let unchangedBId: string;

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

/** Delete every fixture row this spec ever creates (idempotent). IdeaSources
 * and ReviewEvents cascade with their Idea. */
async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { workspaceId, title: { in: ALL_TITLES } } });
  await db.zendeskTicketRaw.deleteMany({
    where: { workspaceId, externalId: { startsWith: TICKET_PREFIX } },
  });
  await db.jiraIdeaSnapshot.deleteMany({
    where: { workspaceId, key: { startsWith: JIRA_PREFIX } },
  });
}

test.describe("Ideas — Jira match stage (unchanged handling + reassign)", () => {
  test.beforeAll(async () => {
    await withDb(async (db) => {
      const org = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `ideas-jira-merge spec could not reach the QA org — did you run ` +
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

      await deleteFixtures(db);

      // Tickets exactly as the import stage persists them. t1 backs the New
      // idea, t2 is unassigned (JM4 attaches it), t3 backs the Updated idea.
      const t1 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}1`,
          subject: "Scheduled exports please",
          body: "QA fixture ticket — run exports on a schedule.",
          requester: "Rivka Stern (QA)",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}2`,
          subject: TICKET_ORPHAN_SUBJECT,
          body: "QA fixture ticket — evidence to attach by hand in JM4.",
          requester: "Avi Peretz (QA)",
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
          subject: "Watermark presets again",
          body: "QA fixture ticket — matched to the Jira backlog last import.",
          requester: "Avi Peretz (QA)",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });

      // Jira live-state snapshots — what a connected import would have synced.
      for (const [key, title] of [
        [JIRA_A, UNCHANGED_A_TITLE],
        [JIRA_B, UNCHANGED_B_TITLE],
        [JIRA_C, UPDATED_TITLE],
      ] as const) {
        await db.jiraIdeaSnapshot.create({
          data: { workspaceId, key, title, body: "QA fixture Jira idea.", components: [] },
        });
      }

      // One idea per batch state the feature branches on.
      newId = (
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
      unchangedAId = (
        await db.idea.create({
          data: {
            workspaceId,
            title: UNCHANGED_A_TITLE,
            details: "QA fixture idea — untouched Jira backlog.",
            products: ["Other"],
            batchStatus: "unchanged",
            decision: "pending",
            origin: "jira",
            existingVotes: 2,
            sources: { create: [{ kind: "jira", jiraKey: JIRA_A }] },
          },
        })
      ).id;
      unchangedBId = (
        await db.idea.create({
          data: {
            workspaceId,
            title: UNCHANGED_B_TITLE,
            details: "QA fixture idea — untouched Jira backlog, JM4's target.",
            products: ["Other"],
            batchStatus: "unchanged",
            decision: "pending",
            origin: "jira",
            existingVotes: 3,
            sources: { create: [{ kind: "jira", jiraKey: JIRA_B }] },
          },
        })
      ).id;
      await db.idea.create({
        data: {
          workspaceId,
          title: UPDATED_TITLE,
          details: "QA fixture idea — matched an FR last import.",
          products: ["Other"],
          batchStatus: "updated",
          decision: "pending",
          origin: "jira",
          existingVotes: 2,
          newVotes: 1,
          sources: {
            create: [
              { kind: "jira", jiraKey: JIRA_C },
              { kind: "zendesk", ticketId: t3.id },
            ],
          },
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

  /** An idea row on the Final page (the only cursor-pointer divs there). */
  function ideaRow(page: Page, title: string) {
    return page.locator("div.cursor-pointer", { hasText: title });
  }

  /** The Import Status filter row — scopes the chips away from the identically
   * named "Merge" page-toggle button. */
  function statusRow(page: Page) {
    return page
      .locator("div.flex.flex-wrap.items-start.gap-2")
      .filter({ has: page.getByText("Import Status", { exact: true }) });
  }

  function chip(page: Page, label: string) {
    return statusRow(page).getByRole("button", { name: label, exact: true });
  }

  /** A merge-board column, scoped by its "<Label> · N" header. */
  function mergeColumn(page: Page, label: "Zendesk" | "Jira" | "Final") {
    return page
      .locator("div.overflow-hidden.rounded-xl")
      .filter({ has: page.getByText(new RegExp(`^${label} · \\d+$`)) });
  }

  /** The page-toggle (Merge ⇄ Final) buttons above the board. */
  function pageToggle(page: Page, label: "Merge" | "Final") {
    return page.locator("button.font-title").filter({ hasText: new RegExp(`^${label}$`) });
  }

  async function gotoIdeas(page: Page) {
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    // Positive anchor before any absence assert: the state fetch has landed.
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
  }

  async function ideaFromDb(id: string) {
    return withDb((db) => db.idea.findUniqueOrThrow({ where: { id } }));
  }

  test("JM1 Final page: unchanged hidden by default, Unchanged chip reveals them, chips are single-select", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);

    // Default view: new + updated visible, unchanged nowhere.
    await expect(ideaRow(page, UPDATED_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_A_TITLE)).toHaveCount(0);
    await expect(ideaRow(page, UNCHANGED_B_TITLE)).toHaveCount(0);

    // Unchanged chip: only the unchanged backlog shows.
    await chip(page, "Unchanged").click();
    await expect(ideaRow(page, UNCHANGED_A_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_B_TITLE)).toBeVisible();
    await expect(ideaRow(page, NEW_TITLE)).toHaveCount(0);
    await expect(ideaRow(page, UPDATED_TITLE)).toHaveCount(0);

    // Single-select: clicking New REPLACES Unchanged (were the chips
    // additive, the unchanged rows would still be here).
    await chip(page, "New").click();
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_A_TITLE)).toHaveCount(0);
    await expect(ideaRow(page, UPDATED_TITLE)).toHaveCount(0);

    // Clicking the active chip clears the selection → default view again.
    await chip(page, "New").click();
    await expect(ideaRow(page, UPDATED_TITLE)).toBeVisible();
    await expect(ideaRow(page, NEW_TITLE)).toBeVisible();
    await expect(ideaRow(page, UNCHANGED_A_TITLE)).toHaveCount(0);
  });

  test("JM2 unchanged ideas have no approve controls and the server refuses approving them", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);

    // Positive control: hovering an approvable row shows the approve mark.
    await ideaRow(page, NEW_TITLE).hover();
    await expect(page.getByTitle("Mark reviewed")).toBeVisible();

    // The unchanged row (via its chip) never grows the mark on hover.
    await chip(page, "Unchanged").click();
    const rowA = ideaRow(page, UNCHANGED_A_TITLE);
    await expect(rowA).toBeVisible();
    await rowA.hover();
    await expect(page.getByTitle("Mark reviewed")).toHaveCount(0);

    // Its drawer has no Approve button either (Merge/Edit still render).
    await rowA.click();
    const drawer = page.locator("div.fixed.bottom-0.right-0.top-0");
    await expect(drawer.getByRole("heading", { name: UNCHANGED_A_TITLE })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^Approved?$/ })).toHaveCount(0);

    // Belt and braces: the API itself refuses decision "reviewed" for an
    // approval-exempt idea — same session, straight to the mutate endpoint.
    const refused = await page.request.post("/api/ideas/mutate", {
      data: { type: "decision", ideaId: unchangedAId, decision: "reviewed" },
    });
    expect(refused.status()).toBe(200);
    const { state } = (await refused.json()) as {
      state: { ideas: { id: string; decision: string }[] };
    };
    expect(state.ideas.find((i) => i.id === unchangedAId)?.decision).toBe("pending");
    expect((await ideaFromDb(unchangedAId)).decision).toBe("pending");

    // Positive control on the same endpoint: the New idea DOES flip…
    const flipped = await page.request.post("/api/ideas/mutate", {
      data: { type: "decision", ideaId: newId, decision: "reviewed" },
    });
    expect(flipped.status()).toBe(200);
    expect((await ideaFromDb(newId)).decision).toBe("reviewed");
    // …and is restored so no other test inherits the flip.
    await page.request.post("/api/ideas/mutate", {
      data: { type: "decision", ideaId: newId, decision: "pending" },
    });
    expect((await ideaFromDb(newId)).decision).toBe("pending");
  });

  test("JM3 merge view: unchanged ideas and their Jira sources hide under Merge, show under Unchanged, edit shows the full pool", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);

    // Entering the merge view auto-starts an edit → the full Jira pool shows,
    // including sources that back only unchanged ideas.
    await pageToggle(page, "Merge").click();
    const jiraCol = mergeColumn(page, "Jira");
    const finalCol = mergeColumn(page, "Final");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(jiraCol.getByRole("button", { name: JIRA_A })).toBeVisible();

    // Out of edit mode, under the Merge chip: multi-source ideas only; the
    // unchanged backlog and its Jira keys are gone.
    await page.getByRole("button", { name: "Cancel" }).click();
    await chip(page, "Merge").click();
    await expect(finalCol.getByText(UPDATED_TITLE)).toBeVisible();
    await expect(jiraCol.getByRole("button", { name: JIRA_C })).toBeVisible();
    await expect(finalCol.getByText(UNCHANGED_A_TITLE)).toHaveCount(0);
    await expect(finalCol.getByText(UNCHANGED_B_TITLE)).toHaveCount(0);
    await expect(jiraCol.getByRole("button", { name: JIRA_A })).toHaveCount(0);
    await expect(jiraCol.getByRole("button", { name: JIRA_B })).toHaveCount(0);

    // Under the Unchanged chip both come back.
    await chip(page, "Unchanged").click();
    await expect(finalCol.getByText(UNCHANGED_A_TITLE)).toBeVisible();
    await expect(finalCol.getByText(UNCHANGED_B_TITLE)).toBeVisible();
    await expect(jiraCol.getByRole("button", { name: JIRA_A })).toBeVisible();
    await expect(jiraCol.getByRole("button", { name: JIRA_B })).toBeVisible();
    await expect(finalCol.getByText(UPDATED_TITLE)).toHaveCount(0);
  });

  test("JM4 merge reassign: attaching a ticket flips an unchanged Jira idea to Updated with a vote delta; detaching flips it back", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await gotoIdeas(page);
    await pageToggle(page, "Merge").click();
    await page.getByRole("button", { name: "Cancel" }).click(); // leave the auto-started edit

    const zenCol = mergeColumn(page, "Zendesk");
    const finalCol = mergeColumn(page, "Final");
    const orphanRow = zenCol.locator("div.cursor-pointer", { hasText: TICKET_ORPHAN_SUBJECT });
    const targetRow = finalCol.locator("div.cursor-pointer", { hasText: UNCHANGED_B_TITLE });

    // Start editing the unchanged Jira idea (visible only under its chip)
    // and attach the orphan ticket as evidence.
    await chip(page, "Unchanged").click();
    await targetRow.click();
    await expect(page.getByText("1 source selected")).toBeVisible();
    await orphanRow.click();
    await expect(page.getByText("2 sources selected")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();

    // Saved: now Updated, so it left the Unchanged listing and shows under
    // Merge with both sources.
    await expect(targetRow).toHaveCount(0);
    await chip(page, "Merge").click();
    await expect(finalCol.getByText(UNCHANGED_B_TITLE)).toBeVisible();
    await expect(
      finalCol
        .locator("div.cursor-pointer", { hasText: UNCHANGED_B_TITLE })
        .getByRole("button", { name: "2 src" })
    ).toBeVisible();

    // The Final page now shows it by default with the Updated badge and the
    // manual vote delta: 3 existing (+1 this batch).
    await pageToggle(page, "Final").click();
    const row = ideaRow(page, UNCHANGED_B_TITLE);
    await expect(row).toBeVisible();
    await expect(row.getByText("Updated", { exact: true })).toBeVisible();
    await expect(row.getByText("(+1)")).toBeVisible();
    const afterAttach = await ideaFromDb(unchangedBId);
    expect(afterAttach.batchStatus).toBe("updated");
    expect(afterAttach.newVotes).toBe(1);
    expect(afterAttach.existingVotes).toBe(3);

    // Reverse it: detach the ticket → back to Unchanged, delta gone.
    await pageToggle(page, "Merge").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await chip(page, "Merge").click();
    await finalCol.locator("div.cursor-pointer", { hasText: UNCHANGED_B_TITLE }).click();
    await expect(page.getByText("2 sources selected")).toBeVisible();
    await orphanRow.click();
    await expect(page.getByText("1 source selected")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();

    // Unchanged again: hidden under the Merge chip, and both the vote delta
    // and status rolled back in the DB.
    await expect(finalCol.getByText(UNCHANGED_B_TITLE)).toHaveCount(0);
    const afterDetach = await ideaFromDb(unchangedBId);
    expect(afterDetach.batchStatus).toBe("unchanged");
    expect(afterDetach.newVotes).toBe(0);
    expect(afterDetach.existingVotes).toBe(3);
  });
});
