import { Locator, Page, expect } from "@playwright/test";
import { loginExpecting2fa, passTwoFactorChallenge } from "./two-factor-helpers";

/**
 * RoomLens QA credentials, as seeded by scripts/seed-test-db.mjs into the
 * local/CI test database (pmos_test). Synthetic only — never real data.
 * QA_USER is enrolled in TOTP (fixed secret, see two-factor-helpers.ts).
 */
export const QA_USER = {
  email: "qa+roomlens@pm-os.io",
  password: "roomlens-qa-pass1",
};

/**
 * Log in through the real login form, pass the mandatory /login/2fa TOTP
 * challenge with a real code, and wait for the dashboard. This is the ONLY
 * login helper — specs never re-implement login.
 */
export async function loginAsRoomLens(page: Page): Promise<void> {
  await loginExpecting2fa(page, QA_USER.email, QA_USER.password);
  await passTwoFactorChallenge(page);
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
