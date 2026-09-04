import { Locator, Page, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { RESOLVED_ENV } from "./test-env";
import {
  loginExpecting2fa,
  passTwoFactorChallenge,
  TEST_ADMIN_TOTP_SECRET,
} from "./two-factor-helpers";

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
 * Seeded PMOS_ADMIN user (role-based PM-OS Admin access). Enrolled in TOTP
 * with its own fixed secret (TEST_ADMIN_TOTP_SECRET).
 */
export const QA_ADMIN = {
  email: "qa+roomlens-admin@pm-os.io",
  password: "roomlens-qa-pass1",
};

/**
 * Log in through the real login form, pass the mandatory /login/2fa TOTP
 * challenge with a real code, and wait for the dashboard. These are the ONLY
 * login helpers — specs never re-implement login.
 */
export async function loginAsRoomLens(page: Page): Promise<void> {
  await loginExpecting2fa(page, QA_USER.email, QA_USER.password);
  await passTwoFactorChallenge(page);
  await page.waitForURL("**/dashboard");
  await expect(
    page.getByRole("heading", { name: "Dashboard" })
  ).toBeVisible();
}

/** Same flow as loginAsRoomLens, for the seeded PMOS_ADMIN user. Lands on
 * /dashboard like any user — admin-ness only matters on /admin routes. */
export async function loginAsRoomLensAdmin(page: Page): Promise<void> {
  await loginExpecting2fa(page, QA_ADMIN.email, QA_ADMIN.password);
  await passTwoFactorChallenge(page, TEST_ADMIN_TOTP_SECRET);
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

/**
 * Run a callback against the test database with the same resolved env the
 * app gets (yaml wins over shell; the env guard has already pinned the DB
 * name to pmos_test / a pmos_ft_* clone). Use it for fixture setup/reset in
 * beforeAll/afterAll and for DB-side assertions — never for login.
 */
export async function withTestDb<T>(
  fn: (db: PrismaClient) => Promise<T>
): Promise<T> {
  process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
