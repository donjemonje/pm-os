/**
 * Bootstrap (or reset) an admin login for PM-OS Admin.
 *
 * Admin access = a normal app User whose email is on the ADMIN_EMAILS
 * allowlist. This script makes sure that User exists and has a password:
 *   - user exists  -> password is set/reset
 *   - user missing -> user is created inside an organization (default
 *     "PM-OS", created with its workspace if needed)
 *
 * The password comes from the environment — it is never stored or printed.
 *
 * Run with the DB reachable (local dev env, or Cloud SQL Auth Proxy):
 *   ADMIN_EMAIL=d3east@gmail.com ADMIN_PASSWORD='...' node scripts/seed-admin.mjs
 * Optional: ADMIN_NAME="Daniel East" ADMIN_ORG_NAME="PM-OS"
 *
 * Hashing matches src/lib/auth.ts (scrypt, "salt:hash").
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function slugify(input) {
  const base = (input || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

function makeInviteCode() {
  return randomBytes(6)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();
}

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || "Admin";
const orgName = process.env.ADMIN_ORG_NAME?.trim() || "PM-OS";

if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

const existing = await prisma.user.findUnique({
  where: { email },
  include: { organization: true },
});

if (existing) {
  await prisma.user.update({
    where: { id: existing.id },
    data: { passwordHash: hashPassword(password), deactivatedAt: null },
  });
  console.log(
    `Password set for existing user ${email} (org: ${existing.organization?.name ?? "none"}).`
  );
} else {
  let org = await prisma.organization.findFirst({ where: { name: orgName } });
  if (!org) {
    const slug = slugify(orgName);
    org = await prisma.organization.create({
      data: {
        name: orgName,
        slug: `${slug}-${randomBytes(2).toString("hex")}`,
        inviteCode: makeInviteCode(),
        workspace: { create: { name: `${orgName} Workspace` } },
      },
    });
    console.log(`Created organization "${orgName}" with its workspace.`);
  }
  await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: hashPassword(password),
      organizationId: org.id,
    },
  });
  console.log(`Created user ${email} in organization "${org.name}".`);
}

console.log(
  "Reminder: the email must also be listed in ADMIN_EMAILS for /admin access."
);
await prisma.$disconnect();
