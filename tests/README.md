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

## Prod smoke testing (DEFERRED)

On hold until the local suite has proven itself — nothing prod-related is
scheduled or required right now. The pieces already exist for when Daniel
turns it on: the `prod-smoke` Playwright project (`npm run test:e2e:prod`,
refuses to run without `PROD_BASE_URL`; only `@smoke`-tagged tests),
`scripts/seed-roomlens.mjs` for deliberately seeding the RoomLens QA org in
prod, and a CI job sketch in the workflow header comment. Until then, keep
tagging read-only-safe tests `@smoke` so the suite is ready.

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
- Need fixture data? Extend `scripts/seed-roomlens.mjs` (keep it idempotent,
  RoomLens-scoped, obviously synthetic).
- Tag a test `@smoke` ONLY if it is read-only-safe in production: login,
  navigate, assert pages render. No creates, edits, deletes, or AI calls.
  Everything else stays untagged (local project only).

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
