/**
 * Customer-admin role — release QA 4.0.0 version test (SET-14).
 * Feature: feature/fixes_for_ideas_usage_by_kela (CUSTOMER_ADMIN = a plain
 * member who may also edit the org's own settings; never PM-OS Admin).
 *
 * SET-14 as the seeded CUSTOMER_ADMIN of RoomLens: product lines can be
 *        added, renamed and deleted through /api/ideas/lists/product-lines
 *        and the settings page shows the Add button; /admin pages are a 404
 *        and /api/admin/* refuses the customer-admin exactly like a USER —
 *        the role grants nothing outside Settings.
 *        A plain USER on the same page (Daniel 2026-11-11: USER and
 *        CUSTOMER_ADMIN have the same permissions by default — until then he
 *        saw a read-only hint and no Add button): the same Add button, drag
 *        handle and Edit on a line, no read-only hint, and a line he adds
 *        with the form is saved (the API half of USER is SET-01); /admin
 *        stays a 404 for him too.
 *
 * State: RoomLens gets the per-org {ideas: true} override for the test and
 * {} back after; the QA-CA fixture line is delete-and-recreate + cleanup.
 */
import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { hydrated, loginAsRoomLens, loginAsRoomLensCustomerAdmin, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

const ROOMLENS_SLUG = "roomlens";
const LIST = "/api/ideas/lists/product-lines";
const CA_LINE = "QA-CA Line";
const CA_RENAMED = "QA-CA Line renamed";
const CA_USER_LINE = "QA-CA Member line";

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

  test("SET-14 customer-admin edits product lines and sees the Add button; a USER has the same controls and his added line is saved; /admin and /api/admin stay closed to both", async ({
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

    // A plain USER on the same page: the customer admin's controls, no read-only hint.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const user = await userContext.newPage();
    try {
      await loginAsRoomLens(user);
      const member = await withTestDb((db) => db.user.findUniqueOrThrow({ where: { email: "qa+roomlens@pm-os.io" } }));
      expect(member.role, "the seeded member is a plain USER").toBe("USER");
      await user.goto("/settings/ideas/product-lines");
      await expect(user.getByText(CA_RENAMED, { exact: true })).toBeVisible();
      await expect(user.getByText("read-only for members")).toHaveCount(0);
      await expect(user.getByText("Drag a row by its handle to reorder.")).toBeVisible();
      const line = user.locator("div.rounded-xl.px-5.py-4", { has: user.getByText(CA_RENAMED, { exact: true }) });
      await expect(line.locator('[title="Drag to reorder"]')).toHaveCount(1);
      await expect(line.locator('button[title="Edit"]')).toHaveCount(1);
      // He adds a line with the form and it is saved.
      const addButton = user.getByRole("button", { name: "Add product line" });
      await hydrated(addButton);
      await addButton.click();
      await user.getByPlaceholder("Name", { exact: true }).fill(CA_USER_LINE);
      const posted = user.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === LIST);
      await user.getByRole("button", { name: "Add product line" }).click();
      expect((await posted).status(), "the USER's add").toBe(200);
      await expect(user.getByText(CA_USER_LINE, { exact: true })).toBeVisible();
      expect(await withTestDb((db) => db.productLine.count({ where: { workspaceId, name: CA_USER_LINE } })), "the USER's line in the DB").toBe(1);

      // /admin is unchanged: closed to him as to the customer admin.
      for (const path of ["/admin", "/admin/users"]) {
        const response = await user.goto(path);
        expect(response?.status(), `${path} should 404 for USER`).toBe(404);
      }
      expect((await user.request.get("/api/admin/organizations")).status(), "USER is not a PM-OS admin").toBe(404);
    } finally {
      await userContext.close();
    }

    const del = await page.request.delete(LIST, { data: { id: created!.id } });
    expect(del.status(), await del.text()).toBe(200);
    expect(await withTestDb((db) => db.productLine.findUnique({ where: { id: created!.id } }))).toBeNull();
  });
});
