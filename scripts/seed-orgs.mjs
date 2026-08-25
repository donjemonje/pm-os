/**
 * Seed two organizations for the multi-tenant acceptance test:
 *   - Organization A: "RoomLens"     (connect Jira after logging in)
 *   - Organization B: "CoffeePlaces" (connect Google Drive after logging in)
 *
 * Each org gets one user. Integrations (Jira/Google Drive) are per-organization
 * and must be connected from Settings after signing in as each user (OAuth).
 *
 * Run with:  npm run orgs:seed
 *
 * Optional env overrides:
 *   ORG_A_NAME, ORG_A_USER_EMAIL, ORG_A_USER_NAME, ORG_A_USER_PASSWORD
 *   ORG_B_NAME, ORG_B_USER_EMAIL, ORG_B_USER_NAME, ORG_B_USER_PASSWORD
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
  return randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 1;
  while (await prisma.organization.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function uniqueInviteCode() {
  let code = makeInviteCode();
  while (await prisma.organization.findUnique({ where: { inviteCode: code } })) {
    code = makeInviteCode();
  }
  return code;
}

async function seedOrg({ orgName, integration, userEmail, userName, userPassword }) {
  const email = userEmail.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { organization: true },
  });
  if (existing) {
    console.log(`• User ${email} already exists (org: ${existing.organization?.name ?? "none"}) — skipping.`);
    return;
  }

  const slug = await uniqueSlug(slugify(orgName));
  const inviteCode = await uniqueInviteCode();
  const org = await prisma.organization.create({
    data: {
      name: orgName,
      slug,
      inviteCode,
      workspace: { create: { name: `${orgName} Workspace` } },
    },
  });

  await prisma.user.create({
    data: {
      email,
      name: userName,
      passwordHash: hashPassword(userPassword),
      organizationId: org.id,
    },
  });

  console.log(`✓ Organization "${orgName}" created`);
  console.log(`    user:        ${email}  (password: ${userPassword})`);
  console.log(`    invite code: ${inviteCode}`);
  console.log(`    next step:   sign in as this user and connect ${integration} in Settings.`);
}

async function main() {
  await seedOrg({
    orgName: process.env.ORG_A_NAME || "RoomLens",
    integration: "Jira",
    userEmail: process.env.ORG_A_USER_EMAIL || "alice@roomlens.test",
    userName: process.env.ORG_A_USER_NAME || "Alice (RoomLens)",
    userPassword: process.env.ORG_A_USER_PASSWORD || "roomlens-demo-pass",
  });

  await seedOrg({
    orgName: process.env.ORG_B_NAME || "CoffeePlaces",
    integration: "Google Drive",
    userEmail: process.env.ORG_B_USER_EMAIL || "bob@coffeeplaces.test",
    userName: process.env.ORG_B_USER_NAME || "Bob (CoffeePlaces)",
    userPassword: process.env.ORG_B_USER_PASSWORD || "coffeeplaces-demo-pass",
  });

  console.log("\nDone. Set DISABLE_LOGIN=false in .env to allow sign-in, then log in at /login.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
