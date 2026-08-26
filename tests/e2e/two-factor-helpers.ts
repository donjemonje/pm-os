import { expect, Page } from "@playwright/test";
import * as OTPAuth from "otpauth";

export const USER_A = "qa-2fa-a@pm-os.test";
export const USER_B = "qa-2fa-b@pm-os.test";
export const PASSWORD = "qa-2fa-Passw0rd!";
// Must match tests/e2e/seed-2fa.ts.
export const USER_A_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

export const TOTP_PERIOD_MS = 30_000;

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
 * next window so a code generated now stays valid while we type/submit it. */
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

/** GET a JSON API from within the page's cookie context; returns the status. */
export async function apiStatus(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path);
  return res.status();
}

export async function logout(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/logout");
  expect(res.ok()).toBe(true);
}
