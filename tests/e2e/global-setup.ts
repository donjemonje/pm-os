import { LOCAL_BASE_URL, PORT, RESOLVED_ENV } from "./test-env";

/**
 * Env guard: refuses to start the suite when the resolved test env is wrong,
 * instead of letting the app silently boot misconfigured (the "login is not
 * enabled" incident). Validates the SAME merged env the webServer gets
 * (shell env + test-apphosting.yaml, yaml wins), so it works both locally
 * (yaml) and in CI (workflow job env, no yaml) without false positives.
 *
 * Feature-flag expectations are derived from what the specs assert:
 *   - DISABLE_LOGIN=false  — every spec logs in (auth.spec, all-pages.spec)
 *   - IDEAS_ENABLED off    — all-pages.spec asserts /ideas 404s
 * If a new spec assumes another flag value, add the check here in the same
 * branch.
 */

const FIX_YAML =
  "fix: copy test-apphosting.example.yaml to test-apphosting.yaml in the repo " +
  "root (in CI: set it in the job env of .github/workflows/e2e.yml)";

// Mirrors src/lib/feature-flags.ts semantics.
const isFalseLike = (v?: string) =>
  ["false", "0"].includes(v?.trim().toLowerCase() ?? "");
const isTrueLike = (v?: string) =>
  ["true", "1"].includes(v?.trim().toLowerCase() ?? "");
const show = (v?: string) => (v === undefined ? "<unset>" : `"${v}"`);

export default function validateTestEnv(): void {
  const env = RESOLVED_ENV;
  const problems: string[] = [];

  // Login must be enabled (DISABLE_LOGIN is default-closed: unset = disabled).
  if (!isFalseLike(env.DISABLE_LOGIN)) {
    problems.push(
      `DISABLE_LOGIN resolves to ${show(env.DISABLE_LOGIN)} — login would be ` +
        `disabled and every test fails at sign-in; ${FIX_YAML}`
    );
  }

  // Tests may only ever run against the dedicated pmos_test database.
  if (!env.DATABASE_URL?.trim()) {
    problems.push(`DATABASE_URL is not set — the app cannot reach a database; ${FIX_YAML}`);
  } else {
    let dbName: string | undefined;
    try {
      dbName = decodeURIComponent(
        new URL(env.DATABASE_URL).pathname.replace(/^\//, "")
      );
    } catch {
      problems.push(`DATABASE_URL is not a parseable URL; ${FIX_YAML}`);
    }
    if (dbName !== undefined && dbName !== "pmos_test") {
      problems.push(
        `DATABASE_URL points at database "${dbName}" — tests only ever run ` +
          `against "pmos_test" (NEVER the dev database "pmos"); ${FIX_YAML}`
      );
    }
  }

  // Session cookies can't be signed without it — login would 500.
  if (!env.SESSION_SECRET?.trim()) {
    problems.push(`SESSION_SECRET is not set — login would fail server-side; ${FIX_YAML}`);
  }

  // Port sanity: never the dev server (3000) or the pmos website (3100),
  // and the app's own URL must agree with where Playwright boots it.
  if (PORT === 3000 || PORT === 3100) {
    problems.push(
      `test port ${PORT} is reserved (3000 = dev server, 3100 = pmos website) ` +
        `— unset PW_PORT or pick another port (default 3200)`
    );
  }
  if (env.NEXT_PUBLIC_APP_URL?.trim() !== LOCAL_BASE_URL) {
    problems.push(
      `NEXT_PUBLIC_APP_URL resolves to ${show(env.NEXT_PUBLIC_APP_URL)} but the ` +
        `suite boots the app at ${LOCAL_BASE_URL} — make them match ` +
        `(default http://localhost:3200); ${FIX_YAML}`
    );
  }

  // 2FA is mandatory: every login goes through /login/2fa, and the seed
  // encrypts the fixed test TOTP secret with this key. A missing/malformed
  // key would make every code verification fail with a confusing error.
  const totpKey = env.TOTP_ENC_KEY?.trim();
  if (!totpKey) {
    problems.push(
      `TOTP_ENC_KEY is not set — 2FA secrets cannot be decrypted and every ` +
        `login fails at the TOTP challenge; ${FIX_YAML}`
    );
  } else if (!/^[0-9a-fA-F]{64}$/.test(totpKey)) {
    problems.push(
      `TOTP_ENC_KEY must be exactly 64 hex characters (32 bytes), got ` +
        `${totpKey.length} chars — use the fixed test key from ` +
        `test-apphosting.example.yaml; ${FIX_YAML}`
    );
  }

  // all-pages.spec.ts asserts /ideas and /settings/ideas return 404.
  if (isTrueLike(env.IDEAS_ENABLED)) {
    problems.push(
      `IDEAS_ENABLED resolves to ${show(env.IDEAS_ENABLED)} but ` +
        `all-pages.spec.ts asserts the ideas routes 404 — set it to "false", ` +
        `or update that spec together with this check`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: the test environment is misconfigured ` +
        `(${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  ✗ ${p}`).join("\n")
    );
  }

  console.log(
    `[test-env] OK — login enabled, database pmos_test, app at ${LOCAL_BASE_URL}, ideas off, TOTP key set`
  );
}
