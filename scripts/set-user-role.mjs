/**
 * Set a user's role — the ONLY way roles change in any environment,
 * production included. There is deliberately no role mutation in the PM-OS
 * Admin UI or API (Daniel's security call, 2026-08-27); seed-admin.mjs
 * promotes its seeded user, and this script covers both directions for
 * everyone else.
 *
 * Usage (DB reachable — local dev env, or Cloud SQL Auth Proxy for prod):
 *   USER_EMAIL=someone@pm-os.io USER_ROLE=PMOS_ADMIN \
 *     node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- node scripts/set-user-role.mjs
 *   USER_EMAIL=someone@pm-os.io USER_ROLE=USER \
 *     node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- node scripts/set-user-role.mjs
 *
 * Refuses to demote the last active pmos-admin — promote a replacement
 * first. (Recovering from zero admins would otherwise mean hand-written
 * SQL.)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const email = process.env.USER_EMAIL?.trim().toLowerCase();
const role = process.env.USER_ROLE?.trim().toUpperCase();

if (!email || !role) {
  console.error("Set USER_EMAIL and USER_ROLE (USER or PMOS_ADMIN).");
  process.exit(1);
}
if (role !== "USER" && role !== "PMOS_ADMIN") {
  console.error(`Invalid USER_ROLE "${role}" — use USER or PMOS_ADMIN.`);
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.error(`No user found with email ${email}`);
  await prisma.$disconnect();
  process.exit(2);
}

if (user.role === role) {
  console.log(`${email} already has role ${role} — nothing to do.`);
  await prisma.$disconnect();
  process.exit(0);
}

if (role === "USER" && user.role === "PMOS_ADMIN" && !user.deactivatedAt) {
  const activeAdmins = await prisma.user.count({
    where: { role: "PMOS_ADMIN", deactivatedAt: null },
  });
  if (activeAdmins <= 1) {
    console.error(
      `Refusing: ${email} is the last active pmos-admin. Promote another admin first.`
    );
    await prisma.$disconnect();
    process.exit(3);
  }
}

await prisma.user.update({ where: { id: user.id }, data: { role } });
console.log(`Role for ${email}: ${user.role} -> ${role}`);
await prisma.$disconnect();
