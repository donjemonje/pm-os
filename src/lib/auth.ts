import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "./db";
import { isSignupAllowed } from "./feature-flags";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  isFreshTotpStep,
  verifyTotpCode,
} from "./two-factor";

export const SESSION_COOKIE = "pmos_session";
/**
 * UX marker only — set alongside the session cookie when login still needs the
 * TOTP challenge, so middleware (which can't reach the DB) can route pages to
 * /login/2fa. Security never depends on it: getCurrentUser rejects unverified
 * sessions regardless.
 */
export const TWO_FACTOR_PENDING_COOKIE = "pmos_2fa_pending";
const SESSION_DAYS = 30;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  /** Minimized IAM: "USER" (default) or "PMOS_ADMIN" (PM-OS Admin access). */
  role: "USER" | "PMOS_ADMIN";
  workspaceId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  /** Organization.features JSON — per-org flag overrides ({} when none). */
  organizationFeatures: unknown;
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
  role: "USER" | "PMOS_ADMIN";
  organization:
    | {
        id: string;
        name: string;
        features?: unknown;
        workspace: { id: string } | null;
      }
    | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workspaceId: user.organization?.workspace?.id ?? null,
    organizationId: user.organization?.id ?? null,
    organizationName: user.organization?.name ?? null,
    organizationFeatures: user.organization?.features ?? {},
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

async function findCurrentSessionWithUser() {
  const token = await getSessionToken();
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  // Deactivation also invalidates half-completed 2FA challenge sessions:
  // a deactivated user can neither read enrollment state nor pass the
  // challenge. (Deactivating already deletes sessions; this covers races.)
  if (session.user.deactivatedAt) return null;
  return session;
}

export type TwoFactorState =
  | { status: "none" }
  | { status: "verified" }
  /** Enrolled — the login challenge is owed. */
  | { status: "challenge" }
  /** Not enrolled yet — mandatory enrollment; secret is the base32 to show. */
  | { status: "enroll"; secret: string; email: string };

/**
 * State of the mandatory 2FA step for the current request's session, used by
 * the /login/2fa page. In enroll state this creates (or reuses) the pending
 * secret so a page refresh doesn't invalidate an already-scanned QR.
 */
export async function getTwoFactorState(): Promise<TwoFactorState> {
  const session = await findCurrentSessionWithUser();
  if (!session) return { status: "none" };
  if (session.twoFactorVerified) return { status: "verified" };
  if (session.user.totpEnabledAt) return { status: "challenge" };

  if (session.user.totpSecretEnc) {
    return {
      status: "enroll",
      secret: decryptTotpSecret(session.user.totpSecretEnc),
      email: session.user.email,
    };
  }
  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: session.user.id },
    data: { totpSecretEnc: encryptTotpSecret(secret) },
  });
  return { status: "enroll", secret, email: session.user.email };
}

export type LiveSessionState = "none" | "dead" | "pending" | "verified";

/**
 * Raw session-cookie truth for the current request, independent of the 2FA
 * gate in getCurrentUser:
 * - "none"     no session cookie at all
 * - "dead"     cookie present but no valid session behind it (revoked by
 *              deactivation, expired, or deleted) — safe to clear
 * - "pending"  valid session still owing the TOTP challenge — must NOT clear
 * - "verified" fully authenticated session
 */
export async function getLiveSessionState(): Promise<LiveSessionState> {
  const token = await getSessionToken();
  if (!token) return "none";
  const session = await findCurrentSessionWithUser();
  if (!session) return "dead";
  return session.twoFactorVerified ? "verified" : "pending";
}

// cache(): one session lookup per request even though both the root layout
// and the page (or API helper) resolve the current user.
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
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

  // Soft-deactivated users lose access immediately, existing sessions included.
  if (session.user.deactivatedAt) {
    await db.session.delete({ where: { id: session.id } });
    return null;
  }

  // The 2FA gate for every page and API route: 2FA is mandatory, so a session
  // that hasn't passed the TOTP step is treated as unauthenticated.
  if (!session.twoFactorVerified) {
    return null;
  }

  return toAuthUser(session.user);
});

export function twoFactorPendingCookieOptions(pending: boolean) {
  return {
    name: TWO_FACTOR_PENDING_COOKIE,
    value: pending ? "1" : "",
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // Lives as long as the session: an abandoned challenge keeps routing to
    // /login/2fa instead of stranding a half-authenticated session.
    maxAge: pending ? SESSION_DAYS * 24 * 60 * 60 : 0,
  };
}

export type TwoFactorChallengeResult =
  | { status: "ok" }
  | { status: "no_session" }
  | { status: "no_setup" }
  | { status: "invalid" };

/**
 * Verifies the mandatory login-time TOTP step for the current request's
 * session. Handles both cases: an enrolled user passing the challenge, and a
 * first-time user confirming the secret they just scanned (which completes
 * enrollment). Marks the session verified on success; codes are single-use.
 */
export async function verifyTwoFactorChallenge(
  code: string
): Promise<TwoFactorChallengeResult> {
  const session = await findCurrentSessionWithUser();
  if (!session) return { status: "no_session" };
  if (session.twoFactorVerified) return { status: "ok" };
  if (!session.user.totpSecretEnc) return { status: "no_setup" };

  const secret = decryptTotpSecret(session.user.totpSecretEnc);
  const step = verifyTotpCode(secret, code);
  if (step === null || !isFreshTotpStep(step, session.user.totpLastUsedStep)) {
    return { status: "invalid" };
  }

  await db.user.update({
    where: { id: session.user.id },
    data: {
      totpLastUsedStep: step,
      // First successful code completes enrollment.
      ...(session.user.totpEnabledAt ? {} : { totpEnabledAt: new Date() }),
    },
  });
  await db.session.update({
    where: { id: session.id },
    data: { twoFactorVerified: true },
  });
  return { status: "ok" };
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
  if (user.deactivatedAt) return null;
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
    if (linked.user.deactivatedAt) throw new Error("account_deactivated");
    // Login type is sticky: a password account never signs in via SSO, even
    // when a provider link exists from before this rule.
    if (linked.user.passwordHash) throw new Error("email_uses_password");
    return toAuthUser(linked.user);
  }

  const existing = await db.user.findUnique({
    where: { email },
    include: userWithOrgInclude,
  });

  if (existing) {
    if (existing.deactivatedAt) throw new Error("account_deactivated");
    // Login type is sticky: same email but a password account — no auto-link,
    // no SSO sign-in. (SSO-created users may still link another provider.)
    if (existing.passwordHash) throw new Error("email_uses_password");
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
 * PM-OS Admin helper: provision a user inside an organization without
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
  role: "USER" | "PMOS_ADMIN";
  hasPassword: boolean;
  deactivatedAt: string | null;
  createdAt: string;
};

export type OrganizationWithMembers = {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  features: Record<string, boolean>;
  createdAt: string;
  memberCount: number;
  members: OrganizationMember[];
};

/** Narrow an Organization.features JSON value to the boolean overrides we store. */
export function toFeatureOverrides(features: unknown): Record<string, boolean> {
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** PM-OS Admin helper: list every organization with its member users. */
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
    features: toFeatureOverrides(org.features),
    createdAt: org.createdAt.toISOString(),
    memberCount: org.users.length,
    members: org.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      hasPassword: Boolean(u.passwordHash),
      deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
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
