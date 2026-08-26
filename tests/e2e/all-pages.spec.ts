import { test, expect } from "@playwright/test";
import { expectAppPageRenders, loginAsRoomLens } from "./helpers";

/**
 * Page-coverage suite: log in once as the seeded RoomLens user, then visit
 * every reachable App Router page and assert each actually renders (a real
 * page-specific element, no bounce to /login, no 404 / error boundary).
 *
 * Route inventory (src/app/**\/page.tsx) and why some are not visited here:
 * - /                       covered: redirects a logged-in user to /dashboard.
 * - /login, /register       covered as redirects: middleware sends a
 *                           logged-in user to /dashboard. The logged-out
 *                           /login render lives in auth.spec.ts.
 * - /crm, /crm/users        skipped as app pages: separate CRM auth realm
 *                           (pmos_crm_session cookie); the RoomLens app
 *                           session must NOT grant access. Asserted below as
 *                           a redirect to /crm/login instead.
 * - /crm/login              covered via the CRM redirect test.
 * - /docs/[id]              skipped: the RoomLens seed creates no documents,
 *                           and this suite stays read-only. Revisit if
 *                           seed-test-db.mjs ever seeds a document.
 * - /ideas, /settings/ideas IDEAS_ENABLED=false in the test env — asserted
 *                           as 404 below (the env guard pins the flag).
 * - /settings/google-drive  covered: legacy route, must redirect to
 *                           /settings/jira.
 */

test("logged-in user can open every app page", async ({ page }) => {
  await loginAsRoomLens(page);

  await expectAppPageRenders(page, "/dashboard", (p) =>
    p.getByRole("heading", { name: "Dashboard" })
  );
  await expectAppPageRenders(page, "/chat", (p) =>
    p.getByRole("heading", { name: "Chat" })
  );
  await expectAppPageRenders(page, "/docs", (p) =>
    p.getByRole("heading", { name: "Documents" })
  );
  await expectAppPageRenders(page, "/docs/new", (p) =>
    p.getByRole("heading", { name: "Create user manual" })
  );
  await expectAppPageRenders(page, "/releases", (p) =>
    p.getByRole("heading", { name: "Releases" })
  );
  await expectAppPageRenders(page, "/settings/jira", (p) =>
    p.getByRole("heading", { name: "Settings" })
  );
  // Integrations content confirms the settings child page rendered, not
  // just the settings layout.
  await expect(
    page.getByText("Connect Jira and Google Drive to import tickets and PRDs.")
  ).toBeVisible();

  // Legacy route: must land on the integrations settings page.
  await page.goto("/settings/google-drive");
  await page.waitForURL("**/settings/jira**");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("root and auth routes send a logged-in user to the dashboard", async ({
  page,
}) => {
  await loginAsRoomLens(page);

  for (const path of ["/", "/login", "/register"]) {
    await page.goto(path);
    await page.waitForURL("**/dashboard");
    await expect(
      page.getByRole("heading", { name: "Dashboard" })
    ).toBeVisible();
  }
});

test("app session does not grant CRM access", async ({ page }) => {
  await loginAsRoomLens(page);

  for (const path of ["/crm", "/crm/users"]) {
    await page.goto(path);
    await page.waitForURL("**/crm/login");
    await expect(
      page.getByRole("heading", { name: "PM-OS CRM" })
    ).toBeVisible();
  }
});

// The env guard (global-setup.ts) pins IDEAS_ENABLED off, so this is
// deterministic. If the ideas feature ships enabled, update the guard and
// this test together.
test("ideas routes 404 while IDEAS_ENABLED is off", async ({ page }) => {
  await loginAsRoomLens(page);

  for (const path of ["/ideas", "/settings/ideas"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should 404 with the flag off`).toBe(404);
    await expect(page.getByText("This page could not be found")).toBeVisible();
  }
});
