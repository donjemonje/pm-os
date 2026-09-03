# Production changes by version

Everything a release needs in production **beyond deploying the code** —
secrets, DNS, schema pushes, data fixes, per-org flags, third-party consoles.
A new app version does not resolve these by itself; someone has to do them.

Rules (see the `/feature` command):
- A feature that needs any such step adds it here, under the version it ships
  in, before its review handoff. The handoff message repeats the list.
- The version comes from `package.json` (`version`). `main` carries what
  production runs; `development` carries the upcoming version (the first
  feature of a new version bumps it). Release = development → main, tagged
  `vX.Y.Z`.
- Tick items as they are done in prod; keep done items for the record.

---

## 1.0.0 (production, current)

Baseline: what app.pm-os.io runs as of 2026-09-01 (rollout caught main up with
development; login verified). Known as 1.0.0 by convention — package.json on
`main` still says 0.1.0 and nothing in the app shows a version; the visible
version starts with 2.0.0. No hotfix (Daniel, 2026-09-03).

- [ ] Google SSO credentials check in prod (open since the 09-01 rollout).
- ~~RESEND credentials~~ — superseded: 2.0.0 sends over Workspace SMTP.

---

## 2.0.0 (upcoming)

Auth model: invite-only sign-up, Google always on, email over Workspace SMTP,
user/org delete, Enablements matrix. Branch: `feature/admin-delete-user-org`.

**Before deploy**
- [ ] Secret Manager: create `pmos-smtp-password` = Google app password of the
      `support@pm-os.io` Workspace user; grant the App Hosting service account
      access. (`apphosting.yaml` references it; SMTP_USER = support@pm-os.io.)
- [ ] Google Cloud → OAuth consent screen: published (not "Testing") so
      external Gmail users can sign in with Google.
- [x] DNS for pm-os.io (done 2026-09-03): SPF `v=spf1 include:_spf.google.com ~all`,
      DMARC `_dmarc` `v=DMARC1; p=none; rua=mailto:support@pm-os.io`; DKIM was
      already on. Later: tighten DMARC to `p=quarantine`.
- [x] Google Workspace: `support@pm-os.io` created as its own user with the
      PM-OS logo as profile photo (done 2026-09-03).

**At deploy (after merge to main)**
- [ ] Schema push to Cloud SQL: drops `Organization.inviteCode` and the
      `SystemFlag` table — run `prisma db push --accept-data-loss` against prod.
- [ ] Rename the prod admin user to a full name (invites read
      "<name> invited you"): `update "User" set name='Daniel East' where email='daniel@pm-os.io';`

**Right after deploy**
- [ ] Enablements: Docs, Chat, Dashboard are now OFF by default (prod yaml sets
      them "false"). Turn them On per organization (RoomLens, Kela) in
      PM-OS Admin → Enablements, or the pages 404 and sign-in lands on Releases.
- [ ] Send one test invite to an outside Gmail address; "Show original" must
      read SPF/DKIM/DMARC pass and the link must point at app.pm-os.io.

**Removed / no action**
- `ALLOW_SIGNUP` is gone from the config (sign-up is invite-only).
- `DISABLE_GOOGLE_LOGIN` stays the only Google switch (prod: "false").
- "Google SSO skips 2FA" defaults ON per org; no env needed.
