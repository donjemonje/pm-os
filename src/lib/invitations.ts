import { db } from "./db";
import { renderBrandedEmail } from "./email-templates";
import { sendEmail } from "./mailer";
import { appBaseUrl, issuePasswordToken } from "./password-reset";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteResult = {
  /** true = SMTP accepted it; false = no transport configured, printed to the server console. */
  delivered: boolean;
};

/**
 * Email an invite-pending user a set-password link (7 days, single use).
 * Used right after PM-OS Admin creates a user, and by "Resend invite".
 *
 * Refuses (throws) for a missing or deactivated user, and for a user who
 * already has a password — they sign in normally and use "Forgot password".
 * SMTP failures propagate as-is so the admin sees the real reason.
 */
export async function sendInvitation(input: {
  userId: string;
  invitedByName: string;
}): Promise<InviteResult> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { organization: { select: { name: true } } },
  });
  if (!user) throw new Error("User not found");
  if (user.deactivatedAt) throw new Error("User is deactivated");
  if (user.passwordHash) {
    throw new Error("User already has a password — they can use Forgot password");
  }

  const orgName = user.organization?.name ?? "PM-OS";
  const token = await issuePasswordToken(user.id, INVITE_TTL_MS);
  const link = `${appBaseUrl()}/invite?token=${token}`;
  const inviter = input.invitedByName.trim() || "A PM-OS admin";

  const { html, text } = renderBrandedEmail({
    preheader: `${inviter} invited you to PM-OS`,
    heading: "You're invited to PM-OS",
    paragraphs: [`Hi ${user.name},`, `${inviter} invited you to ${orgName} Organization.`],
    cta: { label: "Complete Sign-Up", url: link },
    note: "The link expires in 7 days and can be used once.",
  });

  return sendEmail({
    to: user.email,
    subject: `${inviter} invited you to PM-OS`,
    text,
    html,
  });
}
