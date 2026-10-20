/**
 * Customer-admin role — release QA 4.0.0 version test (SET-14).
 * Feature: feature/fixes_for_ideas_usage_by_kela (CUSTOMER_ADMIN = a plain
 * member who may also edit the org's own settings; never PM-OS Admin).
 *
 * SET-14 as the seeded CUSTOMER_ADMIN of RoomLens: product lines can be
 *        added, renamed and deleted through /api/ideas/lists/product-lines
 *        and the settings page shows the Add button; a plain USER sees the
 *        read-only hint and no Add button (the API half of USER is SET-01);
 *        /admin pages are a 404 and /api/admin/* refuses the customer-admin
 *        exactly like a USER — the role grants nothing outside Settings.
 *
 * State: RoomLens gets the per-org {ideas: true} override for the test and
 * {} back after; the QA-CA fixture line is delete-and-recreate + cleanup.
 */
import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginAsRoomLensCustomerAdmin, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

const ROOMLENS_SLUG = "roomlens";
const LIST = "/api/ideas/lists/product-lines";
const CA_LINE = "QA-CA Line";
const CA_RENAMED = "QA-CA Line renamed";

let orgId: string;
let workspaceId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.productLine.deleteMany({ where: { workspaceId, name: { startsWith: "QA-CA " } } });
}

test.describe("Customer-admin role (SET-14)", () => {
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

  test("SET-14 customer-admin edits product lines and sees the Add button; USER is read-only; /admin and /api/admin stay closed", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);

    await loginAsRoomLensCustomerAdmin(page);

    // Role sanity: the seed made this user CUSTOMER_ADMIN, not PMOS_ADMIN.
    const me = await withTestDb((db) => db.user.findUniqueOrThrow({ where: { email: "qa+roomlens-customer-admin@pm-os.io" } }));
    expect(me.role).toBe("CUSTOMER_ADMIN");

    // Settings page: Add button present, no read-only hint.
    await page.goto("/settings/ideas/product-lines");
    await expect(page.getByRole("heading", { name: /product lines/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add product line" })).toBeVisible();
    await expect(page.getByText("read-only for members")).toHaveCount(0);

    // API: create → rename → delete, each one lands in the DB.
    const add = await page.request.post(LIST, { data: { name: CA_LINE } });
    expect(add.status(), await add.text()).toBe(200);
    const created = ((await add.json()).items as { id: string; name: string }[]).find((i) => i.name === CA_LINE);
    expect(created).toBeTruthy();

    const rename = await page.request.patch(LIST, { data: { id: created!.id, name: CA_RENAMED } });
    expect(rename.status(), await rename.text()).toBe(200);
    expect((await withTestDb((db) => db.productLine.findUniqueOrThrow({ where: { id: created!.id } }))).name).toBe(CA_RENAMED);

    await page.goto("/settings/ideas/product-lines");
    await expect(page.getByText(CA_RENAMED, { exact: true })).toBeVisible();

    // Nothing outside Settings: admin pages 404, admin API refuses.
    for (const path of ["/admin", "/admin/users", "/admin/enablements", "/admin/ideas", "/admin/analytics"]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should 404 for CUSTOMER_ADMIN`).toBe(404);
    }
    const adminApi = await page.request.get("/api/admin/organizations");
    expect(adminApi.status(), "customer-admin is not a PM-OS admin").toBe(404);

    // A plain USER on the same page: read-only hint, no Add button.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const user = await userContext.newPage();
    try {
      await loginAsRoomLens(user);
      await user.goto("/settings/ideas/product-lines");
      await expect(user.getByText("read-only for members")).toBeVisible();
      await expect(user.getByRole("button", { name: "Add product line" })).toHaveCount(0);
      await expect(user.getByText(CA_RENAMED, { exact: true })).toBeVisible();
    } finally {
      await userContext.close();
    }

    const del = await page.request.delete(LIST, { data: { id: created!.id } });
    expect(del.status(), await del.text()).toBe(200);
    expect(await withTestDb((db) => db.productLine.findUnique({ where: { id: created!.id } }))).toBeNull();
  });
});
