import { defineConfig, devices } from "@playwright/test";

/**
 * Two ways to run:
 *
 * 1. Local suite (default) — `npm run test:e2e`
 *    Boots the app on port 3100 (so it never collides with the dev server on
 *    3000) against the pmos_test database. Env comes from test-apphosting.yaml
 *    via the npm script; the webServer child process inherits it.
 *
 * 2. Prod smoke — `npm run test:e2e:prod`
 *    Runs only tests tagged @smoke against PROD_BASE_URL. No webServer, no DB
 *    access — smoke tests must be read-only-safe (login, navigate, assert
 *    render) and scoped to the RoomLens QA org.
 */

const PORT = Number(process.env.PW_PORT ?? 3100);
const LOCAL_BASE_URL = `http://localhost:${PORT}`;
const IS_PROD_SMOKE = process.env.PW_PROD_SMOKE === "1";
const PROD_BASE_URL = process.env.PROD_BASE_URL?.trim();

if (IS_PROD_SMOKE && !PROD_BASE_URL) {
  throw new Error(
    "Prod smoke mode needs PROD_BASE_URL (e.g. https://app.pm-os.io). Refusing to guess."
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  // Small suite sharing one seeded DB — serial keeps it deterministic.
  // Revisit workers when the suite grows past ~20 tests.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: IS_PROD_SMOKE
    ? [
        {
          name: "prod-smoke",
          grep: /@smoke/,
          use: { ...devices["Desktop Chrome"], baseURL: PROD_BASE_URL },
        },
      ]
    : [
        {
          name: "local",
          use: { ...devices["Desktop Chrome"], baseURL: LOCAL_BASE_URL },
        },
      ],
  webServer: IS_PROD_SMOKE
    ? undefined
    : {
        // CI runs the production build for parity; local runs the dev server
        // for speed. Env (DATABASE_URL etc.) is inherited from the parent
        // process — locally that's with-apphosting-env + test-apphosting.yaml.
        command: process.env.CI
          ? `npx next build && npx next start -p ${PORT}`
          : `npx next dev -p ${PORT}`,
        url: LOCAL_BASE_URL,
        // Never silently reuse a server that might be pointed at the dev DB.
        reuseExistingServer: false,
        timeout: 300_000,
      },
});
