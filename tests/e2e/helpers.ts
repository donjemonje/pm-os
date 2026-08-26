import { Page, expect } from "@playwright/test";

/**
 * RoomLens QA credentials. Local + CI use the seeded defaults (see
 * scripts/seed-roomlens.mjs). Prod smoke runs override both via GitHub
 * secrets — there is no default prod password anywhere in the repo.
 */
export const QA_USER = {
  email: process.env.QA_USER_EMAIL || "qa+roomlens@pm-os.io",
  password: process.env.QA_USER_PASSWORD || "roomlens-qa-pass1",
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
