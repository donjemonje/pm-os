# PM-OS app — project instructions

This repo is the PM-OS product (Next.js 15 + Prisma + Postgres on Firebase App Hosting).
- Marketing site: separate repo `pmos-website` (pm-os.io)
- VP agents, memories, office docs: separate repo `pmos-office`

## Rules
- Client-facing model is called "PMOS AI" in product/UI copy, never "Claude".
- Keyboard UX: Enter = confirm, Esc = cancel, Cmd+Enter in textareas.
- Never commit `.env*`, `dev-apphosting.yaml`, or `data/` — they hold secrets / customer data.
- Local dev: `npm run dev` loads env from `dev-apphosting.yaml` (gitignored). To create it: copy `apphosting.yaml`, replace each `secret:` with a local `value:`.

## Testing

- Every feature branch ships 2–4 Playwright e2e tests for its critical paths — part of the definition of done. See `tests/README.md`.
- QA workflow (before Daniel's review): every feature session runs the `qa-engineer` agent (Omri) to write and run the tests, then the `qa-manager` agent (Dana) for dedup/subsume, sign-off, and the `tests/QA-LOG.md` row. Roster: `pmos-office/office/team-roster.md`.
- Run locally with `npm run test:e2e` (test DB setup: `npm run test:db:setup`); suite must be green before review.
- If your feature breaks or subsumes an existing test, update or delete it in the same branch.
- Every feature branch appends its row to `tests/QA-LOG.md` (branch, date, tests added/updated, QA'd by) before review.
- Tag tests `@smoke` only if read-only-safe against production (login, navigate, assert render). Prod smoke runs are deferred for now.
