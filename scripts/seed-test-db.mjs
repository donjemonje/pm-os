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
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

const ORG_SLUG = "roomlens";
const ORG_NAME = "RoomLens";

// Fixed local/CI credentials — must match QA_USER in tests/e2e/helpers.ts.
const EMAIL = "qa+roomlens@pm-os.io";
const EMAIL2 = "qa+roomlens-2@pm-os.io";
const PASSWORD = "roomlens-qa-pass1";

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
  const passwordHash = hashPassword(PASSWORD);
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
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Refusing: NODE_ENV=production. This seed is for the local/CI test " +
        "database only — production testing is out of scope."
    );
    process.exit(1);
  }

  const org = await getOrCreateOrg();
  await upsertQaUser(org.id, EMAIL, "QA RoomLens");
  await upsertQaUser(org.id, EMAIL2, "QA RoomLens 2");
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
