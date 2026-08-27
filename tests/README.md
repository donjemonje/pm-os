# e2e tests

Playwright end-to-end tests for PM-OS. Read this before adding tests in a
feature session.

## One-time local setup

1. Copy the env template and set your Postgres user:
   ```
   cp test-apphosting.example.yaml test-apphosting.yaml
   ```
   Edit `DATABASE_URL` (test-apphosting.yaml is gitignored — never commit it).
2. Create + seed the test database:
   ```
   npm run test:db:setup
   ```
   This creates `pmos_test` locally, pushes the Prisma schema, and seeds the
   RoomLens QA org with synthetic users (`qa+roomlens@pm-os.io`,
   `qa+roomlens-2@pm-os.io`). It never touches the dev database `pmos`.

## Running

- `npm run test:e2e` — full suite. Boots the app on port 3200 (3000 is the
  dev server, 3100 is the pmos website — both keep running) against
  `pmos_test`.
- `npm run test:e2e:ui` — same, with the Playwright UI for debugging.
- Bare `npx playwright test` (plus `--headed`, `--ui`, `-g <name>`) works
  too: playwright.config.ts loads test-apphosting.yaml itself and passes it
  to the webServer, so every entry point gets identical env. The npm scripts
  are thin aliases.

Schema changed in your branch? Re-run `npm run test:db:setup` (db push is
idempotent).

## Mandatory 2FA

2FA is mandatory for every account: every login lands on `/login/2fa`
(enrolled user → 6-digit TOTP challenge; un-enrolled user → inline QR
enrollment, first confirmed code enrolls). What this means for tests:

- `loginAsRoomLens` (helpers.ts) handles the whole flow — credentials, the
  TOTP challenge with a real generated code, and the single-use guard.
  **Never re-implement login in a spec.** The lower-level TOTP utilities
  live in `tests/e2e/two-factor-helpers.ts`.
- Seeded 2FA states: `qa+roomlens@pm-os.io` is **enrolled** with the fixed
  synthetic secret `TEST_TOTP_SECRET` (two-factor-helpers.ts, mirrored in
  scripts/seed-test-db.mjs); `qa+roomlens-2@pm-os.io` is **un-enrolled** and
  reserved for the enrollment flow (two-factor.spec.ts T6). The secret is
  stored encrypted with the fixed test `TOTP_ENC_KEY` from
  test-apphosting(.example).yaml / the CI job env — the seed calls the
  app's own `encryptTotpSecret`, which is why it runs under
  `node --experimental-strip-types`. Secret and key are synthetic,
  test-only values; the env guard checks the key is present and 64 hex
  chars.
- Timing: TOTP codes are only valid in their 30-second window and are
  single-use per window. Helpers wait for window headroom (and for a fresh
  window between back-to-back logins of the same user) — those waits are
  **by design**, not flakiness. Don't "fix" them with shorter sleeps.
- The seed resets totp state on every run (re-encrypts the fixed secret,
  clears `totpLastUsedStep`, un-enrolls the second user, deletes both
  users' sessions), and two-factor.spec.ts does the same reset in its
  `beforeAll` — so the suite is rerunnable without re-seeding.

## The env guard

The suite refuses to start on a wrong environment instead of letting the
app boot misconfigured. `tests/e2e/global-setup.ts` validates the resolved
env (shell env + test-apphosting.yaml, yaml wins — the exact env the app
gets) before any test runs, and fails with one line per problem:

- `DISABLE_LOGIN` resolves to `false` (login enabled — it is disabled by
  default when unset).
- `DATABASE_URL` is set and its database name is exactly `pmos_test` —
  hard fail otherwise, so tests can never touch the dev database.
- `SESSION_SECRET` is set (login would 500 without it).
- The port is not 3000/3100 and `NEXT_PUBLIC_APP_URL` matches where
  Playwright boots the app (default `http://localhost:3200`).
- `TOTP_ENC_KEY` is set and exactly 64 hex chars (2FA is mandatory — a
  missing/malformed key fails every login at the TOTP challenge).
- Feature flags match what the specs assert (currently: `IDEAS_ENABLED`
  off, because all-pages.spec.ts asserts the ideas routes 404). If your
  spec assumes another flag value, add the check to global-setup.ts in the
  same branch.

In CI there is no yaml — the guard validates the workflow job env the same
way. Most failures mean: copy `test-apphosting.example.yaml` to
`test-apphosting.yaml`.

## Scheduled runs

`.github/workflows/e2e.yml` runs the full suite on Sun, Tue, Thu at
02:00 UTC, and on manual dispatch (Actions tab → e2e → Run workflow). It
needs no GitHub secrets.

Production testing is out of scope for now — see git history when we
revisit.

## Adding tests in a feature session

QA is agent-run (roster: `pmos-office/office/team-roster.md`). Before
Daniel's review, every feature session runs:

1. **Omri** (`qa-engineer`) — writes the feature's e2e tests and runs the
   full suite.
2. **Dana** (`qa-manager`) — handles dedup/subsume, gives QA sign-off, and
   appends the feature's row to `tests/QA-LOG.md` (feature branch, date,
   tests added/updated, QA'd by).

Ground rules:

- 2–4 e2e tests per feature, critical paths only. Part of the definition of
  done — write them on the feature branch, not after.
- No QA-LOG.md row, no review.
- Put them in `tests/e2e/<feature>.spec.ts`. Use `loginAsRoomLens` from
  `helpers.ts` instead of re-implementing login.
- Need fixture data? Extend `scripts/seed-test-db.mjs` (keep it idempotent,
  RoomLens-scoped, obviously synthetic).

## The subsume rule

If your feature breaks or replaces an existing test, update or delete that
test in the same branch — the suite must be green before review. Example: a
2FA login flow supersedes a plain-login test; the plain test gets updated or
removed in the 2FA branch, not left red for someone else. The feature
session that changed the behavior owns the test change — Dana verifies the
dedup/subsume call at sign-off.

## Review feedback → tests

When review comments on a feature surface a real failure mode, add a test for
it in the same session while the context is fresh.
