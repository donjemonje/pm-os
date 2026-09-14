import { Locator, Page, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";
import { encryptTotpSecret } from "../../src/lib/two-factor";
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

// ————— Release QA 2.0.0 additions (2026-09-14) —————

/** Credentials of a QA-owned org user that a spec seeded itself. */
export interface TotpCreds {
  email: string;
  password: string;
  totpSecret: string;
}

/**
 * Log in through the real form + the mandatory TOTP challenge for ANY
 * enrolled user, landing wherever the org's flags send them (the RoomLens
 * helpers above pin /dashboard; specs that seed their own org use this).
 * "Landed" = the app shell (<aside>) rendered and the URL left /login.
 */
export async function loginWithTotp(page: Page, creds: TotpCreds): Promise<void> {
  await loginExpecting2fa(page, creds.email, creds.password);
  await passTwoFactorChallenge(page, creds.totpSecret, page.locator("aside"));
  await expect(page).not.toHaveURL(/\/login/);
}

/** Same salt:hash scrypt format as src/lib/auth.ts hashPassword. */
export function hashPasswordLikeApp(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

/**
 * Seed a QA-owned organization + workspace + one TOTP-enrolled user, exactly
 * as the app would persist them (the app's own encryptTotpSecret). Deletes a
 * previous copy first (user before org — User.organizationId has no cascade;
 * org → workspace → everything else cascades), so beforeAll is rerunnable.
 * Names/emails must be obviously synthetic (QA-… / qa+…@pm-os.io).
 */
export async function seedQaOrgWithUser(
  db: PrismaClient,
  input: {
    orgName: string;
    slug: string;
    features: Record<string, boolean>;
    user: TotpCreds & { name: string };
  }
): Promise<{ orgId: string; workspaceId: string; userId: string }> {
  process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY;
  await db.user.deleteMany({
    where: { OR: [{ email: input.user.email }, { organization: { slug: input.slug } }] },
  });
  await db.organization.deleteMany({ where: { slug: input.slug } });
  const org = await db.organization.create({
    data: {
      name: input.orgName,
      slug: input.slug,
      features: input.features,
      workspace: { create: { name: `${input.orgName} Workspace` } },
    },
    include: { workspace: true },
  });
  const user = await db.user.create({
    data: {
      email: input.user.email,
      name: input.user.name,
      passwordHash: hashPasswordLikeApp(input.user.password),
      organizationId: org.id,
      role: "USER",
      totpSecretEnc: encryptTotpSecret(input.user.totpSecret),
      totpEnabledAt: new Date(),
      totpLastUsedStep: null,
    },
  });
  return { orgId: org.id, workspaceId: org.workspace!.id, userId: user.id };
}
