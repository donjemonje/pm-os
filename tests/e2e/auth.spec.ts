import { test, expect } from "@playwright/test";

/**
 * Sanity suite: the login page renders. Everything past the credentials
 * form is covered elsewhere (see subsume notes below).
 */

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});

// "RoomLens user logs in and sees the app shell" — subsumed by
// two-factor.spec.ts T3 (full login through the mandatory TOTP challenge,
// app shell asserted) and the all-pages.spec.ts sweep (every page after
// loginAsRoomLens). Subsumed test deleted 2026-08-26 per the subsume rule
// in tests/README.md.

// Docs/Releases navigation moved to all-pages.spec.ts (strict superset:
// per-page element + no login bounce + no 404/error boundary). Subsumed
// test deleted 2026-08-26 per the subsume rule in tests/README.md.
