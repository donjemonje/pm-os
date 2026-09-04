import { createHash, randomBytes } from "crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLensAdmin, QA_ADMIN, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

/**
 * feature/admin-delete-user-org: hard delete of users and organizations from
 * PM-OS Admin, invite-only sign-up (invite email → /invite → set password),
 * "Resend invite", the Access column, the flag-driven landing page, and the
 * docs gate on Releases.
 *
 * AD1  delete user via the row button (window.confirm) → row + DB row gone;
 *      DELETE self → 400; DELETE org without the confirm word → 400; DELETE
 *      the actor's own org → 400; type-"delete" dialog: wrong word + Enter
 *      does nothing, Esc cancels, "delete" + Enter removes the org, its
 *      workspace and its remaining user.
 * AD2  invite by password: POST /api/admin/users creates an invite-pending
 *      user and reports invite { sent: true, delivered: false } (no SMTP in
 *      this env → printed to the server console, only the token HASH is
 *      stored, so the spec inserts its own token the way sendInvitation
 *      does). /invite rejects a garbage token and a reset token of a user
 *      who already has a password; the real invite shows "Complete your
 *      sign-up" with NO Google button (DISABLE_GOOGLE_LOGIN=true, pinned by
 *      the env guard) → "Sign Up with Credentials" → live policy checklist
 *      + disabled submit until valid and matching → API signs the user in
 *      and the page lands on /login/2fa in enrollment mode → token replay
 *      400s and the invite link is dead → Admin row shows "Password".
 * AD3  Access column + resend: "Invite pending" row carries "Resend invite",
 *      "Password" row does not; POST …/invite → 200 for the pending user
 *      (and leaves exactly one live token — older links revoked), 400 for a
 *      user with a password; the UI resend shows the no-SMTP notice.
 * AD4  landing + Releases gate: "/" resolves to the first ON surface in menu
 *      order (dashboard → ideas → docs → chat): dashboard override Off →
 *      /docs; ideas On → /ideas; docs Off → /releases and /api/releases 404
 *      and "/" → /chat; overrides cleared → /dashboard and Releases back.
 *
 * Sibling tokens: resetPassword (password path) and
 * consumePasswordTokenForUser (Google path) both revoke the user's other
 * unused tokens when one is consumed — AD2 asserts the count is 0. (Two
 * live links exist only after a resend whose SMTP send threw; found and
 * fixed 2026-09-03.)
 *
 * Guardrails that depend on activeAdminCount ("last active pmos-admin") are
 * deliberately NOT asserted end-to-end: the self rules fire first for the
 * acting admin, and a developer clone may hold more than one admin — the
 * count rule stays unit-level (admin-guard.ts is dependency-free).
 *
 * State discipline: every fixture is created by the spec itself through the
 * admin API (QA-ADO org names, qa+ado-* emails) and deleted in beforeAll AND
 * afterAll — no leftovers into all-pages.spec (which needs RoomLens with no
 * overrides and "/" → /dashboard) and reruns need no re-seed. All tests
 * write data.
 */

const ROOMLENS_SLUG = "roomlens";

const DELETE_ORG = "QA-ADO Delete Org";
const DEL_1 = "qa+ado-del-1@pm-os.io";
const DEL_2 = "qa+ado-del-2@pm-os.io";

const INVITE_ORG = "QA-ADO Invite Org";
const INV_PENDING = "qa+ado-inv-pending@pm-os.io";
const INV_PENDING_NAME = "QA ADO Invitee";
const INV_PASSWORD = "qa+ado-inv-password@pm-os.io";

const RESEND_ORG = "QA-ADO Resend Org";
const RES_PENDING = "qa+ado-res-pending@pm-os.io";
const RES_PASSWORD = "qa+ado-res-password@pm-os.io";

// Policy-valid (8+, lower, upper, digit, symbol) — lib/password-policy.ts.
const VALID_PASSWORD = "Invitee-pass1";
const SEEDED_STYLE_PASSWORD = "Roomlens-qa-pass1";

const TOKEN_REFUSED = "This reset link is invalid or has expired. Request a new one.";

type OrgListing = {
  id: string;
  name: string;
  slug: string;
  members: { id: string; email: string; hasPassword: boolean; activated: boolean }[];
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Insert a set-password token row exactly as issuePasswordToken stores it
 * (only the SHA-256 hash) and return the raw token the email would carry. */
async function insertToken(
  db: PrismaClient,
  userId: string,
  ttlMs: number
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return raw;
}

async function resetFixtures(): Promise<void> {
  await withTestDb(async (db) => {
    try {
      // Users first (no cascade from org → user), then the orgs (workspace
      // cascades). Tokens/sessions cascade from the users.
      await db.user.deleteMany({
        where: {
          OR: [
            { email: { startsWith: "qa+ado-" } },
            { organization: { slug: { startsWith: "qa-ado-" } } },
          ],
        },
      });
      await db.organization.deleteMany({
        where: { slug: { startsWith: "qa-ado-" } },
      });
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    } catch (e) {
      throw new Error(
        `admin-delete-user-org spec could not reset the QA fixtures — did you ` +
          `run \`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
      );
    }
  });
}

async function listOrganizations(page: Page): Promise<OrgListing[]> {
  const res = await page.request.get("/api/admin/organizations");
  expect(res.status()).toBe(200);
  return (await res.json()).organizations;
}

async function orgByName(page: Page, name: string): Promise<OrgListing> {
  const org = (await listOrganizations(page)).find((o) => o.name === name);
  expect(org, `organization "${name}" in /api/admin/organizations`).toBeTruthy();
  return org!;
}

/** Create a user through the admin API (the same call the Add-user form
 * makes). Without a password the user is invite-pending. */
async function createUser(
  page: Page,
  data: {
    name: string;
    email: string;
    organizationId?: string;
    organizationName?: string;
    password?: string;
  }
) {
  const res = await page.request.post("/api/admin/users", { data });
  expect(res.status(), `create ${data.email}: ${await res.text()}`).toBe(201);
  return (await res.json()) as {
    user: { id: string; email: string };
    invite: { sent: boolean; delivered?: boolean; error?: string } | null;
  };
}

/** Organization card on /admin/users — the header holds the org name in
 * `p.font-semibold`; QA-ADO names are unique and non-substring. */
function orgCard(page: Page, orgName: string): Locator {
  return page
    .locator("div.rounded-xl")
    .filter({ has: page.locator("p.font-semibold", { hasText: orgName }) });
}

function memberRow(scope: Locator, email: string): Locator {
  return scope.locator("tr", { hasText: email });
}

test.describe("Admin delete + invites + landing (feature/admin-delete-user-org)", () => {
  test.beforeAll(resetFixtures);
  test.afterAll(resetFixtures);

  test("AD1 delete a user from the row, refuse self/own-org/unconfirmed deletes, delete an org through the type-to-confirm dialog", async ({
    page,
  }) => {
    // Row delete confirms via window.confirm.
    page.on("dialog", (dialog) => dialog.accept());

    await loginAsRoomLensAdmin(page);

    // Throwaway org with two members, created the way the Add-user form does
    // (new org name on the first user, existing org id on the second).
    await createUser(page, {
      name: "QA ADO Delete One",
      email: DEL_1,
      organizationName: DELETE_ORG,
    });
    const org = await orgByName(page, DELETE_ORG);
    expect(org.slug).toBe("qa-ado-delete-org");
    await createUser(page, {
      name: "QA ADO Delete Two",
      email: DEL_2,
      organizationId: org.id,
    });

    await page.goto("/admin/users");
    await expect(
      page.getByRole("heading", { name: "User Management" })
    ).toBeVisible();
    const card = orgCard(page, DELETE_ORG);
    await expect(memberRow(card, DEL_1)).toBeVisible();
    await expect(memberRow(card, DEL_2)).toBeVisible();

    // Row "Delete" → confirm → the row is gone and so is the DB row; the
    // neighbour is untouched.
    await memberRow(card, DEL_1).getByRole("button", { name: "Delete" }).click();
    await expect(memberRow(card, DEL_1)).toHaveCount(0);
    await expect(memberRow(card, DEL_2)).toBeVisible();
    await withTestDb(async (db) => {
      expect(await db.user.findUnique({ where: { email: DEL_1 } })).toBeNull();
      expect(await db.user.findUnique({ where: { email: DEL_2 } })).not.toBeNull();
    });

    // Guardrail: an admin cannot delete their own account (page.request
    // rides the admin session).
    const orgs = await listOrganizations(page);
    const selfId = orgs
      .flatMap((o) => o.members)
      .find((m) => m.email === QA_ADMIN.email)?.id;
    expect(selfId, "acting admin in the org listing").toBeTruthy();
    const selfDelete = await page.request.delete(`/api/admin/users/${selfId}`);
    expect(selfDelete.status()).toBe(400);
    expect((await selfDelete.json()).error).toBe("You cannot delete your own account");

    // Org DELETE without the confirmation word is refused server-side.
    const unconfirmed = await page.request.delete(
      `/api/admin/organizations/${org.id}`,
      { data: {} }
    );
    expect(unconfirmed.status()).toBe(400);
    expect((await unconfirmed.json()).error).toBe(
      'Type "delete" to confirm deleting the organization'
    );

    // The acting admin's own org cannot be deleted even with the word.
    const roomlens = orgs.find((o) => o.slug === ROOMLENS_SLUG);
    expect(roomlens, "RoomLens in the org listing").toBeTruthy();
    const ownOrg = await page.request.delete(
      `/api/admin/organizations/${roomlens!.id}`,
      { data: { confirm: "delete" } }
    );
    expect(ownOrg.status()).toBe(400);
    expect((await ownOrg.json()).error).toBe("You cannot delete your own organization");

    // Nothing above deleted anything: the throwaway org and RoomLens are
    // still listed, each with its members.
    await page.reload();
    await expect(memberRow(card, DEL_2)).toBeVisible();
    await expect(memberRow(orgCard(page, "RoomLens"), QA_ADMIN.email)).toBeVisible();

    // Type-to-confirm dialog: a wrong word leaves the submit disabled and
    // Enter does nothing; Esc cancels.
    await card.getByRole("button", { name: "Delete organization" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: `Delete ${DELETE_ORG}?` })
    ).toBeVisible();
    await expect(dialog.getByText("its 1 user")).toBeVisible();
    const word = dialog.getByPlaceholder("delete");
    const confirmButton = dialog.getByRole("button", { name: "Delete organization" });
    await expect(confirmButton).toBeDisabled();
    await word.fill("nope");
    await word.press("Enter");
    await expect(confirmButton).toBeDisabled();
    await expect(dialog).toBeVisible();
    await word.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeVisible();
    await withTestDb(async (db) => {
      expect(await db.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
    });

    // The real thing: "delete" + Enter removes the org card…
    await card.getByRole("button", { name: "Delete organization" }).click();
    await dialog.getByPlaceholder("delete").fill("delete");
    await expect(dialog.getByRole("button", { name: "Delete organization" })).toBeEnabled();
    await dialog.getByPlaceholder("delete").press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);

    // …and the org, its workspace and its remaining user are gone from the DB.
    await withTestDb(async (db) => {
      expect(await db.organization.findUnique({ where: { id: org.id } })).toBeNull();
      expect(
        await db.workspace.findUnique({ where: { organizationId: org.id } })
      ).toBeNull();
      expect(await db.user.findUnique({ where: { email: DEL_2 } })).toBeNull();
    });
  });

  test("AD2 invite by password: /invite → Sign Up with Credentials → policy checklist → signed in to 2FA enrollment, token single-use, row shows Password", async ({
    browser,
    page,
  }) => {
    // One admin TOTP login plus the whole invitee flow in a second context.
    test.setTimeout(120_000);

    await loginAsRoomLensAdmin(page);

    const created = await createUser(page, {
      name: INV_PENDING_NAME,
      email: INV_PENDING,
      organizationName: INVITE_ORG,
    });
    // The invite went out (sent) but no SMTP transport exists in the test
    // env, so it was printed to the server console (delivered: false).
    expect(created.invite).toEqual({ sent: true, delivered: false });
    const org = await orgByName(page, INVITE_ORG);
    // A member who already finished sign-up — their reset token must not be
    // accepted as an invite.
    const withPassword = await createUser(page, {
      name: "QA ADO Has Password",
      email: INV_PASSWORD,
      organizationId: org.id,
      password: SEEDED_STYLE_PASSWORD,
    });
    expect(withPassword.invite).toBeNull();

    // Before: the Admin row shows the invite as pending.
    await page.goto("/admin/users");
    const inviteCard = orgCard(page, INVITE_ORG);
    await expect(
      memberRow(inviteCard, INV_PENDING).getByText("Invite pending", { exact: true })
    ).toBeVisible();

    // Only the hash is stored, so the emailed raw token is unknowable —
    // insert tokens the way sendInvitation/requestPasswordReset store them.
    const { inviteToken, resetToken } = await withTestDb(async (db) => ({
      inviteToken: await insertToken(db, created.user.id, 7 * 24 * 60 * 60 * 1000),
      resetToken: await insertToken(db, withPassword.user.id, 24 * 60 * 60 * 1000),
    }));

    // The invitee is signed out: /invite bounces a signed-in user to "/".
    const inviteeContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const invitee = await inviteeContext.newPage();

    await invitee.goto("/invite?token=not-a-real-token");
    await expect(invitee.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
    await expect(
      invitee.getByText("This invite link is missing, expired, or already used.")
    ).toBeVisible();

    await invitee.goto(`/invite?token=${resetToken}`);
    await expect(invitee.getByRole("heading", { name: "Invite not valid" })).toBeVisible();

    await invitee.goto(`/invite?token=${inviteToken}`);
    await expect(
      invitee.getByRole("heading", { name: "Complete your sign-up" })
    ).toBeVisible();
    await expect(invitee.getByText(`Hi ${INV_PENDING_NAME}, you've been invited to`)).toBeVisible();
    await expect(invitee.getByText(INVITE_ORG, { exact: true })).toBeVisible();
    // Google is hidden by env in tests (DISABLE_GOOGLE_LOGIN=true); the
    // credentials option is the only one.
    await expect(invitee.getByRole("link", { name: "Sign Up with Google" })).toHaveCount(0);
    const credentials = invitee.getByRole("link", { name: "Sign Up with Credentials" });
    await expect(credentials).toBeVisible();
    await credentials.click();
    await invitee.waitForURL(/\/reset-password\?/);
    const params = new URL(invitee.url()).searchParams;
    expect(params.get("token")).toBe(inviteToken);
    expect(params.get("invite")).toBe("1");
    await expect(invitee.getByRole("heading", { name: "Welcome to PM-OS" })).toBeVisible();
    await expect(invitee.getByText("Set a password to activate your account.")).toBeVisible();

    // Live checklist: one li[data-rule] per rule, data-ok flips as the value
    // changes, and the submit stays disabled until every rule passes AND the
    // confirmation matches.
    const submit = invitee.getByRole("button", { name: "Set password" });
    const rule = (key: string) => invitee.locator(`li[data-rule="${key}"]`);
    await expect(submit).toBeDisabled();
    await expect(rule("length")).not.toHaveAttribute("data-ok", /.*/);

    await invitee.locator("#new-password").fill("weak");
    await expect(rule("length")).toHaveAttribute("data-ok", "false");
    await expect(rule("lower")).toHaveAttribute("data-ok", "true");
    await expect(rule("upper")).toHaveAttribute("data-ok", "false");
    await expect(rule("digit")).toHaveAttribute("data-ok", "false");
    await expect(rule("symbol")).toHaveAttribute("data-ok", "false");
    await expect(submit).toBeDisabled();

    await invitee.locator("#new-password").fill(VALID_PASSWORD);
    for (const key of ["length", "lower", "upper", "digit", "symbol"]) {
      await expect(rule(key)).toHaveAttribute("data-ok", "true");
    }
    await expect(submit).toBeDisabled(); // no confirmation yet

    await invitee.locator("#confirm-password").fill("Invitee-pass2");
    await expect(rule("match")).toHaveAttribute("data-ok", "false");
    await expect(submit).toBeDisabled();

    await invitee.locator("#confirm-password").fill(VALID_PASSWORD);
    await expect(rule("match")).toHaveAttribute("data-ok", "true");
    await expect(submit).toBeEnabled();

    // Submit → the API signs the user in with 2FA owed → enrollment screen
    // (a brand-new account has no TOTP yet).
    await submit.click();
    await invitee.waitForURL(/\/login\/2fa/);
    await expect(
      invitee.getByRole("heading", { name: "Set up two-factor" })
    ).toBeVisible();

    // Single-use: replaying the token gets the generic 400…
    const replay = await inviteeContext.request.post("/api/auth/reset-password", {
      data: { token: inviteToken, password: "Another-valid-pass1" },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe(TOKEN_REFUSED);
    // …and the invite link itself is dead for a signed-out visitor.
    const anonContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const anon = await anonContext.newPage();
    await anon.goto(`/invite?token=${inviteToken}`);
    await expect(anon.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
    await anonContext.close();

    // DB view: password set, the consumed token is marked used, and no
    // unused sibling token of the user survives (resetPassword revokes
    // them — same contract as the Google path).
    await withTestDb(async (db) => {
      const user = await db.user.findUniqueOrThrow({ where: { email: INV_PENDING } });
      expect(user.passwordHash).toBeTruthy();
      const used = await db.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(inviteToken) },
      });
      expect(used.usedAt).not.toBeNull();
      expect(
        await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })
      ).toBe(0);
    });

    // Admin: the row flipped from "Invite pending" to "Password" and lost
    // its "Resend invite" button.
    await page.reload();
    const row = memberRow(orgCard(page, INVITE_ORG), INV_PENDING);
    await expect(row.getByText("Password", { exact: true })).toBeVisible();
    await expect(row.getByText("Invite pending", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Resend invite" })).toHaveCount(0);

    await inviteeContext.close();
  });

  test("AD3 Access column and Resend invite: pending users only, older links revoked, password users refused", async ({
    page,
  }) => {
    await loginAsRoomLensAdmin(page);

    const pending = await createUser(page, {
      name: "QA ADO Resend Pending",
      email: RES_PENDING,
      organizationName: RESEND_ORG,
    });
    const org = await orgByName(page, RESEND_ORG);
    const withPassword = await createUser(page, {
      name: "QA ADO Resend Password",
      email: RES_PASSWORD,
      organizationId: org.id,
      password: SEEDED_STYLE_PASSWORD,
    });

    await page.goto("/admin/users");
    const card = orgCard(page, RESEND_ORG);
    const pendingRow = memberRow(card, RES_PENDING);
    const passwordRow = memberRow(card, RES_PASSWORD);
    await expect(pendingRow.getByText("Invite pending", { exact: true })).toBeVisible();
    await expect(pendingRow.getByRole("button", { name: "Resend invite" })).toBeVisible();
    await expect(passwordRow.getByText("Password", { exact: true })).toBeVisible();
    await expect(passwordRow.getByRole("button", { name: "Resend invite" })).toHaveCount(0);

    // API: resend for the pending user → 200 (printed, not delivered), and
    // the older link is revoked — exactly one live token remains.
    const resend = await page.request.post(`/api/admin/users/${pending.user.id}/invite`);
    expect(resend.status()).toBe(200);
    expect(await resend.json()).toEqual({ ok: true, delivered: false });
    await withTestDb(async (db) => {
      expect(
        await db.passwordResetToken.count({
          where: { userId: pending.user.id, usedAt: null },
        })
      ).toBe(1);
    });

    // A user who already has a password cannot be re-invited.
    const refused = await page.request.post(
      `/api/admin/users/${withPassword.user.id}/invite`
    );
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe(
      "User already has a password — they can use Forgot password"
    );

    // UI resend surfaces the no-SMTP notice (the email went to the server
    // console) and still leaves one live token.
    await pendingRow.getByRole("button", { name: "Resend invite" }).click();
    await expect(
      page.getByText(
        `Invite for ${RES_PENDING} was printed to the server console — no SMTP transport is configured in this environment.`
      )
    ).toBeVisible();
    await withTestDb(async (db) => {
      expect(
        await db.passwordResetToken.count({
          where: { userId: pending.user.id, usedAt: null },
        })
      ).toBe(1);
    });
  });

  test("AD4 landing follows menu order per org flags; Releases page and API ride the docs flag", async ({
    page,
  }) => {
    // Baseline: no overrides → the login helper itself lands on /dashboard.
    await loginAsRoomLensAdmin(page);
    const roomlens = (await listOrganizations(page)).find(
      (o) => o.slug === ROOMLENS_SLUG
    );
    expect(roomlens, "RoomLens in the org listing").toBeTruthy();

    const setFeatures = async (features: Record<string, boolean | null>) => {
      const res = await page.request.patch(
        `/api/admin/organizations/${roomlens!.id}`,
        { data: { features } }
      );
      expect(res.status(), `PATCH features ${JSON.stringify(features)}`).toBe(200);
      return (await res.json()).organization.features as Record<string, boolean>;
    };

    // Dashboard Off → ideas is env-off (pinned by the guard), so the next ON
    // surface is Docs. A stale /dashboard bookmark funnels there too.
    await setFeatures({ dashboard: false });
    await page.goto("/");
    await page.waitForURL("**/docs");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await page.goto("/dashboard");
    await page.waitForURL("**/docs");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

    // Ideas On (override wins over the env default) → Ideas sits before Docs
    // in menu order, so it becomes the landing.
    await setFeatures({ ideas: true });
    await page.goto("/");
    await page.waitForURL("**/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();

    // Ideas back to default and Docs Off → Releases (page + API) is gated by
    // the docs flag, and the landing moves on to Chat.
    await setFeatures({ ideas: null, docs: false });
    const releases = await page.goto("/releases");
    expect(releases?.status(), "/releases with docs off").toBe(404);
    await expect(page.getByText("This page could not be found")).toBeVisible();
    expect(
      (await page.request.get("/api/releases")).status(),
      "/api/releases with docs off"
    ).toBe(404);
    await page.goto("/");
    await page.waitForURL("**/chat");
    await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();

    // Clear the overrides → env defaults again: "/" → /dashboard and
    // Releases is back (all-pages.spec depends on this; afterAll also
    // clears features as a backstop).
    expect(await setFeatures({ dashboard: null, docs: null })).toEqual({});
    await page.goto("/");
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await page.goto("/releases");
    await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
    expect((await page.request.get("/api/releases")).status()).toBe(200);
  });
});
