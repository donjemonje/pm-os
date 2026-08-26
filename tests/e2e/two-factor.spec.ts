import { expect, test } from "@playwright/test";
import {
  apiStatus,
  currentStep,
  ensureWindowHeadroom,
  loginExpecting2fa,
  logout,
  PASSWORD,
  submitTwoFactorCode,
  totpFor,
  USER_A,
  USER_A_SECRET,
  USER_B,
} from "./helpers";

// Requires the seed: node scripts/with-apphosting-env.mjs dev-apphosting.yaml --
//   node --experimental-strip-types tests/e2e/seed-2fa.ts
// Re-run the seed before each suite run — T6 enrolls user B, and the seed
// resets that. All tests write data (sessions, totp state): none are @smoke.

const VIEWPORT_CENTER_X = 1440 / 2;
const INVALID_CODE_ERROR =
  /didn't match or was already used/;

test.describe("2FA login", () => {
  test("T1 challenge page is centered with no app shell", async ({ page }) => {
    await loginExpecting2fa(page, USER_A, PASSWORD);

    const heading = page.getByRole("heading", { name: "Two-factor check" });
    await expect(heading).toBeVisible();

    // The old bug rendered the app sidebar/nav around this page.
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);

    const card = page.locator("div.rounded-2xl");
    await expect(card).toHaveCount(1);
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    const centerX = box!.x + box!.width / 2;
    const offset = Math.abs(centerX - VIEWPORT_CENTER_X);
    console.log(
      `[T1] card center x=${centerX.toFixed(1)}, viewport center=${VIEWPORT_CENTER_X}, offset=${offset.toFixed(1)}px`
    );
    expect(offset).toBeLessThanOrEqual(25);

    await page.screenshot({
      path: "tests/e2e/artifacts/t1-2fa-challenge-centered.png",
      fullPage: true,
    });
  });

  test("T2 code from the previous 30s window is rejected", async ({ page }) => {
    await loginExpecting2fa(page, USER_A, PASSWORD);

    // Keep enough headroom that the "previous window" stays previous while
    // we type and submit.
    await ensureWindowHeadroom(8_000);
    const totp = totpFor(USER_A_SECRET);
    let previous = totp.generate({ timestamp: Date.now() - 30_000 });
    if (previous === totp.generate()) {
      // Freak collision across the boundary — wait a window and regenerate.
      await ensureWindowHeadroom(30_000);
      previous = totp.generate({ timestamp: Date.now() - 30_000 });
    }
    expect(previous).not.toBe(totp.generate());

    await submitTwoFactorCode(page, previous);

    const error = page.locator("form p", { hasText: INVALID_CODE_ERROR });
    await expect(error).toBeVisible();
    console.log(`[T2] error shown: "${(await error.innerText()).trim()}"`);
    expect(page.url()).toContain("/login/2fa");

    const meStatus = await apiStatus(page, "/api/auth/me");
    console.log(`[T2] /api/auth/me after rejected code: ${meStatus}`);
    expect(meStatus).toBe(401);
  });

  test("T3+T4 valid code logs in; the same code cannot be replayed", async ({
    page,
  }) => {
    await loginExpecting2fa(page, USER_A, PASSWORD);

    // One code must survive: submit, logout, re-login, replay — start at a
    // fresh window so it all fits inside 30s.
    await ensureWindowHeadroom(25_000);
    const totp = totpFor(USER_A_SECRET);
    const code = totp.generate();
    const stepAtGenerate = currentStep();

    // T3: valid code passes the challenge and the app renders.
    await submitTwoFactorCode(page, code);
    await page.waitForURL(/\/dashboard/);
    await expect(page.locator("aside")).toBeVisible(); // app shell = logged in
    await expect(page.locator("body")).not.toContainText(
      "Application error"
    );
    console.log(`[T3] code ${code} accepted, landed on ${page.url()}`);

    // T4: logout, log back in, replay the exact same code.
    await logout(page);
    await loginExpecting2fa(page, USER_A, PASSWORD);

    // The replay only proves single-use if we're still in the same window.
    expect(
      currentStep(),
      "TOTP window rolled over before the replay — rerun; assertion would be ambiguous"
    ).toBe(stepAtGenerate);

    await submitTwoFactorCode(page, code);
    const error = page.locator("form p", { hasText: INVALID_CODE_ERROR });
    await expect(error).toBeVisible();
    console.log(`[T4] replayed ${code}: "${(await error.innerText()).trim()}"`);
    expect(page.url()).toContain("/login/2fa");
    expect(await apiStatus(page, "/api/auth/me")).toBe(401);
  });

  test("T5 session without 2FA gets 401s and cannot reach the app", async ({
    page,
  }) => {
    await loginExpecting2fa(page, USER_A, PASSWORD);
    // Deliberately skip the challenge.

    const meStatus = await apiStatus(page, "/api/auth/me");
    const docsStatus = await apiStatus(page, "/api/documents");
    console.log(
      `[T5] pre-2FA statuses: /api/auth/me=${meStatus} /api/documents=${docsStatus}`
    );
    expect(meStatus).toBe(401);
    expect(docsStatus).toBe(401);

    await page.goto("/dashboard");
    await page.waitForURL(/\/login\/2fa/);
    await expect(
      page.getByRole("heading", { name: "Two-factor check" })
    ).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
  });

  test("T6 un-enrolled user is forced through enrollment and it works", async ({
    page,
  }) => {
    await loginExpecting2fa(page, USER_B, PASSWORD);

    await expect(
      page.getByRole("heading", { name: "Set up two-factor" })
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "QR code for authenticator app" })
    ).toBeVisible();

    const secret = (await page.locator("span.font-mono").innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/); // base32
    console.log(`[T6] manual key shown (${secret.length} chars)`);

    await ensureWindowHeadroom(8_000);
    const code = totpFor(secret).generate();
    await submitTwoFactorCode(page, code);

    await page.waitForURL(/\/dashboard/);
    await expect(page.locator("aside")).toBeVisible();
    expect(await apiStatus(page, "/api/auth/me")).toBe(200);
    console.log(`[T6] enrollment code accepted, landed on ${page.url()}`);
  });
});
