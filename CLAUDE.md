# PM-OS app — project instructions

This repo is the PM-OS product (Next.js 15 + Prisma + Postgres on Firebase App Hosting).
- Marketing site: separate repo `pmos-website` (pm-os.io)
- VP agents, memories, office docs: separate repo `pmos-office`

## Rules
- Client-facing model is called "PMOS AI" in product/UI copy, never "Claude".
- Keyboard UX: Enter = confirm, Esc = cancel, Cmd+Enter in textareas.
- Never commit `.env*`, `dev-apphosting.yaml`, or `data/` — they hold secrets / customer data.
- Local dev: `npm run dev` loads env from `dev-apphosting.yaml` (gitignored). To create it: copy `apphosting.yaml`, replace each `secret:` with a local `value:`.
