import { resolve } from "path";
import { loadAppHostingEnv } from "../../scripts/apphosting-env.mjs";

/**
 * Single source of truth for the local test environment. Both
 * playwright.config.ts (to boot the webServer) and global-setup.ts (to
 * validate before any test runs) import from here, so they can never
 * disagree about what env the app actually gets.
 */

/** Values from test-apphosting.yaml; {} when the file is absent (CI). */
export const TEST_ENV = loadAppHostingEnv(
  resolve(__dirname, "../../test-apphosting.yaml")
);

// 3000 = dev server, 3100 = pmos website — tests get their own port.
export const PORT = Number(process.env.PW_PORT ?? 3200);
export const LOCAL_BASE_URL = `http://localhost:${PORT}`;

/**
 * The env exactly as the webServer child will see it: Playwright spawns it
 * with { ...process.env, ...webServer.env }, yaml winning over shell env.
 */
export const RESOLVED_ENV: Record<string, string | undefined> = {
  ...process.env,
  ...TEST_ENV,
};
