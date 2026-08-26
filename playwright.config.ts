import { defineConfig, devices } from "@playwright/test";
import { LOCAL_BASE_URL, PORT, TEST_ENV } from "./tests/e2e/test-env";

/**
 * Local e2e suite — `npm run test:e2e`, or equivalently a bare
 * `npx playwright test` / `--headed` / `--ui`.
 *
 * Boots the app on port 3200 (so it never collides with the dev server on
 * 3000 or the pmos website on 3100) against the pmos_test database. Env
 * comes from test-apphosting.yaml, loaded by this config and passed to the
 * webServer — no wrapper script required.
 *
 * Production testing is out of scope for now — see git history when we
 * revisit.
 */

// Test env for the webServer comes from tests/e2e/test-env.ts, loaded HERE
// (not only in the npm script) so `npx playwright test`, `--headed`, and
// `--ui` behave identically to `npm run test:e2e`. Without this, a bare
// playwright invocation boots the app with no DISABLE_LOGIN=false (login is
// disabled by default) and no DATABASE_URL. In CI the yaml is absent —
// TEST_ENV is {} and the job-level env applies instead. Yaml values win
// over inherited shell env, same as the with-apphosting-env wrapper
// (override: true), so a stray DATABASE_URL in someone's shell can never
// point tests at the dev database. tests/e2e/global-setup.ts validates the
// resolved env and refuses to start the suite when it is wrong.

export default defineConfig({
  testDir: "./tests/e2e",
  // Env guard: fails loudly before any test when the resolved env is wrong
  // (wrong DB, login disabled, port clash, flag mismatch).
  globalSetup: "./tests/e2e/global-setup.ts",
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
  projects: [
    {
      name: "local",
      use: { ...devices["Desktop Chrome"], baseURL: LOCAL_BASE_URL },
    },
  ],
  webServer: {
    // CI runs the production build for parity; local runs the dev server
    // for speed.
    command: process.env.CI
      ? `npx next build && npx next start -p ${PORT}`
      : `npx next dev -p ${PORT}`,
    // Playwright merges this over the inherited process env, so all entry
    // points (npm script, bare npx, --ui, --headed) get the same test env.
    // Empty object in CI (no yaml) — job env passes through.
    env: TEST_ENV,
    url: LOCAL_BASE_URL,
    // Never silently reuse a server that might be pointed at the dev DB.
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
