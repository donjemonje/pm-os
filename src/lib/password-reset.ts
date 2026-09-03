import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { hashPassword } from "./auth";
import { sendEmail } from "./mailer";

const RESET_TTL_MS = 24 * 60 * 60 * 1000;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000";
}

/**
 * Issue a single-use set-password token for a user and return the raw token
 * (only the hash is stored). One outstanding link per user: a new token
 * invalidates older unused ones. Shared by password reset (24h) and admin
 * invitations (7d, see invitations.ts) — both are consumed by resetPassword.
 */
export async function issuePasswordToken(
  userId: string,
  ttlMs: number
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.$transaction([
    db.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
    db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    }),
  ]);
  return token;
}

/**
 * Create a reset token and email the link. Silently does nothing when the
 * email has no account, the account is deactivated, or it has no password
 * yet (SSO account, or an invite that was never accepted — the admin resends
 * the invite instead) — the caller must answer identically either way, so
 * the endpoint never reveals which emails exist or how they sign in.
 */
export async function requestPasswordReset(emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.deactivatedAt || !user.passwordHash) return;

  const token = await issuePasswordToken(user.id, RESET_TTL_MS);
  const link = `${appBaseUrl()}/reset-password?token=${token}`;
  await sendEmail({
    to: email,
    subject: "Reset your PM-OS password",
    text:
      `Hi ${user.name},\n\n` +
      `Someone requested a password reset for your PM-OS account. ` +
      `Open this link to set a new password:\n\n${link}\n\n` +
      `The link expires in 24 hours and can be used once.\n\n` +
      `If this wasn't you, you can ignore this email — your password is unchanged.`,
  });
}

/**
 * Consume a set-password link (reset or invite): set the new password, mark
 * the token used, and revoke every active session (the standard post-reset
 * lockout). Throws "reset_invalid" for unknown, expired, or already-used
 * tokens.
 */
export async function resetPassword(
  token: string,
  newPassword: string
): Promise<void> {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: true },
  });
  if (!row || row.usedAt || row.expiresAt < new Date() || row.user.deactivatedAt) {
    throw new Error("reset_invalid");
  }

  await db.$transaction([
    db.user.update({
      where: { id: row.userId },
      data: { passwordHash: hashPassword(newPassword) },
    }),
    db.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    }),
    db.session.deleteMany({ where: { userId: row.userId } }),
  ]);
}
