import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { QA_KELA, QA_USER } from "./helpers";
import { RESOLVED_ENV } from "./test-env";
import {
  apiStatus,
  currentStep,
  ensureWindowHeadroom,
  INVALID_CODE_ERROR,
  loginExpecting2fa,
  logout,
  passTwoFactorChallenge,
  submitTwoFactorCode,
  TEST_KELA_TOTP_SECRET,
  TEST_TOTP_SECRET,
  totpFor,
  USER_A,
  USER_B,
} from "./two-factor-helpers";

/**
 * Mandatory-2FA login flow, against the pmos_test harness (port 3200,
 * `npm run test:db:setup` seeds the users):
 *   USER_A qa+roomlens@pm-os.io    enrolled (fixed TEST_TOTP_SECRET)
 *   USER_B qa+roomlens-2@pm-os.io  un-enrolled — T6 walks the QR enrollment
 *   QA_KELA qa+kela@pm-os.io       enrolled, Kela QA org (ideas ON per org) —
 *                                  T5b fences /api/ideas for an Ideas org
 *
 * The beforeAll below resets both users' totp state + sessions directly in
 * the test DB, so T6 is rerunnable and T2-T4 are immune to a leftover
 * totpLastUsedStep from a previous run — no re-seed needed between runs.
 * All tests write data (sessions, totp state): none are @smoke.
 */

const PASSWORD = QA_USER.password; // same seed convention for both users

test.describe("2FA login", () => {
  test.beforeAll(async () => {
    // Same resolved env as the app (yaml wins over shell); the env guard has
    // already pinned the database to pmos_test before this runs.
    process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
    const db = new PrismaClient();
    try {
      await db.user.update({
        where: { email: USER_A },
        data: { totpLastUsedStep: null },
      });
      await db.user.update({
        where: { email: USER_B },
        data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null },
      });
      await db.session.deleteMany({
        where: { user: { email: { in: [USER_A, USER_B] } } },
      });
    } catch (e) {
      throw new Error(
        `2FA spec beforeAll could not reset ${USER_A} / ${USER_B} — did you ` +
          `run \`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
      );
    } finally {
      await db.$disconnect();
    }
  });

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
    const viewportCenterX = page.viewportSize()!.width / 2;
    const centerX = box!.x + box!.width / 2;
    const offset = Math.abs(centerX - viewportCenterX);
    console.log(
      `[T1] card center x=${centerX.toFixed(1)}, viewport center=${viewportCenterX}, offset=${offset.toFixed(1)}px`
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
    const totp = totpFor(TEST_TOTP_SECRET);
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
    const totp = totpFor(TEST_TOTP_SECRET);
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

    // AUTH-06 (spec audit 2026-10-19): every page is fenced at the edge —
    // Ideas and Admin included. src/proxy.ts runs the pending-2FA check
    // before the admin branch and before any page renders, and carries the
    // requested path as ?from= so the challenge can return there. Asserting
    // `from` proves the fence saw the exact path, not just "some redirect".
    for (const path of ["/dashboard", "/ideas", "/admin"]) {
      await page.goto(path);
      await page.waitForURL(/\/login\/2fa/);
      expect(
        new URL(page.url()).searchParams.get("from"),
        `${path} should be fenced with from=${path}`
      ).toBe(path);
      await expect(
        page.getByRole("heading", { name: "Two-factor check" })
      ).toBeVisible();
      await expect(page.locator("aside")).toHaveCount(0);
    }
  });

  test("T5b Ideas org: pending session is refused on /ideas and /api/ideas; the same session gets in after the challenge", async ({
    page,
  }) => {
    // The RoomLens user in T5 can't prove the /api/ideas fence: ideas is env-off
    // for RoomLens, so the route 404s for a verified user too. The Kela QA org
    // has ideas ON per org, so the contrast below (pending → refused, verified
    // → 200 with the ideas state) proves the refusal is the 2FA fence.
    //
    // Why the pending status is 404 and not 401: the proxy leaves APIs alone,
    // and /api/ideas (src/app/api/ideas/route.ts) checks the org feature gate
    // before auth. A pending session is no user at all to getCurrentUser, so
    // the org override is invisible and the gate falls to the env default —
    // IDEAS_ENABLED=false in this env (pinned by global-setup.ts) → 404 with
    // an { error } body and no data. Same limitation gating-isolation XC-02
    // records for anonymous callers. If the gate order ever changes this
    // becomes 401 — update the status here, not the no-data assertions.
    await loginExpecting2fa(page, QA_KELA.email, QA_KELA.password);

    const pending = await page.request.get("/api/ideas");
    const pendingBody = await pending.json();
    console.log(
      `[T5b] pending /api/ideas=${pending.status()} body=${JSON.stringify(pendingBody)}`
    );
    expect(pending.status()).toBe(404);
    expect(Object.keys(pendingBody)).toEqual(["error"]);

    await page.goto("/ideas");
    await page.waitForURL(/\/login\/2fa/);
    expect(new URL(page.url()).searchParams.get("from")).toBe("/ideas");
    await expect(
      page.getByRole("heading", { name: "Two-factor check" })
    ).toBeVisible();

    // Same user, same cookie jar: pass the challenge and the fence opens.
    await passTwoFactorChallenge(page, TEST_KELA_TOTP_SECRET, page.locator("aside"));
    const verified = await page.request.get("/api/ideas");
    const state = await verified.json();
    console.log(
      `[T5b] verified /api/ideas=${verified.status()} keys=${Object.keys(state).join(",")}`
    );
    expect(verified.status()).toBe(200);
    expect(state).not.toHaveProperty("error");
    expect(Array.isArray(state.ideas)).toBe(true);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
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
