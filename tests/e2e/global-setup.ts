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
 *   - DOCS_ENABLED on      — all-pages.spec asserts /docs renders
 *   - CHAT_ENABLED on      — all-pages.spec asserts /chat renders; admin
 *                            A2 asserts the "On (default)" badge
 *   (docs/chat are on when UNSET — reversed polarity vs IDEAS_ENABLED —
 *   so the usual "no flag env in the yaml" state passes.)
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
  let testDbName: string | undefined;

  // Login must be enabled (DISABLE_LOGIN is default-closed: unset = disabled).
  if (!isFalseLike(env.DISABLE_LOGIN)) {
    problems.push(
      `DISABLE_LOGIN resolves to ${show(env.DISABLE_LOGIN)} — login would be ` +
        `disabled and every test fails at sign-in; ${FIX_YAML}`
    );
  }

  // Tests run against the dedicated pmos_test database (CI, shared local
  // runs) or a feature's own dev clone pmos_ft_<name> (feature QA inside
  // /feature runs on the developer's DB) — NEVER the shared dev DB "pmos".
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
    if (
      dbName !== undefined &&
      dbName !== "pmos_test" &&
      !/^pmos_ft_[a-z0-9_]+$/.test(dbName)
    ) {
      problems.push(
        `DATABASE_URL points at database "${dbName}" — tests only ever run ` +
          `against "pmos_test" or a feature clone "pmos_ft_<name>" (NEVER the ` +
          `shared dev database "pmos"); ${FIX_YAML}`
      );
    }
    testDbName = dbName;
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

  // all-pages.spec.ts asserts /docs, /chat and /dashboard render, and
  // admin.spec A2 asserts chat's env default is on. All three flags are OFF
  // when unset (src/lib/feature-flags.ts, since 2026-09-03), so the test env
  // must pin them on explicitly.
  for (const flag of ["DOCS_ENABLED", "CHAT_ENABLED", "DASHBOARD_ENABLED"] as const) {
    if (!isTrueLike(env[flag])) {
      problems.push(
        `${flag} resolves to ${show(env[flag])} but the suite asserts that ` +
          `surface renders (all-pages.spec.ts, admin.spec.ts A2) — set it to ` +
          `"true" in test-apphosting.yaml (and CI), or update those specs ` +
          `together with this check`
      );
    }
  }

  // google-sso.spec.ts G1 asserts the env-only Google switch: with
  // DISABLE_GOOGLE_LOGIN on, google is absent from the providers list and
  // the authorize endpoint bounces to /login?error=google_sso_disabled.
  if (!isTrueLike(env.DISABLE_GOOGLE_LOGIN)) {
    problems.push(
      `DISABLE_GOOGLE_LOGIN resolves to ${show(env.DISABLE_GOOGLE_LOGIN)} but ` +
        `google-sso.spec.ts G1 asserts Google is hidden by env — set it ` +
        `to "true", or update that spec together with this check`
    );
  }

  // google-sso.spec.ts needs Google to count as "configured" so the env
  // switch is the only gate it observes. Fake creds are fine: the providers
  // listing and the authorize redirect never call Google's servers.
  for (const cred of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
    if (!env[cred]?.trim()) {
      problems.push(
        `${cred} is not set — google-sso.spec.ts needs the fake test creds ` +
          `from test-apphosting.example.yaml so the google provider counts as ` +
          `configured; ${FIX_YAML}`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: the test environment is misconfigured ` +
        `(${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  ✗ ${p}`).join("\n")
    );
  }

  console.log(
    `[test-env] OK — login enabled, database ${testDbName}, app at ${LOCAL_BASE_URL}, ideas off, docs/chat/dashboard pinned on, google hidden by env (fake creds set), TOTP key set`
  );
}
