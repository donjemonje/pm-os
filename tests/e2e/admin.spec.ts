import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  loginAsRoomLens,
  loginAsRoomLensAdmin,
  QA_ADMIN,
  QA_USER,
} from "./helpers";
import { LOCAL_BASE_URL, RESOLVED_ENV } from "./test-env";
import { USER_B } from "./two-factor-helpers";

/**
 * PM-OS Admin (feature/admin-restriction): role-based access to /admin,
 * user management with guardrails, per-org feature flags, deactivation.
 *
 * Seeded fixtures (scripts/seed-test-db.mjs):
 *   qa+roomlens-admin@pm-os.io  role PMOS_ADMIN — the actor in every test
 *   qa+roomlens@pm-os.io        role USER — deactivation target (A3)
 *   qa+roomlens-2@pm-os.io      role USER — role-PATCH rejection target (A1)
 *
 * Coverage boundaries with the rest of the suite:
 * - USER 404 on the three /admin routes: all-pages.spec.ts.
 * - Ideas 404 under the env default (IDEAS_ENABLED=false, pinned by the
 *   env guard): all-pages.spec.ts. A2 here covers the per-org override,
 *   plus the chat flag's reversed polarity (env default on). Docs shares
 *   the exact resolution/gating code path and has no separate toggle test;
 *   its default-on rendering is covered by the all-pages sweep.
 *
 * State discipline: beforeAll AND afterAll reset roles, deactivation, and
 * the org's feature overrides directly in pmos_test, so a mid-test failure
 * can't leak state into all-pages.spec.ts or two-factor.spec.ts, and the
 * suite reruns green without re-seeding. All tests write data.
 */

const ROOMLENS_SLUG = "roomlens";

async function resetAdminFixtures(): Promise<void> {
  // Same resolved env as the app (yaml wins over shell); the env guard has
  // already pinned the database to pmos_test before this runs.
  process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
  const db = new PrismaClient();
  try {
    await db.user.update({
      where: { email: QA_ADMIN.email },
      data: { role: "PMOS_ADMIN", deactivatedAt: null, totpLastUsedStep: null },
    });
    await db.user.update({
      where: { email: QA_USER.email },
      data: { role: "USER", deactivatedAt: null },
    });
    await db.user.update({
      where: { email: USER_B },
      data: { role: "USER", deactivatedAt: null },
    });
    await db.organization.update({
      where: { slug: ROOMLENS_SLUG },
      data: { features: {} },
    });
  } catch (e) {
    throw new Error(
      `admin spec could not reset the QA fixtures — did you run ` +
        `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
    );
  } finally {
    await db.$disconnect();
  }
}

/** Row in the /admin/users org table for the given member email. Emails are
 * mutually non-substring, so hasText is unambiguous. */
function memberRow(page: Page, email: string) {
  return page.locator("tr", { hasText: email });
}

test.describe("PM-OS Admin", () => {
  test.beforeAll(resetAdminFixtures);
  test.afterAll(resetAdminFixtures);

  test("A1 role changes are script-only: API rejects role PATCH, UI has no role controls, deactivation guardrails hold", async ({
    page,
  }) => {
    // Deactivation confirms via window.confirm.
    page.on("dialog", (dialog) => dialog.accept());

    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/users");
    await expect(
      page.getByRole("heading", { name: "User Management" })
    ).toBeVisible();

    const target = memberRow(page, USER_B);
    const own = memberRow(page, QA_ADMIN.email);

    // Role badges render display-only…
    await expect(own.getByText("pmos-admin", { exact: true })).toBeVisible();
    await expect(target.getByText("user", { exact: true })).toBeVisible();

    // …and the page offers NO role-change affordances (removed 2026-08-27,
    // Daniel's security call: roles move only via scripts/set-user-role.mjs).
    // The actions column IS rendered (Deactivate is there), so the
    // zero-counts below can't pass vacuously on an unrendered table.
    await expect(
      target.getByRole("button", { name: "Deactivate" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Make admin" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove admin" })
    ).toHaveCount(0);

    // API-level: even a valid admin session cannot change roles.
    // page.request rides the logged-in admin's cookies; the request is
    // rejected loudly (400 + script pointer), not silently ignored.
    const orgsRes = await page.request.get("/api/admin/organizations");
    expect(orgsRes.status()).toBe(200);
    const { organizations } = await orgsRes.json();
    const targetId = organizations
      .flatMap((org: { members: { id: string; email: string }[] }) => org.members)
      .find((member: { email: string }) => member.email === USER_B)?.id;
    expect(targetId, `seeded member ${USER_B} in /api/admin/organizations`).toBeTruthy();

    const promote = await page.request.patch(`/api/admin/users/${targetId}`, {
      data: { role: "PMOS_ADMIN" },
    });
    expect(promote.status()).toBe(400);
    expect((await promote.json()).error).toBe(
      "Role changes are not available through the API. Use scripts/set-user-role.mjs."
    );

    // Bundling `role` with an otherwise-valid change is rejected whole —
    // no partial application of the deactivation half.
    const bundled = await page.request.patch(`/api/admin/users/${targetId}`, {
      data: { role: "USER", deactivated: true },
    });
    expect(bundled.status()).toBe(400);
    await page.reload();
    await expect(target.getByText("user", { exact: true })).toBeVisible();
    await expect(
      target.getByText("Deactivated", { exact: true })
    ).toHaveCount(0);

    // Surviving guardrail: an admin cannot deactivate themselves — the API
    // refuses with 400 and the UI surfaces the banner. With the single
    // seeded active admin, "self" and "last active pmos-admin" coincide;
    // the self rule fires first (admin-guard.ts checks it before the
    // last-admin rule), and the last-admin branch is unreachable end-to-end
    // anyway: the actor must be an active admin, so a last-admin target is
    // always self. Asserting the message the API actually returns.
    await own.getByRole("button", { name: "Deactivate" }).click();
    await expect(
      page.getByText("You cannot deactivate your own account")
    ).toBeVisible();
    await expect(own.getByText("Deactivated", { exact: true })).toHaveCount(0);
  });

  test("A2 per-org overrides gate app surfaces: ideas (default off) and chat (default on)", async ({
    browser,
    page,
  }) => {
    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/enablements");
    await expect(
      page.getByRole("heading", { name: "Enablements" })
    ).toBeVisible();

    // Enablements is a matrix (rows = flags, columns = orgs): address the
    // RoomLens cell of a flag row by the data attributes the component
    // guarantees (tr[data-flag] / td[data-org]).
    const ideasCell = page
      .locator('tr[data-flag="ideas"]')
      .locator('td[data-org="roomlens"]');
    // The effective-state badge only updates from the PATCH response, so it
    // is a reliable "the override is saved" signal (unlike button state,
    // which also flips while the request is in flight).
    const badge = ideasCell.locator("span.rounded-full");
    await expect(badge).toHaveText("Off (default)");

    // Baseline: with no override, the env default (off) applies to the org.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const userPage = await userContext.newPage();
    await loginAsRoomLens(userPage);
    let response = await userPage.goto("/ideas");
    expect(response?.status(), "/ideas under env default off").toBe(404);

    // Admin turns the org override On → the same user reaches Ideas.
    await ideasCell.getByRole("button", { name: "On", exact: true }).click();
    await expect(badge).toHaveText("On");
    await userPage.goto("/ideas");
    await expect(
      userPage.getByRole("heading", { name: "Ideas" })
    ).toBeVisible();

    // Back to Default → the env default applies again and gates the org.
    await ideasCell.getByRole("button", { name: "Default (off)" }).click();
    await expect(badge).toHaveText("Off (default)");
    response = await userPage.goto("/ideas");
    expect(response?.status(), "/ideas after override removed").toBe(404);

    // Chat: reversed env polarity (CHAT_ENABLED is ON when unset — pinned
    // by the env guard) and the same resolution mechanism, exercised as one
    // cheap Off→404→Default round-trip rather than a full per-flag flow:
    // ideas above already proves override-wins end to end. Docs rides the
    // identical code path (same registry, layout gate, API wrapper) and gets
    // no separate toggle test.
    const chatCell = page
      .locator('tr[data-flag="chat"]')
      .locator('td[data-org="roomlens"]');
    const chatBadge = chatCell.locator("span.rounded-full");
    await expect(chatBadge).toHaveText("On (default)");

    await chatCell.getByRole("button", { name: "Off", exact: true }).click();
    await expect(chatBadge).toHaveText("Off");
    response = await userPage.goto("/chat");
    expect(response?.status(), "/chat with org override off").toBe(404);
    // The API surface carries the same gate (userPage.request rides the org
    // user's session).
    expect(
      (await userPage.request.get("/api/chat/sessions")).status(),
      "/api/chat/sessions with org override off"
    ).toBe(404);

    // Reset to Default → chat is back for the org (all-pages.spec depends
    // on /chat rendering; afterAll also clears features as a backstop).
    await chatCell.getByRole("button", { name: "Default (on)" }).click();
    await expect(chatBadge).toHaveText("On (default)");
    await userPage.goto("/chat");
    await expect(
      userPage.getByRole("heading", { name: "Chat" })
    ).toBeVisible();

    await userContext.close();
  });

  test("A3 deactivation revokes the session and blocks login; reactivation restores access", async ({
    browser,
    page,
  }) => {
    // Three TOTP logins, two of them for the same user (single-use code
    // windows force a wait between those) — needs more than the 60s default.
    test.setTimeout(150_000);
    page.on("dialog", (dialog) => dialog.accept());

    // The target user logs in first in their own browser context.
    const victimContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const victimPage = await victimContext.newPage();
    await loginAsRoomLens(victimPage);
    // Live-session baseline for the 401 assertion below.
    expect((await victimPage.request.get("/api/auth/me")).status()).toBe(200);

    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/users");
    const row = memberRow(page, QA_USER.email);
    await row.getByRole("button", { name: "Deactivate" }).click();
    await expect(row.getByText("Deactivated", { exact: true })).toBeVisible();

    // The live session was revoked server-side: the API rejects it, and a
    // page visit with the now-stale cookie bounces to /login (dead-cookie
    // exit ramp clears the cookie — no 500, no redirect trap; gap closed
    // 2026-08-27).
    expect((await victimPage.request.get("/api/auth/me")).status()).toBe(401);
    await victimPage.goto("/dashboard");
    await victimPage.waitForURL(/\/login/);
    await expect(
      victimPage.getByRole("button", { name: "Sign In" })
    ).toBeVisible();

    // Password login is refused while deactivated (same generic error as
    // wrong credentials — deactivation is not advertised).
    const freshContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const freshPage = await freshContext.newPage();
    await freshPage.goto("/login");
    await freshPage.locator("#email").fill(QA_USER.email);
    await freshPage.locator("#password").fill(QA_USER.password);
    await freshPage.getByRole("button", { name: /sign in/i }).click();
    await expect(
      freshPage.getByText("Invalid email or password")
    ).toBeVisible();
    expect(new URL(freshPage.url()).pathname).toBe("/login");

    // Reactivate → login works again, asserted on the browser context that
    // held the stale cookie: zero manual cookie clearing required.
    await row.getByRole("button", { name: "Reactivate" }).click();
    await expect(row.getByRole("button", { name: "Deactivate" })).toBeVisible();
    await loginAsRoomLens(victimPage);

    await victimContext.close();
    await freshContext.close();
  });
});
