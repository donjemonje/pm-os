import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { isSignupAllowed } from "./feature-flags";

export const SESSION_COOKIE = "pmos_session";
const SESSION_DAYS = 30;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  workspaceId: string | null;
  organizationId: string | null;
  organizationName: string | null;
};

/** Shape included on user queries so we can resolve org + workspace. */
const userWithOrgInclude = {
  organization: { include: { workspace: true } },
} as const;

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  return "dev-secret";
}

function slugify(input: string): string {
  const base = (input || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

function makeInviteCode(): string {
  return randomBytes(6)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();
}

async function uniqueOrgSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await db.organization.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function uniqueInviteCode(): Promise<string> {
  let code = makeInviteCode();
  while (await db.organization.findUnique({ where: { inviteCode: code } })) {
    code = makeInviteCode();
  }
  return code;
}

/**
 * Create a new organization and its single shared workspace (the tenant data
 * container). All members of the org share this workspace.
 */
export async function createOrganizationWithWorkspace(name: string) {
  const orgName = name.trim() || "My Organization";
  const slug = await uniqueOrgSlug(slugify(orgName));
  const inviteCode = await uniqueInviteCode();
  return db.organization.create({
    data: {
      name: orgName,
      slug,
      inviteCode,
      workspace: { create: { name: `${orgName} Workspace` } },
    },
    include: { workspace: true },
  });
}

function hashToken(token: string): string {
  return scryptSync(token, sessionSecret(), 32).toString(
    "hex"
  );
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64).toString("hex");
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch {
    return false;
  }
}

export function userInitials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  organization:
    | { id: string; name: string; workspace: { id: string } | null }
    | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    workspaceId: user.organization?.workspace?.id ?? null,
    organizationId: user.organization?.id ?? null,
    organizationName: user.organization?.name ?? null,
  };
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DAYS);

  await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return token;
}

export async function deleteSession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function getSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

/**
 * Marks the session behind the current request as having passed the TOTP
 * challenge. Called on successful enrollment (the user just proved they hold
 * the authenticator) and on successful /login/2fa verification.
 */
export async function markCurrentSessionTwoFactorVerified(): Promise<void> {
  const token = await getSessionToken();
  if (!token) return;
  await db.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { twoFactorVerified: true },
  });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = await getSessionToken();
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: userWithOrgInclude } },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await db.session.delete({ where: { id: session.id } });
    }
    return null;
  }

  return toAuthUser(session.user);
}

export async function registerUser(input: {
  email: string;
  password: string;
  name: string;
  organizationName?: string;
  inviteCode?: string;
}): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  // Resolve the organization: join an existing one via invite code, otherwise
  // create a brand-new organization (with its own isolated workspace).
  let organizationId: string;
  const inviteCode = input.inviteCode?.trim().toUpperCase();
  if (inviteCode) {
    const org = await db.organization.findUnique({ where: { inviteCode } });
    if (!org) {
      throw new Error("Invalid organization invite code");
    }
    organizationId = org.id;
  } else {
    const org = await createOrganizationWithWorkspace(
      input.organizationName?.trim() || `${input.name.trim()}'s Organization`
    );
    organizationId = org.id;
  }

  const user = await db.user.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: hashPassword(input.password),
      organizationId,
    },
    include: userWithOrgInclude,
  });

  return toAuthUser(user);
}

export async function authenticateUser(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: userWithOrgInclude,
  });
  if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return null;
  }
  return toAuthUser(user);
}

export async function signInWithOAuth(input: {
  provider: string;
  providerUserId: string;
  email: string;
  name: string;
}): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();

  const linked = await db.oAuthAccount.findUnique({
    where: {
      provider_providerUserId: {
        provider: input.provider,
        providerUserId: input.providerUserId,
      },
    },
    include: { user: { include: userWithOrgInclude } },
  });
  if (linked) {
    return toAuthUser(linked.user);
  }

  const existing = await db.user.findUnique({
    where: { email },
    include: userWithOrgInclude,
  });

  if (existing) {
    await db.oAuthAccount.create({
      data: {
        userId: existing.id,
        provider: input.provider,
        providerUserId: input.providerUserId,
      },
    });
    return toAuthUser(existing);
  }

  // No linked account and no existing user with this email: this would be a
  // brand-new signup. Only create the account when signup is allowed.
  if (!isSignupAllowed()) {
    throw new Error("signup_disabled");
  }

  const name = input.name.trim() || email.split("@")[0];
  const org = await createOrganizationWithWorkspace(`${name}'s Organization`);

  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash: null,
      organizationId: org.id,
      accounts: {
        create: {
          provider: input.provider,
          providerUserId: input.providerUserId,
        },
      },
    },
    include: userWithOrgInclude,
  });

  return toAuthUser(user);
}

/**
 * Backoffice/CRM helper: provision a user inside an organization without
 * creating a login session. The target organization can either be an existing
 * one (by id) or a brand-new organization created on the fly (by name).
 * A password is optional — omit it to create an SSO-only / invite-pending user.
 */
export async function createOrganizationUser(input: {
  email: string;
  name: string;
  password?: string;
  organizationId?: string;
  organizationName?: string;
}): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email) throw new Error("Email is required");
  if (!name) throw new Error("Name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email address");
  }
  if (input.password && input.password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  let organizationId = input.organizationId?.trim();
  if (organizationId) {
    const org = await db.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new Error("Organization not found");
  } else {
    const organizationName = input.organizationName?.trim();
    if (!organizationName) {
      throw new Error("Select an organization or provide a new organization name");
    }
    const org = await createOrganizationWithWorkspace(organizationName);
    organizationId = org.id;
  }

  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash: input.password ? hashPassword(input.password) : null,
      organizationId,
    },
    include: userWithOrgInclude,
  });

  return toAuthUser(user);
}

export type OrganizationMember = {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  createdAt: string;
};

export type OrganizationWithMembers = {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  createdAt: string;
  memberCount: number;
  members: OrganizationMember[];
};

/** Backoffice/CRM helper: list every organization with its member users. */
export async function listOrganizationsWithMembers(): Promise<
  OrganizationWithMembers[]
> {
  const orgs = await db.organization.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      users: { orderBy: { createdAt: "asc" } },
    },
  });

  return orgs.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    inviteCode: org.inviteCode,
    createdAt: org.createdAt.toISOString(),
    memberCount: org.users.length,
    members: org.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      hasPassword: Boolean(u.passwordHash),
      createdAt: u.createdAt.toISOString(),
    })),
  }));
}

export async function getOrganizationSummary(organizationId: string) {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      inviteCode: true,
      _count: { select: { users: true } },
    },
  });
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    inviteCode: org.inviteCode,
    memberCount: org._count.users,
  };
}

export function sessionCookieOptions(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}
