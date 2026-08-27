# PM-OS app — project instructions

This repo is the PM-OS product (Next.js 16 + Prisma + Postgres on Firebase App Hosting).
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
- Production testing is out of scope for now — see git history when we revisit.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
