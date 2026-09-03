import { createHash, randomBytes, scryptSync } from "crypto";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { loginAsRoomLensAdmin, QA_USER } from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";
import {
  loginExpecting2fa,
  passTwoFactorChallenge,
} from "./two-factor-helpers";

/**
 * Google SSO system flag + forgot-password (feature/google-sso).
 *
 * G1  googleSso system-flag round-trip: admin override wins, env default
 *     (DISABLE_GOOGLE_LOGIN=true → off, pinned by the env guard) otherwise;
 *     observed on /api/auth/oauth/providers and the authorize redirect.
 *     Fake Google creds in the test env make the provider "configured" —
 *     neither endpoint ever calls Google's servers.
 * G2  forgot-password is enumeration-safe: identical { ok: true } for a real
 *     and a nonexistent email; a token row exists only for the real user.
 * G3  full reset path: emailed link (token row inserted directly — with no
 *     SMTP_USER/SMTP_PASSWORD the email only prints to the server console) → new
 *     password via the UI → token is single-use → login works with the new
 *     password through the mandatory 2FA challenge.
 * G4  expired token is refused with the same generic 400.
 *
 * NOT covered here (needs a mocked Google token endpoint — out of scope by
 * design, covered by review only): sticky login type in signInWithOAuth — a
 * user with a passwordHash can never complete a Google sign-in
 * (email_uses_password), even with a pre-existing OAuthAccount link.
 *
 * State discipline: beforeAll AND afterAll clear the googleSso override,
 * clear all PasswordResetToken rows, and re-set QA_USER's passwordHash to
 * the seeded password (re-hashed with the app's salt:scrypt format — no
 * in-memory state, so it survives the worker restart a mid-test failure
 * causes). Nothing can leak a changed password or an enabled Google button
 * into other specs.
 */

// Must satisfy the password policy (lib/password-policy.ts): the API checks
// it before the token, so a weak value would mask the token assertions.
const NEW_PASSWORD = "Roomlens-qa-newpass1";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Run a callback against pmos_test with the same resolved env as the app. */
async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/** Insert a reset-token row the way requestPasswordReset would (only the
 * SHA-256 hash is stored) and return the raw token the "email" would carry. */
async function insertResetToken(
  db: PrismaClient,
  userId: string,
  expiresAt: Date
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256Hex(raw), expiresAt },
  });
  return raw;
}

/** Same salt:scrypt format as src/lib/auth.ts hashPassword. */
function appPasswordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

async function resetGoogleSsoFixtures(): Promise<void> {
  await withDb(async (db) => {
    try {
      await db.systemFlag.deleteMany({ where: { key: "googleSso" } });
      await db.passwordResetToken.deleteMany({});
      // Re-hash the seeded password (undoes G3's change; a fresh salt gives
      // a different string than the seed's, but verifyPassword only cares
      // that it derives from QA_USER.password).
      await db.user.update({
        where: { email: QA_USER.email },
        data: { passwordHash: appPasswordHash(QA_USER.password) },
      });
    } catch (e) {
      throw new Error(
        `google-sso spec could not reset the QA fixtures — did you run ` +
          `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
      );
    }
  });
}

test.describe("Google SSO + forgot-password", () => {
  test.beforeAll(resetGoogleSsoFixtures);
  test.afterAll(resetGoogleSsoFixtures);

  test("G1 googleSso system flag: admin override drives the providers list and the authorize redirect", async ({
    page,
  }) => {
    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/enablements");
    await expect(
      page.getByRole("heading", { name: "Enablements" })
    ).toBeVisible();

    // The System card renders above the org cards; its Google SSO row is the
    // only "Google SSO" li on the page. Badge over button state, as in
    // admin.spec A2: it only updates from the PATCH response.
    const row = page.locator("li", { hasText: "Google SSO" });
    const badge = row.locator("span.rounded-full");
    await expect(badge).toHaveText("Off (default)");

    // Baseline (env default off): google is hidden even though configured.
    const providerIds = async () => {
      const res = await page.request.get("/api/auth/oauth/providers");
      expect(res.status()).toBe(200);
      const { providers } = (await res.json()) as {
        providers: { provider: string }[];
      };
      return providers.map((p) => p.provider);
    };
    expect(await providerIds()).not.toContain("google");

    // …and starting the flow bounces straight back to /login with the error.
    const authorizeLocation = async () => {
      const res = await page.request.get("/api/auth/oauth/google", {
        maxRedirects: 0,
      });
      expect(res.status(), "authorize endpoint must redirect").toBeGreaterThanOrEqual(300);
      expect(res.status()).toBeLessThan(400);
      return res.headers()["location"] ?? "";
    };
    expect(await authorizeLocation()).toBe(
      `${LOCAL_BASE_URL}/login?error=google_sso_disabled`
    );

    // Override On → provider listed, authorize goes to Google's consent URL
    // (never followed — fake creds, no network call to Google).
    await row.getByRole("button", { name: "On", exact: true }).click();
    await expect(badge).toHaveText("On");
    expect(await providerIds()).toContain("google");
    expect(await authorizeLocation()).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/
    );

    // Override Off → hidden and blocked again, now by the explicit override.
    await row.getByRole("button", { name: "Off", exact: true }).click();
    await expect(badge).toHaveText("Off");
    expect(await providerIds()).not.toContain("google");
    expect(await authorizeLocation()).toBe(
      `${LOCAL_BASE_URL}/login?error=google_sso_disabled`
    );

    // Clear the override → back to the env default.
    await row.getByRole("button", { name: "Default (off)" }).click();
    await expect(badge).toHaveText("Off (default)");
  });

  test("G2 forgot-password request is enumeration-safe: identical response, token row only for the real user", async ({
    request,
  }) => {
    const real = await request.post("/api/auth/forgot-password", {
      data: { email: QA_USER.email },
    });
    expect(real.status()).toBe(200);
    expect(await real.json()).toEqual({ ok: true });

    const fake = await request.post("/api/auth/forgot-password", {
      data: { email: "nonexistent@nowhere.test" },
    });
    expect(fake.status()).toBe(200);
    expect(await fake.json()).toEqual({ ok: true });

    // Same answer either way — the difference exists only in the database.
    // beforeAll cleared the table, so exactly one row total, owned by the
    // real user, unused, expiring in the future.
    await withDb(async (db) => {
      const tokens = await db.passwordResetToken.findMany({
        include: { user: true },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0].user.email).toBe(QA_USER.email);
      expect(tokens[0].usedAt).toBeNull();
      expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  test("G3 reset link sets a new password once, then the new password logs in through 2FA", async ({
    page,
  }) => {
    // The emailed raw token (no SMTP creds in tests → the email only
    // prints to the server console, so the row is inserted directly with a
    // known raw token, hashed exactly like requestPasswordReset does).
    const rawToken = await withDb(async (db) => {
      const user = await db.user.findUniqueOrThrow({
        where: { email: QA_USER.email },
      });
      return insertResetToken(
        db,
        user.id,
        new Date(Date.now() + 60 * 60 * 1000)
      );
    });

    await page.goto(`/reset-password?token=${rawToken}`);
    await expect(
      page.getByRole("heading", { name: "New password" })
    ).toBeVisible();
    await page.locator("#new-password").fill(NEW_PASSWORD);
    await page.locator("#confirm-password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(
      page.getByText("Password updated. Sign in with your new password.")
    ).toBeVisible();

    // Single-use: replaying the same token is refused with the generic 400.
    const replay = await page.request.post("/api/auth/reset-password", {
      data: { token: rawToken, password: "Another-valid-pass1" },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe(
      "This reset link is invalid or has expired. Request a new one."
    );
    // …and the replay did not overwrite the password set by the first use:
    // the full login below only works if NEW_PASSWORD is still in place.

    // The new password signs in through the mandatory TOTP challenge.
    await loginExpecting2fa(page, QA_USER.email, NEW_PASSWORD);
    await passTwoFactorChallenge(page);
    await page.waitForURL("**/dashboard");
    await expect(
      page.getByRole("heading", { name: "Dashboard" })
    ).toBeVisible();
    // afterAll restores the seeded passwordHash for the other specs.
  });

  test("G4 expired reset token is refused with the same generic 400", async ({
    request,
  }) => {
    const rawToken = await withDb(async (db) => {
      const user = await db.user.findUniqueOrThrow({
        where: { email: QA_USER.email },
      });
      return insertResetToken(db, user.id, new Date(Date.now() - 60_000));
    });

    const res = await request.post("/api/auth/reset-password", {
      data: { token: rawToken, password: "Valid-length-pass1" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe(
      "This reset link is invalid or has expired. Request a new one."
    );

    // The expired attempt changed nothing: the row is still unused.
    await withDb(async (db) => {
      const row = await db.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(rawToken) },
      });
      expect(row.usedAt).toBeNull();
    });
  });
});
