import { test, expect } from "@playwright/test";
import { loginAsRoomLens } from "./helpers";

/**
 * Sanity suite: the login page renders and the seeded RoomLens user can
 * sign in and see the app shell.
 */

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});

test("RoomLens user logs in and sees the app shell", async ({
  page,
}) => {
  await loginAsRoomLens(page);
  // Dashboard stat cards double as the app shell sanity check.
  await expect(page.getByRole("link", { name: /Documents/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Releases/ })).toBeVisible();
});

// Docs/Releases navigation moved to all-pages.spec.ts (strict superset:
// per-page element + no login bounce + no 404/error boundary). Subsumed
// test deleted 2026-08-26 per the subsume rule in tests/README.md.
