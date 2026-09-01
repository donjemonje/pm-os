/**
 * Seed the RoomLens QA organization + synthetic test users into the test
 * database (pmos_test). Local + CI only — refuses to run when
 * NODE_ENV=production; production testing is out of scope.
 *
 * Idempotent: safe to re-run. Only ever touches the org with slug "roomlens"
 * and users under qa+roomlens*@pm-os.io — never any real/customer data.
 *
 * Runs as part of `npm run test:db:setup` (creates pmos_test, pushes the
 * schema, then seeds). Credentials are fixed and mirrored in
 * tests/e2e/helpers.ts.
 *
 * 2FA is mandatory, so the seed also sets each user's TOTP state:
 *   qa+roomlens@pm-os.io       enrolled — TEST_TOTP_SECRET encrypted via the
 *                              app's own encryptTotpSecret (needs
 *                              TOTP_ENC_KEY), totpLastUsedStep reset to null
 *   qa+roomlens-2@pm-os.io     un-enrolled — all totp fields null (the
 *                              enrollment-flow user; two-factor.spec T6
 *                              enrolls it, this seed resets it)
 *   qa+roomlens-admin@pm-os.io enrolled with its own fixed secret
 *                              (TEST_ADMIN_TOTP_SECRET), role PMOS_ADMIN —
 *                              the PM-OS Admin console user (admin.spec.ts)
 * The seed also resets admin-feature state so admin.spec.ts is rerunnable:
 * roles (only the admin user is PMOS_ADMIN), deactivatedAt null for all QA
 * users, and the org's per-org feature overrides cleared to {}.
 * All QA users' sessions are deleted every run (stale sessions would skip
 * the challenge), and any qa+signup* users from the signup spec are removed.
 *
 * Importing src/lib/two-factor.ts (TypeScript) from this .mjs requires
 * `node --experimental-strip-types` — the npm script and CI workflow both
 * pass it. Do NOT reimplement the AES-GCM format here.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";
import { encryptTotpSecret } from "../src/lib/two-factor.ts";

const prisma = new PrismaClient();

const ORG_SLUG = "roomlens";
const ORG_NAME = "RoomLens";

// Fixed local/CI credentials — must match QA_USER in tests/e2e/helpers.ts.
const EMAIL = "qa+roomlens@pm-os.io";
const EMAIL2 = "qa+roomlens-2@pm-os.io";
const ADMIN_EMAIL = "qa+roomlens-admin@pm-os.io"; // must match QA_ADMIN in helpers.ts
const PASSWORD = "roomlens-qa-pass1";

// Fixed synthetic TOTP secrets — must match TEST_TOTP_SECRET /
// TEST_ADMIN_TOTP_SECRET in tests/e2e/two-factor-helpers.ts. Each user has
// its own secret so back-to-back logins of different users never share a
// consumed code window. Test-only credentials.
const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const TEST_ADMIN_TOTP_SECRET = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU";

// Same salt:hash scrypt format as src/lib/auth.ts.
function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function makeInviteCode() {
  return randomBytes(6)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();
}

async function getOrCreateOrg() {
  const existing = await prisma.organization.findUnique({
    where: { slug: ORG_SLUG },
    include: { workspace: true },
  });
  if (existing) {
    console.log(`• Organization "${existing.name}" already exists — reusing.`);
    return existing;
  }
  const org = await prisma.organization.create({
    data: {
      name: ORG_NAME,
      slug: ORG_SLUG,
      inviteCode: makeInviteCode(),
      workspace: { create: { name: `${ORG_NAME} Workspace` } },
    },
    include: { workspace: true },
  });
  console.log(`✓ Organization "${ORG_NAME}" created (slug: ${ORG_SLUG})`);
  return org;
}

async function upsertQaUser(orgId, userEmail, name, extraFields) {
  const passwordHash = hashPassword(PASSWORD);
  const data = { passwordHash, organizationId: orgId, ...extraFields };
  const existing = await prisma.user.findUnique({ where: { email: userEmail } });
  if (existing) {
    await prisma.user.update({ where: { email: userEmail }, data });
    console.log(`• User ${userEmail} exists — password + org + totp refreshed.`);
    return;
  }
  await prisma.user.create({ data: { email: userEmail, name, ...data } });
  console.log(`✓ User ${userEmail} created.`);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Refusing: NODE_ENV=production. This seed is for the local/CI test " +
        "database only — production testing is out of scope."
    );
    process.exit(1);
  }

  const org = await getOrCreateOrg();
  // Reset per-org feature overrides: all-pages.spec.ts asserts the ideas
  // routes 404 under the env default, and admin.spec.ts sets/clears the
  // override itself.
  await prisma.organization.update({
    where: { id: org.id },
    data: { features: {} },
  });
  // Enrolled user: encrypted with the app's own helper so the login path
  // decrypts it for real. totpLastUsedStep reset so a prior run's consumed
  // code windows never leak into this run. Role/deactivation reset because
  // admin.spec.ts deactivates and reactivates this user.
  await upsertQaUser(org.id, EMAIL, "QA RoomLens", {
    role: "USER",
    deactivatedAt: null,
    totpSecretEnc: encryptTotpSecret(TEST_TOTP_SECRET),
    totpEnabledAt: new Date(),
    totpLastUsedStep: null,
  });
  // Un-enrolled user: the 2FA enrollment spec (T6) enrolls it; reset here.
  // Role reset because admin.spec.ts promotes and demotes this user.
  await upsertQaUser(org.id, EMAIL2, "QA RoomLens 2", {
    role: "USER",
    deactivatedAt: null,
    totpSecretEnc: null,
    totpEnabledAt: null,
    totpLastUsedStep: null,
  });
  // PM-OS Admin console user (admin.spec.ts) — the only seeded PMOS_ADMIN.
  await upsertQaUser(org.id, ADMIN_EMAIL, "QA RoomLens Admin", {
    role: "PMOS_ADMIN",
    deactivatedAt: null,
    totpSecretEnc: encryptTotpSecret(TEST_ADMIN_TOTP_SECRET),
    totpEnabledAt: new Date(),
    totpLastUsedStep: null,
  });

  // Stale sessions would skip the /login/2fa challenge.
  const { count: sessions } = await prisma.session.deleteMany({
    where: { user: { email: { in: [EMAIL, EMAIL2, ADMIN_EMAIL] } } },
  });
  console.log(`• Deleted ${sessions} stale QA session(s).`);

  // Signup-spec leftovers (sessions cascade via the schema).
  const { count: signups } = await prisma.user.deleteMany({
    where: { email: { startsWith: "qa+signup" } },
  });
  if (signups > 0) console.log(`• Deleted ${signups} qa+signup* user(s).`);

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
