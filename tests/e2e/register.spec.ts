import { expect, test } from "@playwright/test";
import { RESOLVED_ENV } from "./test-env";
import {
  ensureWindowHeadroom,
  submitTwoFactorCode,
  totpFor,
} from "./two-factor-helpers";

/**
 * Register-entry path under mandatory 2FA: a brand-new signup must be forced
 * through TOTP enrollment before reaching the app.
 *
 * ENV GATE: ALLOW_SIGNUP is "false" in the test env (test-apphosting.yaml +
 * CI job env), mirroring production, so /register renders the sign-in form
 * and the register API 403s — the flow below is unreachable. The test is
 * therefore SKIPPED, not deleted: the full flow is implemented so it runs
 * the day the gate opens. To unskip: set ALLOW_SIGNUP=true in
 * test-apphosting.yaml AND the CI job env, and add the flag expectation to
 * the global-setup.ts env guard in the same branch. Do not flip the gate
 * casually — it exists to keep the test env prod-shaped.
 *
 * Since 2026-09-02 ALLOW_SIGNUP is only the env DEFAULT of the "selfSignup"
 * system flag (PM-OS Admin → Enablements, SystemFlag row). A test can open
 * the gate at runtime by PATCHing /api/admin/system-flags as the seeded
 * admin instead of flipping the env — see admin.spec.ts for that path.
 * Self-signup always creates a new organization; invite codes were removed.
 *
 * scripts/seed-test-db.mjs deletes qa+signup* users on every run, and the
 * unique suffix below keeps back-to-back runs independent even without a
 * re-seed. Writes data: never @smoke.
 */

const signupAllowed = ["true", "1"].includes(
  RESOLVED_ENV.ALLOW_SIGNUP?.trim().toLowerCase() ?? ""
);

test.describe("signup entry path", () => {
  test.skip(
    !signupAllowed,
    "ALLOW_SIGNUP=false in the test env (mirrors prod) — see the env-gate note in this spec"
  );

  test("new signup is forced through 2FA enrollment before the app", async ({
    page,
  }) => {
    const suffix = Date.now();
    const email = `qa+signup-${suffix}@pm-os.io`;

    await page.goto("/register");
    await page.locator("#name").fill("QA Signup");
    // Default org mode is "Create new".
    await page.locator("#organization").fill(`QA Signup Org ${suffix}`);
    await page.locator("#signup-email").fill(email);
    await page.locator("#signup-password").fill("signup-qa-pass1");
    await page.getByRole("button", { name: "Sign Up" }).click();

    // Mandatory 2FA: signup lands on inline enrollment, not the app.
    await page.waitForURL(/\/login\/2fa/);
    await expect(
      page.getByRole("heading", { name: "Set up two-factor" })
    ).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);

    // Enroll for real: read the manual key, generate a current code.
    const secret = (await page.locator("span.font-mono").innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/); // base32
    await ensureWindowHeadroom(8_000);
    await submitTwoFactorCode(page, totpFor(secret).generate());

    await page.waitForURL(/\/dashboard/);
    await expect(page.locator("aside")).toBeVisible();
  });
});
