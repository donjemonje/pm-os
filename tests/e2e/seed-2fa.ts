/**
 * Seed for the 2FA e2e suite. Idempotent — safe to re-run.
 * Run under the env wrapper:
 *   node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- \
 *     node --experimental-strip-types tests/e2e/seed-2fa.ts
 *
 * Creates "QA 2FA Org" (org + workspace) and two users:
 *   qa-2fa-a@pm-os.test — enrolled in TOTP (secret below, lastUsedStep reset)
 *   qa-2fa-b@pm-os.test — not enrolled (all totp fields null)
 */
import { randomBytes, scryptSync } from "crypto";
import { PrismaClient } from "@prisma/client";
import { encryptTotpSecret } from "../../src/lib/two-factor.ts";

// Fixed so the Playwright spec can generate codes. Test-only credential.
export const USER_A_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const PASSWORD = "qa-2fa-Passw0rd!";
const ORG_NAME = "QA 2FA Org";
const ORG_SLUG = "qa-2fa-org";

const db = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const org = await db.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: ORG_NAME,
      slug: ORG_SLUG,
      inviteCode: "QA2FAORG",
      workspace: { create: { name: `${ORG_NAME} Workspace` } },
    },
    include: { workspace: true },
  });
  // Older runs may have created the org without a workspace.
  if (!org.workspace) {
    await db.workspace.create({
      data: { organizationId: org.id, name: `${ORG_NAME} Workspace` },
    });
  }

  const userA = await db.user.upsert({
    where: { email: "qa-2fa-a@pm-os.test" },
    update: {
      passwordHash: hashPassword(PASSWORD),
      organizationId: org.id,
      totpSecretEnc: encryptTotpSecret(USER_A_SECRET),
      totpEnabledAt: new Date(),
      totpLastUsedStep: null,
    },
    create: {
      email: "qa-2fa-a@pm-os.test",
      name: "QA TwoFA Enrolled",
      passwordHash: hashPassword(PASSWORD),
      organizationId: org.id,
      totpSecretEnc: encryptTotpSecret(USER_A_SECRET),
      totpEnabledAt: new Date(),
      totpLastUsedStep: null,
    },
  });

  const userB = await db.user.upsert({
    where: { email: "qa-2fa-b@pm-os.test" },
    update: {
      passwordHash: hashPassword(PASSWORD),
      organizationId: org.id,
      totpSecretEnc: null,
      totpEnabledAt: null,
      totpLastUsedStep: null,
    },
    create: {
      email: "qa-2fa-b@pm-os.test",
      name: "QA TwoFA Fresh",
      passwordHash: hashPassword(PASSWORD),
      organizationId: org.id,
      totpSecretEnc: null,
      totpEnabledAt: null,
      totpLastUsedStep: null,
    },
  });

  // Stale sessions from earlier runs would skip the challenge.
  await db.session.deleteMany({
    where: { userId: { in: [userA.id, userB.id] } },
  });

  console.log("seeded", {
    org: org.slug,
    userA: userA.email,
    userB: userB.email,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
