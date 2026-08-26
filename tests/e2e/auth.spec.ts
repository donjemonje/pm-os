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

test("logged-in user can navigate to Docs and Releases", async ({ page }) => {
  await loginAsRoomLens(page);

  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

  await page.goto("/releases");
  await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
});
