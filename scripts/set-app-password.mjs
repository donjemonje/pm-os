/**
 * Set (or reset) the password for an existing app user.
 *
 * Run with the DB reachable (e.g. via the Cloud SQL Auth Proxy) and:
 *   APP_USER_EMAIL=... APP_USER_PASSWORD=... node scripts/set-app-password.mjs
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

const email = process.env.APP_USER_EMAIL?.trim().toLowerCase();
const password = process.env.APP_USER_PASSWORD;

if (!email || !password) {
  console.error("Set APP_USER_EMAIL and APP_USER_PASSWORD.");
  process.exit(1);
}

const user = await prisma.user.findUnique({
  where: { email },
  include: { organization: true },
});

if (!user) {
  console.error(`No user found with email ${email}`);
  await prisma.$disconnect();
  process.exit(2);
}

await prisma.user.update({
  where: { id: user.id },
  data: { passwordHash: hashPassword(password) },
});

console.log(
  `Password set for ${email} (org: ${user.organization?.name ?? "none"})`
);
await prisma.$disconnect();
