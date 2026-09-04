import { createHash, randomBytes } from "crypto";
import { db } from "./db";

/**
 * Single-use set-password tokens (PasswordResetToken rows). Only the SHA-256
 * hash is stored; the raw token exists only in the emailed link. Shared by
 * password reset (24h) and admin invitations (7d). Dependency-free apart
 * from the DB so auth.ts can import it without a cycle.
 */

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a token and return the raw value. By default older unused tokens of
 * the user are revoked in the same transaction (one outstanding link);
 * pass revokeOthers: false to keep them (the caller revokes after a
 * successful send — see invitations.ts).
 */
export async function issuePasswordToken(
  userId: string,
  ttlMs: number,
  options: { revokeOthers?: boolean } = {}
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const create = db.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  if (options.revokeOthers === false) {
    await create;
  } else {
    await db.$transaction([
      db.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
      create,
    ]);
  }
  return token;
}

/** Delete every unused token of the user except the given raw token. */
export async function revokeOtherPasswordTokens(
  userId: string,
  keepToken: string
): Promise<void> {
  await db.passwordResetToken.deleteMany({
    where: { userId, usedAt: null, tokenHash: { not: hashResetToken(keepToken) } },
  });
}

/**
 * Peek at a token without consuming it. Null for unknown, used, expired, or
 * deactivated. inviteOnly: also null when the user already has a password
 * (a reset link is not an invite).
 */
export async function lookupPasswordToken(
  token: string,
  options: { inviteOnly?: boolean } = {}
): Promise<{
  userId: string;
  email: string;
  name: string;
  organizationName: string | null;
} | null> {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: { include: { organization: { select: { name: true } } } } },
  });
  if (!row || row.usedAt || row.expiresAt < new Date() || row.user.deactivatedAt) {
    return null;
  }
  if (options.inviteOnly && row.user.passwordHash) return null;
  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    organizationName: row.user.organization?.name ?? null,
  };
}

/**
 * Consume a live token that belongs to the given user (mark used, revoke the
 * user's other unused tokens). Returns false when the token is missing,
 * unknown, used, expired, or belongs to someone else — nothing is changed.
 */
export async function consumePasswordTokenForUser(
  userId: string,
  token: string | null | undefined
): Promise<boolean> {
  if (!token) return false;
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
  });
  if (!row || row.userId !== userId || row.usedAt || row.expiresAt < new Date()) {
    return false;
  }
  await db.$transaction([
    db.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    db.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
  ]);
  return true;
}
