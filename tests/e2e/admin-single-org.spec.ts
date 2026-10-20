/**
 * PM-OS Admin works on ONE organization — release QA 4.0.0 version test
 * (ADM-15). Feature: feature/fixes_for_ideas_usage_by_kela.
 *
 * ADM-15 the amber banner names the current organization on every admin
 *        screen; the pick is a cookie (pmos_admin_org) set by the banner's
 *        select / POST /api/admin/current-org; Users shows only that org's
 *        card; switching in the banner re-renders Users, Enablements, Ideas
 *        and Analytics for the new org; an unknown org id is a 404 and
 *        leaves the pick alone; a plain USER cannot set it.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsRoomLens, loginAsRoomLensAdmin, selectAdminOrg, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

const ROOMLENS = "RoomLens";
const OTHER_SLUG = "kela-qa";
const OTHER = "Kela QA";

function orgCard(page: Page, orgName: string): Locator {
  return page.locator("div.rounded-xl").filter({ has: page.locator("p.font-semibold", { hasText: orgName }) });
}

test.describe("Admin single-organization banner (ADM-15)", () => {
  test("ADM-15 banner pick is a cookie, every admin screen follows it, bad ids and non-admins are refused", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const { roomlensId, otherId } = await withTestDb(async (db) => ({
      roomlensId: (await db.organization.findUniqueOrThrow({ where: { slug: "roomlens" } })).id,
      otherId: (await db.organization.findUniqueOrThrow({ where: { slug: OTHER_SLUG } })).id,
    }));

    await loginAsRoomLensAdmin(page);
    await selectAdminOrg(page, roomlensId);
    const select = page.getByRole("combobox", { name: "Organization" });

    // Users: one card, the picked org.
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();
    await expect(select).toHaveValue(roomlensId);
    await expect(orgCard(page, ROOMLENS)).toBeVisible();
    await expect(orgCard(page, OTHER)).toHaveCount(0);

    // Switch in the banner → the same screen re-renders for the other org,
    // and the cookie carries it.
    await select.selectOption(otherId);
    await expect(orgCard(page, OTHER)).toBeVisible();
    await expect(orgCard(page, ROOMLENS)).toHaveCount(0);
    const cookie = (await page.context().cookies()).find((c) => c.name === "pmos_admin_org");
    expect(cookie?.value).toBe(otherId);

    // The other admin screens read the same pick.
    for (const [path, heading] of [
      ["/admin/enablements", "Enablements"],
      ["/admin/ideas", "Ideas"],
      ["/admin/analytics", "Analytics"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }), path).toBeVisible();
      await expect(select, path).toHaveValue(otherId);
    }
    await page.goto("/admin/enablements");
    await expect(page.locator("main, body").getByText(OTHER, { exact: true }).first()).toBeVisible();

    // Unknown id → 404, pick unchanged.
    const bad = await page.request.post("/api/admin/current-org", { data: { orgId: "not-an-org" } });
    expect(bad.status()).toBe(404);
    await page.goto("/admin/users");
    await expect(select).toHaveValue(otherId);

    // Back to RoomLens for the suite's other admin tests.
    await selectAdminOrg(page, roomlensId);
    await page.goto("/admin/users");
    await expect(orgCard(page, ROOMLENS)).toBeVisible();

    // A plain USER cannot set the admin pick.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const user = await userContext.newPage();
    try {
      await loginAsRoomLens(user);
      const res = await user.request.post("/api/admin/current-org", { data: { orgId: otherId } });
      expect(res.status(), "apiAdmin answers a non-admin with Not found").toBe(404);
    } finally {
      await userContext.close();
    }
  });
});
