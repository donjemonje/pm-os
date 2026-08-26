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

- `npm run test:e2e` — full suite. Boots the app on port 3100 (not 3000, so
  your dev server keeps running) against `pmos_test`.
- `npm run test:e2e:ui` — same, with the Playwright UI for debugging.
- `npm run test:e2e:prod` — only tests tagged `@smoke`, against production.
  Requires `PROD_BASE_URL`, `QA_USER_EMAIL`, `QA_USER_PASSWORD` in env.
  Normally this runs from CI, not your machine.

Schema changed in your branch? Re-run `npm run test:db:setup` (db push is
idempotent).

## Scheduled runs

`.github/workflows/e2e.yml` runs the full suite plus prod smoke on Sun, Tue,
Thu at 02:00 UTC, and on manual dispatch (Actions tab → e2e → Run workflow).

## Adding tests in a feature session

- 2–4 e2e tests per feature, critical paths only. Part of the definition of
  done — write them on the feature branch, not after.
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
removed in the 2FA branch, not left red for someone else. There is no
separate QA owner; the feature session that changed the behavior owns the
test change.

## Review feedback → tests

When review comments on a feature surface a real failure mode, add a test for
it in the same session while the context is fresh.
