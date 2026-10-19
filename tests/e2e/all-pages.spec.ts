import { test, expect } from "@playwright/test";
import {
  expectAppPageRenders,
  loginAsRoomLens,
  loginWithTotp,
  seedQaOrgWithUser,
  withTestDb,
} from "./helpers";

/**
 * Page-coverage suite: log in once as the seeded RoomLens user, then visit
 * every reachable App Router page and assert each actually renders (a real
 * page-specific element, no bounce to /login, no 404 / error boundary).
 *
 * Route inventory (src/app/**\/page.tsx) and why some are not visited here:
 * - /                       covered: sends a signed-in user to their landing
 *                           page (first ON surface in menu order,
 *                           src/lib/landing.ts) — /ideas for an Ideas org,
 *                           see the AUTH-21 block below.
 * - /login                  covered as a redirect: the login page sends a
 *                           signed-in user through "/" to the same landing.
 *                           The logged-out /login render lives in
 *                           auth.spec.ts. (No /register: sign-up is
 *                           invite-only.)
 * - /admin, /admin/users,   skipped as app pages: PM-OS Admin requires
 *   /admin/enablements,     User.role === PMOS_ADMIN; the seeded RoomLens
 *   /admin/ideas
 *                           user is a regular USER, so these must 404 for
 *                           them (asserted below). Admin-role coverage lives
 *                           in the admin feature's own spec.
 * - /login/2fa              covered in two-factor.spec.ts (challenge +
 *                           enrollment). Not swept here: middleware does not
 *                           redirect a fully verified user off /login/2fa —
 *                           documented behavior, deliberately untested.
 * - /docs/[id]              skipped: the RoomLens seed creates no documents,
 *                           and this suite stays read-only. Revisit if
 *                           seed-test-db.mjs ever seeds a document.
 * - /ideas, /settings/ideas IDEAS_ENABLED=false in the test env — asserted
 *                           as 404 below (the env guard pins the flag).
 * - /settings/google-drive  covered: legacy route, must redirect to
 *                           /settings/jira.
 * - /forgot-password,       public routes (proxy PUBLIC_PATHS); logged-out
 *   /reset-password         renders covered in auth.spec.ts (forgot form via
 *                           the /login link) and google-sso.spec.ts G3
 *                           (reset form with a token). Not in the logged-in
 *                           redirect loop below: the proxy does not bounce a
 *                           signed-in user off them (only the /login page
 *                           itself redirects, server-side) — same class as
 *                           the /login/2fa note above.
 */

test("logged-in user can open every app page", async ({ page }) => {
  await loginAsRoomLens(page);

  await expectAppPageRenders(page, "/dashboard", (p) =>
    p.getByRole("heading", { name: "Dashboard" })
  );
  await expectAppPageRenders(page, "/chat", (p) =>
    p.getByRole("heading", { name: "Chat" })
  );
  await expectAppPageRenders(page, "/docs", (p) =>
    p.getByRole("heading", { name: "Documents" })
  );
  await expectAppPageRenders(page, "/docs/new", (p) =>
    p.getByRole("heading", { name: "Create user manual" })
  );
  await expectAppPageRenders(page, "/releases", (p) =>
    p.getByRole("heading", { name: "Releases" })
  );
  await expectAppPageRenders(page, "/settings/jira", (p) =>
    p.getByRole("heading", { name: "Settings" })
  );
  // Integrations content confirms the settings child page rendered, not
  // just the settings layout.
  await expect(
    page.getByText("Connect Jira and Google Drive to import tickets and PRDs.")
  ).toBeVisible();

  // Legacy route: must land on the integrations settings page.
  await page.goto("/settings/google-drive");
  await page.waitForURL("**/settings/jira**");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

// AUTH-21 "Signed-in user on / and /login" (spec audit 2026-10-19). Landing
// = the first ON surface in menu order (src/lib/landing.ts). Since 2.0.0 the
// env default for dashboard is off, so an org with Ideas on lands on /ideas.
// The suite's env pins DASHBOARD_ENABLED on (the sweep above asserts the
// page renders), which is why RoomLens — and the Kela QA org, whose override
// only sets ideas — land on /dashboard HERE; the old version of this test
// asserted /dashboard and passed for that env reason, not the product rule.
// To observe the rule, this block seeds an org with the prod-parity override
// (ideas on; dashboard, docs, chat off — the same per-org mechanism Admin →
// Enablements uses) and its own TOTP user, and removes both afterwards.
// RoomLens' dashboard landing stays covered by loginAsRoomLens (waits for the
// Dashboard heading) and admin-delete-user-org.spec AD4 (overrides cleared →
// "/" → /dashboard).
const LANDING_ORG = { orgName: "QA-LANDING Org", slug: "qa-landing-org" };
const LANDING_FEATURES = { ideas: true, dashboard: false, docs: false, chat: false };
const LANDING_USER = {
  name: "QA Landing User",
  email: "qa+landing@pm-os.io",
  password: "Landing-qa-pass1",
  totpSecret: "MFXGSZLTNRQW4ZDJNZTSA5DFON2CAU3F", // synthetic, test-only
};

test.describe("AUTH-21 landing for an Ideas org", () => {
  test.beforeAll(async () => {
    await withTestDb((db) =>
      seedQaOrgWithUser(db, {
        ...LANDING_ORG,
        features: LANDING_FEATURES,
        user: LANDING_USER,
      })
    );
  });

  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await db.user.deleteMany({
        where: {
          OR: [{ email: LANDING_USER.email }, { organization: { slug: LANDING_ORG.slug } }],
        },
      });
      await db.organization.deleteMany({ where: { slug: LANDING_ORG.slug } });
    });
  });

  test("root and auth routes send a signed-in user of an Ideas org to /ideas", async ({
    page,
  }) => {
    // Login itself resolves through "/" after the 2FA challenge.
    await loginWithTotp(page, LANDING_USER);
    await expect(page).toHaveURL(/\/ideas$/);

    for (const path of ["/", "/login"]) {
      await page.goto(path);
      await page.waitForURL("**/ideas");
      await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
    }
  });
});

// Replaces the former CRM auth-realm test: the CRM (own login, own cookie)
// became PM-OS Admin on the main app session, gated by User.role. A regular
// user must get a 404 — admin existence is not advertised.
test("regular app session does not grant PM-OS Admin access", async ({
  page,
}) => {
  await loginAsRoomLens(page);

  for (const path of ["/admin", "/admin/users", "/admin/enablements", "/admin/ideas"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should 404 for role USER`).toBe(404);
    await expect(page.getByText("This page could not be found")).toBeVisible();
  }
});

// The env guard (global-setup.ts) pins IDEAS_ENABLED off, so this is
// deterministic. If the ideas feature ships enabled, update the guard and
// this test together.
test("ideas routes 404 while IDEAS_ENABLED is off", async ({ page }) => {
  await loginAsRoomLens(page);

  for (const path of ["/ideas", "/settings/ideas"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should 404 with the flag off`).toBe(404);
    await expect(page.getByText("This page could not be found")).toBeVisible();
  }
});
