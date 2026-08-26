import { resolve } from "path";
import { defineConfig, devices } from "@playwright/test";
import { loadAppHostingEnv } from "./scripts/apphosting-env.mjs";

/**
 * Two ways to run:
 *
 * 1. Local suite (default) — `npm run test:e2e`, or equivalently a bare
 *    `npx playwright test` / `--headed` / `--ui`.
 *    Boots the app on port 3200 (so it never collides with the dev server on
 *    3000 or the pmos website on 3100) against the pmos_test database. Env
 *    comes from test-apphosting.yaml, loaded by this config and passed to
 *    the webServer — no wrapper script required.
 *
 * 2. Prod smoke (DEFERRED — not scheduled anywhere yet; Daniel wants to see
 *    local behavior first) — `npm run test:e2e:prod`
 *    Runs only tests tagged @smoke against PROD_BASE_URL. No webServer, no DB
 *    access — smoke tests must be read-only-safe (login, navigate, assert
 *    render) and scoped to the RoomLens QA org. Without PROD_BASE_URL it
 *    refuses to run.
 */

// Test env for the webServer, loaded HERE (not only in the npm script) so
// `npx playwright test`, `--headed`, and `--ui` behave identically to
// `npm run test:e2e`. Without this, a bare playwright invocation boots the
// app with no DISABLE_LOGIN=false (login is disabled by default) and no
// DATABASE_URL. In CI the yaml is absent — loadAppHostingEnv returns {}
// and the job-level env applies instead. Yaml values win over inherited
// shell env, same as the with-apphosting-env wrapper (override: true), so
// a stray DATABASE_URL in someone's shell can never point tests at the
// dev database.
const TEST_ENV = loadAppHostingEnv(
  resolve(__dirname, "test-apphosting.yaml")
);

// 3000 = dev server, 3100 = pmos website — tests get their own port.
const PORT = Number(process.env.PW_PORT ?? 3200);
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
        // Playwright merges this over the inherited process env, so all
        // entry points (npm script, bare npx, --ui, --headed) get the same
        // test env. Empty object in CI (no yaml) — job env passes through.
        env: TEST_ENV,
        url: LOCAL_BASE_URL,
        // Never silently reuse a server that might be pointed at the dev DB.
        reuseExistingServer: false,
        timeout: 300_000,
      },
});
