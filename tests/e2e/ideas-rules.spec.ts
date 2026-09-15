import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginAsRoomLensAdmin, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

/**
 * Ideas rules that live below the list UI (release QA 2.0.0, inventory
 * SET-01 / IMP-07 / MRG-04). Written against origin/development 22b1799;
 * feature/face_lift_v2 restyles the Ideas Board — none of these assert on it.
 *
 * SET-01 product lines are the AI's ground truth: a PM-OS admin can add /
 *        rename / delete through /api/ideas/lists/product-lines, a duplicate
 *        name (case-insensitive) is a 409, a plain USER may read the list and
 *        pick a chip color but every other write is a 403; the settings page
 *        lists the line while it exists and drops it after the delete.
 * IMP-07 bad input never reaches PMOS AI: an empty file, a CSV without
 *        subject/description columns, a text file renamed .csv and a
 *        subject-only view export each show a clear error in the UI, create
 *        no batch row and write no ledger row.
 * MRG-04 all-evidence votes rule: every zendesk source and every merged Jira
 *        source counts, a jira-origin idea's own issue does not, and an idea
 *        already consolidated by a push (existingVotes > 0) is left alone.
 *        Proven two ways on the same rows — through the product's reassign
 *        path (the app's rule) and by running the exact one-time recompute
 *        SQL from office/versions_prod_changes.md (the prod rule) and
 *        checking it changes nothing the app already computed.
 *
 * State: RoomLens gets the per-org {ideas: true} override in beforeAll and
 * {} back in afterAll (customer-reporters pattern); QA-SET / QA-IMP7 /
 * QA-MRG fixtures are delete-and-recreate + afterAll cleanup.
 */

const ROOMLENS_SLUG = "roomlens";
const SET_LINE = "QA-SET Line";
const SET_RENAMED = "QA-SET Line renamed";
const MRG = {
  jiraIdea: "QA-MRG jira-origin idea", zenIdea: "QA-MRG zendesk-origin idea", consolidated: "QA-MRG consolidated idea",
  tickets: ["QA-MRG-T1", "QA-MRG-T2", "QA-MRG-T3"], ownJira: "QA-MRG-J-SELF", otherJira: "QA-MRG-J-OTHER", thirdJira: "QA-MRG-J-THIRD",
};

// Verbatim from office/versions_prod_changes.md (ui_facelift_v1 all-evidence votes).
const PROD_RECOMPUTE_SQL = `UPDATE "Idea" i SET "newVotes" = sub.evidence FROM (SELECT i2.id, (SELECT count(*) FROM "IdeaSource" s WHERE s."ideaId"=i2.id AND s.kind='zendesk') + GREATEST(0, (SELECT count(*) FROM "IdeaSource" s WHERE s."ideaId"=i2.id AND s.kind='jira') - CASE WHEN i2.origin='jira' THEN 1 ELSE 0 END) AS evidence FROM "Idea" i2) sub WHERE i.id = sub.id AND i."existingVotes" = 0 AND i."batchStatus" <> 'deleted' AND i."newVotes" <> sub.evidence;`;

let orgId: string;
let workspaceId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.productLine.deleteMany({ where: { workspaceId, name: { startsWith: "QA-SET " } } });
  await db.idea.deleteMany({ where: { workspaceId, title: { startsWith: "QA-MRG " } } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId, externalId: { startsWith: "QA-MRG-" } } });
}

test.describe("Ideas rules: product lines authz, bad CSV input, all-evidence votes (SET-01, IMP-07, MRG-04)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization.findUniqueOrThrow({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } });
      orgId = org.id;
      workspaceId = org.workspace!.id;
      await db.organization.update({ where: { id: orgId }, data: { features: { ideas: true } } });
      await deleteFixtures(db);
    });
  });
  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteFixtures(db);
      await db.organization.update({ where: { id: orgId }, data: { features: {} } });
    });
  });

  test("SET-01 product lines: admin CRUD with duplicate rejection; USER reads and colors only; settings page follows", async ({
    page,
    browser,
  }) => {
    // Two TOTP logins (admin + user).
    test.setTimeout(120_000);
    const LIST = "/api/ideas/lists/product-lines";

    await loginAsRoomLensAdmin(page);
    const add = await page.request.post(LIST, { data: { name: SET_LINE, description: "QA-SET fixture" } });
    expect(add.status(), await add.text()).toBe(200);
    const created = ((await add.json()).items as { id: string; name: string }[]).find((i) => i.name === SET_LINE);
    expect(created).toBeTruthy();
    const dup = await page.request.post(LIST, { data: { name: SET_LINE.toLowerCase() } });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error).toContain("already exists");

    await page.goto("/settings/ideas/product-lines");
    await expect(page.getByText(SET_LINE, { exact: true })).toBeVisible();

    const rename = await page.request.patch(LIST, { data: { id: created!.id, name: SET_RENAMED, description: "renamed" } });
    expect(rename.status(), await rename.text()).toBe(200);
    expect(await withTestDb((db) => db.productLine.findUnique({ where: { id: created!.id } }))).toMatchObject({
      name: SET_RENAMED, description: "renamed",
    });

    // A plain USER: read + chip color allowed, every other write refused.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const user = await userContext.newPage();
    try {
      await loginAsRoomLens(user);
      const list = await user.request.get(LIST);
      expect(list.status()).toBe(200);
      expect(((await list.json()).items as { name: string }[]).map((i) => i.name)).toContain(SET_RENAMED);
      const color = await user.request.patch(LIST, { data: { id: created!.id, color: "teal" } });
      expect(color.status(), "color pick is presentation, allowed").toBe(200);
      for (const [method, data] of [
        ["post", { name: "QA-SET user line" }],
        ["patch", { id: created!.id, name: "QA-SET user rename" }],
        ["delete", { id: created!.id }],
        ["put", { order: [created!.id] }],
      ] as const) {
        const res = await user.request.fetch(LIST, { method: method.toUpperCase(), data });
        expect(res.status(), `USER ${method}`).toBe(403);
        expect((await res.json()).error).toBe("Only a PM-OS admin can change product lines");
      }
      expect((await withTestDb((db) => db.productLine.findUniqueOrThrow({ where: { id: created!.id } }))).name).toBe(SET_RENAMED);
    } finally {
      await userContext.close();
    }

    const del = await page.request.delete(LIST, { data: { id: created!.id } });
    expect(del.status()).toBe(200);
    expect(await withTestDb((db) => db.productLine.findUnique({ where: { id: created!.id } }))).toBeNull();
    const again = await page.request.delete(LIST, { data: { id: created!.id } });
    expect(again.status()).toBe(404);
    await page.goto("/settings/ideas/product-lines");
    await expect(page.getByRole("heading", { name: /product lines/i })).toBeVisible();
    await expect(page.getByText(SET_RENAMED, { exact: true })).toHaveCount(0);
  });

  test("IMP-07 bad CSV input shows a clear error, creates no batch and calls no AI", async ({ page }) => {
    await loginAsRoomLens(page);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    const counts = () =>
      withTestDb(async (db) => ({
        batches: await db.ideaBatch.count({ where: { workspaceId } }),
        ledger: await db.ledgerEntry.count({ where: { workspaceId } }),
      }));
    const before = await counts();

    const cases: { name: string; body: string; error: RegExp }[] = [
      { name: "empty.csv", body: "", error: /CSV has no data rows\./ },
      { name: "no-columns.csv", body: "id,foo,bar\n1,2,3\n", error: /Couldn't find a subject or description column/ },
      { name: "notes.csv", body: "Meeting notes\nTalked about boards\nNext steps: follow up\n", error: /Couldn't find a subject or description column/ },
      { name: "view-export.csv", body: "external_id,subject\n1,Hello there\n", error: /No description column found/ },
    ];
    for (const c of cases) {
      await page.locator('input[type="file"]').setInputFiles({ name: c.name, mimeType: "text/csv", buffer: Buffer.from(c.body) });
      await expect(page.getByText(c.error), c.name).toBeVisible();
      await expect(page.getByRole("button", { name: "Importing…" })).toHaveCount(0);
    }
    expect(await counts()).toEqual(before);
  });

  test("MRG-04 all-evidence votes: app reassign rule and the prod recompute SQL agree; consolidated ideas untouched", async ({ page }) => {
    const ids = await withTestDb(async (db) => {
      const tickets = await Promise.all(
        MRG.tickets.map((externalId) =>
          db.zendeskTicketRaw.create({
            data: { workspaceId, externalId, subject: externalId, body: "QA-MRG fixture.", raw: {}, catalogKind: "fr", catalogReason: "QA-MRG fixture" },
          })
        )
      );
      // Start every idea with no sources and 0 votes; the reassign below attaches the evidence.
      const jiraIdea = await db.idea.create({ data: {
        workspaceId, title: MRG.jiraIdea, details: "QA-MRG", products: ["Other"], batchStatus: "updated", decision: "pending", origin: "jira", newVotes: 0,
      } });
      const zenIdea = await db.idea.create({ data: {
        workspaceId, title: MRG.zenIdea, details: "QA-MRG", products: ["Other"], batchStatus: "new", decision: "pending", origin: "zendesk", newVotes: 0,
      } });
      const consolidated = await db.idea.create({ data: {
        workspaceId, title: MRG.consolidated, details: "QA-MRG", products: ["Other"], batchStatus: "updated", decision: "pending", origin: "zendesk",
        existingVotes: 5, newVotes: 1, sources: { create: [{ kind: "zendesk", ticketId: tickets[2].id }] },
      } });
      return { jiraIdea: jiraIdea.id, zenIdea: zenIdea.id, consolidated: consolidated.id };
    });

    await loginAsRoomLens(page);
    const reassign = async (ideaId: string, zen: string[], jira: string[]) => {
      const res = await page.request.post("/api/ideas/mutate", { data: { type: "reassign", ideaId, zen, jira } });
      expect(res.status(), await res.text()).toBe(200);
    };
    // 2 zendesk + 2 jira, origin jira → its own issue is not evidence → 3.
    await reassign(ids.jiraIdea, [MRG.tickets[0], MRG.tickets[1]], [MRG.ownJira, MRG.otherJira]);
    // 2 zendesk + 2 jira, origin zendesk → every source counts → 4.
    await reassign(ids.zenIdea, [MRG.tickets[0], MRG.tickets[1]], [MRG.otherJira, MRG.thirdJira]);
    // Consolidated: same sources re-sent → delta 0 → untouched.
    await reassign(ids.consolidated, [MRG.tickets[2]], []);

    const votes = () =>
      withTestDb(async (db) => {
        const rows = await db.idea.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true, newVotes: true, existingVotes: true } });
        return Object.fromEntries(rows.map((r) => [r.id, [r.existingVotes, r.newVotes]]));
      });
    const afterApp = await votes();
    expect(afterApp[ids.jiraIdea], "jira-origin: 2 zen + (2 jira − own)").toEqual([0, 3]);
    expect(afterApp[ids.zenIdea], "zendesk-origin: 2 zen + 2 jira").toEqual([0, 4]);
    expect(afterApp[ids.consolidated], "consolidated untouched").toEqual([5, 1]);

    // The prod one-time recompute must agree with what the app already stored.
    // Run verbatim inside a transaction that is rolled back: the QA DB is a
    // clone of dev with other orgs' rows, and this test proves the rule, it
    // does not migrate data (that is OPS-01's rehearsal).
    const afterSql = await withTestDb(async (db) => {
      class Rollback extends Error {
        constructor(public rows: Record<string, number[]>, public changed: number) { super("rollback"); }
      }
      try {
        await db.$transaction(async (tx) => {
          const changed = await tx.$executeRawUnsafe(PROD_RECOMPUTE_SQL);
          const rows = await tx.idea.findMany({
            where: { id: { in: Object.values(ids) } }, select: { id: true, newVotes: true, existingVotes: true },
          });
          throw new Rollback(Object.fromEntries(rows.map((r) => [r.id, [r.existingVotes, r.newVotes]])), changed);
        });
      } catch (e) {
        if (e instanceof Rollback) {
          console.log(`[MRG-04] prod recompute would change ${e.changed} row(s) in this DB (rolled back)`);
          return e.rows;
        }
        throw e;
      }
      throw new Error("unreachable");
    });
    expect(afterSql, "SQL rule == app rule on the same rows").toEqual(afterApp);
    expect(afterSql[ids.consolidated], "existingVotes > 0 excluded by the WHERE").toEqual([5, 1]);
  });
});
