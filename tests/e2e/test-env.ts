import { resolve } from "path";
import { loadAppHostingEnv } from "../../scripts/apphosting-env.mjs";

/**
 * Single source of truth for the local test environment. Both
 * playwright.config.ts (to boot the webServer) and global-setup.ts (to
 * validate before any test runs) import from here, so they can never
 * disagree about what env the app actually gets.
 */

/** Values from test-apphosting.yaml; {} when the file is absent (CI). */
export const TEST_ENV: Record<string, string> = loadAppHostingEnv(
  resolve(__dirname, "../../test-apphosting.yaml")
);

/**
 * Ops run only (release QA IMP-09, `npm run test:e2e:ops`): the @ops spec
 * needs the SERVER to see a wrong model name, and the yaml wins over shell
 * env — so this is the one shell variable that overrides yaml values. Set
 * PW_OPS_BOGUS_MODEL=<name> and every Anthropic Ideas stage model
 * (IDEAS_CATALOG_MODEL / IDEAS_SPLIT_MODEL / IDEAS_MATCH_MODEL — the
 * pipeline does NOT read VERTEX_MODEL) becomes that name for the webServer.
 * Unset (every other run, CI) = no effect.
 */
export const OPS_BOGUS_MODEL = process.env.PW_OPS_BOGUS_MODEL?.trim() || undefined;
export const OPS_MODEL_VARS = ["IDEAS_CATALOG_MODEL", "IDEAS_SPLIT_MODEL", "IDEAS_MATCH_MODEL"] as const;
if (OPS_BOGUS_MODEL) for (const v of OPS_MODEL_VARS) TEST_ENV[v] = OPS_BOGUS_MODEL;

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
