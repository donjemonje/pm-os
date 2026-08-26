/**
 * Seed the RoomLens QA organization + synthetic test users.
 *
 * Idempotent: safe to re-run. Only ever touches the org with slug "roomlens"
 * and users under qa+roomlens*@pm-os.io — never any real/customer data.
 *
 * Local / CI:
 *   npm run test:db:setup           (creates pmos_test, pushes schema, seeds)
 *
 * Production (Daniel only, deliberate, via Cloud SQL Auth Proxy):
 *   QA_USER_PASSWORD=<strong password> DATABASE_URL=... node scripts/seed-roomlens.mjs
 *   The script refuses to run with the default password unless
 *   SEED_ALLOW_DEFAULT_PASSWORD=1 is set, so a prod run can't silently
 *   create a QA user with a publicly known password.
 *
 * Env overrides:
 *   QA_USER_EMAIL     (default qa+roomlens@pm-os.io)
 *   QA_USER_PASSWORD  (default roomlens-qa-pass1 — local/CI only)
 *   QA_USER2_EMAIL    (default qa+roomlens-2@pm-os.io)
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

const ORG_SLUG = "roomlens";
const ORG_NAME = "RoomLens";
const DEFAULT_PASSWORD = "roomlens-qa-pass1";

const email = (process.env.QA_USER_EMAIL || "qa+roomlens@pm-os.io")
  .trim()
  .toLowerCase();
const email2 = (process.env.QA_USER2_EMAIL || "qa+roomlens-2@pm-os.io")
  .trim()
  .toLowerCase();
const password = process.env.QA_USER_PASSWORD || DEFAULT_PASSWORD;

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

async function upsertQaUser(orgId, userEmail, name) {
  const passwordHash = hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email: userEmail } });
  if (existing) {
    await prisma.user.update({
      where: { email: userEmail },
      data: { passwordHash, organizationId: orgId },
    });
    console.log(`• User ${userEmail} exists — password + org refreshed.`);
    return;
  }
  await prisma.user.create({
    data: { email: userEmail, name, passwordHash, organizationId: orgId },
  });
  console.log(`✓ User ${userEmail} created.`);
}

async function main() {
  if (
    password === DEFAULT_PASSWORD &&
    process.env.NODE_ENV === "production" &&
    process.env.SEED_ALLOW_DEFAULT_PASSWORD !== "1"
  ) {
    console.error(
      "Refusing: NODE_ENV=production with the default QA password. " +
        "Set QA_USER_PASSWORD to a strong value (and store it as the " +
        "PMOS_QA_USER_PASSWORD GitHub secret)."
    );
    process.exit(1);
  }
  if (password === DEFAULT_PASSWORD) {
    console.log("(using the default local/CI QA password)");
  }

  const org = await getOrCreateOrg();
  await upsertQaUser(org.id, email, "QA RoomLens");
  await upsertQaUser(org.id, email2, "QA RoomLens 2");
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
