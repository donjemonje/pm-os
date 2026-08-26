import { test, expect } from "@playwright/test";
import { loginAsRoomLens } from "./helpers";

/**
 * Sanity suite. Tests tagged @smoke also run against production
 * (prod-smoke project) and therefore must stay read-only-safe:
 * login, navigate, assert render. No creates, edits, or deletes.
 */

test("login page renders @smoke", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});

test("RoomLens user logs in and sees the app shell @smoke", async ({
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
