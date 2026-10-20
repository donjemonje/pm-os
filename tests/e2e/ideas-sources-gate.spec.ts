/**
 * Sources-changed gate + New idea from scratch — release QA 4.0.0 version
 * tests (MRG-07, REV-22). Feature: feature/fixes_for_ideas_usage_by_kela.
 *
 * MRG-07 a PM edits an idea's sources (reassign) → the idea is flagged
 *        sourcesChanged with a "Sources edited by a PM" narration; approving
 *        it is refused by the API and the drawer's Approve is disabled with
 *        the reason; the drawer offers "Rewrite with PMOS AI" and "Keep
 *        text"; Keep text clears the flag (keep_text event) and approval
 *        goes through. The Rewrite path is a live model call (@ai) and is
 *        not exercised here. Also REV-21's outer step: Esc on the drawer
 *        with nothing inner open closes it.
 * REV-22 "New idea" on the Final page: title + at least one product line are
 *        mandatory (Create idea disabled until both), the created idea has
 *        origin "manual", the picked product line and the typed text, and
 *        shows in the list. Create-idea-from-ticket is @ai (not here).
 *
 * State: RoomLens {ideas: true} for the run, {} after; QA-SG fixtures are
 * delete-and-recreate + cleanup.
 */
import { expect, test, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, withTestDb } from "./helpers";

const ROOMLENS_SLUG = "roomlens";
const LINE = "QA-SG Line";
const IDEA = "QA-SG idea written by PMOS AI";
const MANUAL = "QA-SG manual idea";
const T1 = "QA-SG-T1";
const T2 = "QA-SG-T2";

let orgId: string;
let workspaceId: string;
let ideaId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { workspaceId, title: { startsWith: "QA-SG " } } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId, externalId: { startsWith: "QA-SG-" } } });
  await db.productLine.deleteMany({ where: { workspaceId, name: LINE } });
}

function ideaRow(page: Page, title: string) {
  return page.locator("div.cursor-pointer", { hasText: title });
}
function drawerOf(page: Page) {
  return page.locator("div.fixed.bottom-0.right-0.top-0");
}
function pageToggle(page: Page, label: "Merge" | "Final") {
  return page.locator("button.font-title").filter({ hasText: new RegExp(`^${label}$`) });
}

test.describe("Sources-changed gate and New idea (MRG-07, REV-22)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization.findUniqueOrThrow({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } });
      orgId = org.id;
      workspaceId = org.workspace!.id;
      await db.organization.update({ where: { id: orgId }, data: { features: { ideas: true } } });
      await deleteFixtures(db);
      await db.productLine.create({ data: { workspaceId, name: LINE, description: "QA fixture line", color: "indigo" } });
      const tickets = [];
      for (const [externalId, subject] of [[T1, "QA-SG export on a schedule"], [T2, "QA-SG export every night"]] as const) {
        tickets.push(
          await db.zendeskTicketRaw.create({
            data: {
              workspaceId, externalId, subject, body: `${subject} — QA fixture body.`, requester: "QA (fixture)",
              affectedCustomers: [], tags: ["qa-fixture"], raw: {}, catalogKind: "fr", catalogReason: "QA fixture verdict",
            },
          }),
        );
      }
      ideaId = (
        await db.idea.create({
          data: {
            workspaceId, title: IDEA, details: "QA fixture idea text written from one ticket.", products: [LINE],
            batchStatus: "new", decision: "pending", origin: "zendesk", newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: tickets[0].id }] },
          },
        })
      ).id;
    });
  });
  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await db.organization.update({ where: { id: orgId }, data: { features: {} } });
    });
  });

  test("MRG-07 edited sources flag the idea, block approval until Keep text, then approval goes through", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsRoomLens(page);
    const ideaFromDb = () => withTestDb((db) => db.idea.findUniqueOrThrow({ where: { id: ideaId } }));

    // A PM attaches a second ticket → flagged + narrated.
    const reassign = await page.request.post("/api/ideas/mutate", { data: { type: "reassign", ideaId, zen: [T1, T2], jira: [] } });
    expect(reassign.status(), await reassign.text()).toBe(200);
    let row = await ideaFromDb();
    expect(row.sourcesChanged).toBe(true);
    expect(row.batchChanges as string[]).toContain("Sources edited by a PM: +1");

    // Approval refused by the API while flagged.
    const approve = await page.request.post("/api/ideas/mutate", { data: { type: "decision", ideaId, decision: "reviewed" } });
    expect(approve.status()).toBe(502);
    expect((await approve.json()).error).toContain("Sources changed since PMOS AI wrote this idea");
    expect((await ideaFromDb()).decision).toBe("pending");

    // Drawer: the block with both choices, Approve disabled with the reason.
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    await pageToggle(page, "Final").click();
    await expect(ideaRow(page, IDEA)).toBeVisible();
    await expect(ideaRow(page, IDEA).getByTitle("Sources changed by a PM — rewrite or keep the text before approving")).toBeVisible();
    await ideaRow(page, IDEA).click();
    const drawer = drawerOf(page);
    await expect(drawer.getByText("Sources changed", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Rewrite with PMOS AI" })).toBeVisible();
    const approveBtn = drawer.getByRole("button", { name: "Approve", exact: true });
    await expect(approveBtn).toBeDisabled();
    await expect(approveBtn).toHaveAttribute("title", "Sources changed — rewrite the idea or keep the text first");

    // Keep text: flag cleared, event logged, Approve usable.
    await drawer.getByRole("button", { name: "Keep text" }).click();
    await expect(drawer.getByText("Sources changed", { exact: true })).toHaveCount(0);
    row = await ideaFromDb();
    expect(row.sourcesChanged).toBe(false);
    expect(row.details).toBe("QA fixture idea text written from one ticket.");
    expect(await withTestDb((db) => db.reviewEvent.count({ where: { ideaId, action: "keep_text" } }))).toBe(1);
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();
    await expect(drawer.getByRole("button", { name: "Approved", exact: true })).toBeVisible();
    expect((await ideaFromDb()).decision).toBe("reviewed");

    // REV-21 (extension): Esc with nothing inner open closes the drawer.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });

  test("REV-22 New idea from scratch: title + product line mandatory, created as manual with the typed text", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsRoomLens(page);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    await pageToggle(page, "Final").click();
    await page.getByRole("button", { name: "New idea" }).click();

    const create = page.getByRole("button", { name: "Create idea" });
    await expect(create).toBeDisabled();
    await page.getByRole("textbox", { name: "Idea title" }).fill(MANUAL);
    await expect(create, "a title alone is not enough").toBeDisabled();
    await expect(page.getByText("Pick at least one product line.")).toBeVisible();
    await page.getByRole("button", { name: LINE, exact: true }).click();
    await expect(create).toBeEnabled();
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.click();
    await editor.pressSequentially("QA-SG typed by a PM.");
    await create.click();

    await expect(ideaRow(page, MANUAL)).toBeVisible();
    const created = await withTestDb((db) => db.idea.findFirstOrThrow({ where: { workspaceId, title: MANUAL } }));
    expect(created.origin).toBe("manual");
    expect(created.products as string[]).toContain(LINE);
    expect(created.details).toContain("QA-SG typed by a PM.");
    expect(created.decision).toBe("pending");
  });
});
