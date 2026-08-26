# QA log

Append-only, kept by Dana (`qa-manager`). Every feature branch adds its row
BEFORE review — no row, no review. Newest entries at the bottom.

| Feature branch | Date | Tests added/updated | QA'd by |
| --- | --- | --- | --- |
| feature/tests-setup | 2026-08-26 | Added tests/e2e/auth.spec.ts (login renders, RoomLens login + app shell, docs/releases nav) | Omri |
| feature/tests-setup | 2026-08-26 | Added tests/e2e/all-pages.spec.ts (all-pages sweep, logged-in redirects, CRM auth-realm isolation, ideas 404s) + expectAppPageRenders helper; removed auth.spec.ts docs/releases nav test (subsumed by the sweep) | Dana & Omri |
| feature/tests-setup | 2026-08-26 | Infra, no test changes: env loading moved into playwright.config.ts (bare npx/--ui runs match npm script); env guard in global-setup.ts + test-env.ts (login enabled, pmos_test only, SESSION_SECRET, port/app-URL match, IDEAS_ENABLED off). Guard failure path verified by removing yaml | Dana & Omri |
| feature/tests-setup | 2026-08-26 | Prod-testing removal (Daniel's order), no assertion changes: prod-smoke project + scripts + smoke tags stripped; seed renamed scripts/seed-test-db.mjs, env overrides removed, hardcoded synthetic creds, refuses NODE_ENV=production; env guard unchanged. Repo grep clean for prod terms | Dana & Omri |
| feature/npm-audit-fixes | 2026-08-26 | None added — dependency/security chore, no new product behavior (audit bumps; Next 15.5.23→16.3.2; middleware.ts→proxy.ts; lint script removed; jsx react-jsx). Existing suite already covers the risky surface: redirect/realm specs exercise the renamed proxy, all-pages sweep covers rendering. Full suite re-run green on Next 16 (6/6, 13.0s); clean build 48/48 pages. Accepted residual: deepmerge-ts <8 via @prisma/config pin (dev CLI only) | Dana |
