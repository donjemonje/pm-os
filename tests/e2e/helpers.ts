import { Locator, Page, expect } from "@playwright/test";

/**
 * RoomLens QA credentials, as seeded by scripts/seed-test-db.mjs into the
 * local/CI test database (pmos_test). Synthetic only — never real data.
 */
export const QA_USER = {
  email: "qa+roomlens@pm-os.io",
  password: "roomlens-qa-pass1",
};

/** Log in through the real login form and wait for the dashboard. */
export async function loginAsRoomLens(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(QA_USER.email);
  await page.locator("#password").fill(QA_USER.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/dashboard");
  await expect(
    page.getByRole("heading", { name: "Dashboard" })
  ).toBeVisible();
}

/**
 * Open an app page as a logged-in user and assert it really rendered:
 * a page-specific expected element is visible, the session was not
 * bounced back to /login, and no Next.js 404 / error boundary showed.
 */
export async function expectAppPageRenders(
  page: Page,
  path: string,
  expected: (page: Page) => Locator
): Promise<void> {
  await page.goto(path);
  await expect(expected(page), `expected element on ${path}`).toBeVisible();
  expect(new URL(page.url()).pathname, `redirected to login from ${path}`).not.toBe("/login");
  await expect(
    page.getByText("This page could not be found"),
    `404 page shown for ${path}`
  ).toHaveCount(0);
  await expect(
    page.getByText("Application error: a client-side exception has occurred"),
    `error boundary shown for ${path}`
  ).toHaveCount(0);
}
