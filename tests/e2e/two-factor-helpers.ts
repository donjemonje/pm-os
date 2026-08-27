import { expect, Page } from "@playwright/test";
import * as OTPAuth from "otpauth";

/**
 * TOTP utilities for the mandatory-2FA login flow, shared by helpers.ts
 * (loginAsRoomLens) and two-factor.spec.ts. Codes are generated for real
 * from the enrolled secret — never mocked.
 */

/** Seeded users in pmos_test — see scripts/seed-test-db.mjs. */
export const USER_A = "qa+roomlens@pm-os.io"; // enrolled in TOTP (= QA_USER.email)
export const USER_B = "qa+roomlens-2@pm-os.io"; // un-enrolled (enrollment flow)

/**
 * Fixed synthetic TOTP secret for USER_A. Single source of truth for the
 * tests; scripts/seed-test-db.mjs mirrors it and stores it encrypted with
 * the fixed test TOTP_ENC_KEY (test-apphosting.yaml / CI job env).
 * Test-only credential — never use outside pmos_test.
 */
export const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

export const TOTP_PERIOD_MS = 30_000;

/** Server error for a wrong OR replayed code (same message by design). */
export const INVALID_CODE_ERROR = /didn't match or was already used/;

export function totpFor(secretBase32: string): OTPAuth.TOTP {
  // Same params as src/lib/two-factor.ts.
  return new OTPAuth.TOTP({
    issuer: "PM-OS",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function currentStep(): number {
  return Math.floor(Date.now() / TOTP_PERIOD_MS);
}

export function msLeftInWindow(): number {
  return TOTP_PERIOD_MS - (Date.now() % TOTP_PERIOD_MS);
}

/** If fewer than `minMs` remain in the current 30s TOTP window, wait for the
 * next window so a code generated now stays valid while we type/submit it.
 * These waits are by design (TOTP timing), not flakiness — see tests/README.md. */
export async function ensureWindowHeadroom(minMs: number): Promise<void> {
  const left = msLeftInWindow();
  if (left < minMs) {
    await new Promise((r) => setTimeout(r, left + 250));
  }
}

/** Log in via the UI. 2FA is mandatory, so this always lands on /login/2fa. */
export async function loginExpecting2fa(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/login\/2fa/);
}

/** Submit a 6-digit code on the /login/2fa page. */
export async function submitTwoFactorCode(
  page: Page,
  code: string
): Promise<void> {
  const input = page.locator("#code");
  await input.fill(code);
  await page
    .getByRole("button", { name: /verify( & finish setup)?$/i })
    .click();
}

// Codes are single-use per 30s step (User.totpLastUsedStep). Consecutive
// logins of the same user inside one window would replay the same code, so
// we track the last step we consumed and skip past it. The tracker is
// per-process; a worker restart between spec files loses it, so
// passTwoFactorChallenge also retries once per window on an "already used"
// rejection (the code itself is definitionally valid — we just generated it
// from the enrolled secret with headroom to spare).
let lastConsumedStep = -1;

/**
 * Complete the /login/2fa challenge for the enrolled RoomLens user
 * (TEST_TOTP_SECRET) and wait for the dashboard. Used by loginAsRoomLens —
 * specs should not call this directly unless they need a bare challenge.
 */
export async function passTwoFactorChallenge(page: Page): Promise<void> {
  const error = page.locator("form p", { hasText: INVALID_CODE_ERROR });
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });

  for (let attempt = 0; attempt < 3; attempt++) {
    // Skip any window a previous login in this process already consumed.
    while (currentStep() <= lastConsumedStep) {
      await new Promise((r) => setTimeout(r, msLeftInWindow() + 250));
    }
    await ensureWindowHeadroom(8_000);
    const step = currentStep();
    await submitTwoFactorCode(page, totpFor(TEST_TOTP_SECRET).generate());

    await expect(error.or(dashboardHeading).first()).toBeVisible({
      timeout: 15_000,
    });
    lastConsumedStep = Math.max(lastConsumedStep, step);
    if (await dashboardHeading.isVisible()) return;
    // Rejected: this window's step was consumed outside our tracker (e.g. an
    // earlier spec file before a worker restart). Retry in the next window.
  }
  throw new Error(
    "2FA challenge: freshly generated current-window codes were rejected 3 " +
      "times in a row — suspect the product (replay guard) or a seed/secret " +
      "mismatch, not timing."
  );
}

/** GET a JSON API from within the page's cookie context; returns the status. */
export async function apiStatus(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path);
  return res.status();
}

export async function logout(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/logout");
  expect(res.ok()).toBe(true);
}
