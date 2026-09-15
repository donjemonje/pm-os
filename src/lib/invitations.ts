import { db } from "./db";
import { renderBrandedEmail } from "./email-templates";
import { sendEmail } from "./mailer";
import { appBaseUrl } from "./password-reset";
import { issuePasswordToken, revokeOtherPasswordTokens } from "./password-tokens";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteResult = {
  /** true = SMTP accepted it; false = no transport configured, printed to the server console. */
  delivered: boolean;
};

/**
 * Email an invite-pending user their invite link (7 days, single use; it
 * covers both the password and the Google path — see signInWithOAuth).
 * Used right after PM-OS Admin creates a user, and by "Resend invite".
 *
 * Refuses (throws) for a missing or deactivated user, and for a user who
 * already finished sign-up (password set, or a Google account linked).
 * SMTP failures propagate as-is so the admin sees the real reason.
 */
export async function sendInvitation(input: {
  userId: string;
  invitedByName: string;
}): Promise<InviteResult> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: {
      organization: { select: { name: true } },
      accounts: { select: { provider: true } },
    },
  });
  if (!user) throw new Error("User not found");
  if (user.deactivatedAt) throw new Error("User is deactivated");
  if (user.passwordHash) {
    throw new Error("User already has a password — they can use Forgot password");
  }
  if (user.accounts.length > 0) {
    throw new Error("User already signed up with Google — they sign in with the Google button");
  }

  const rawOrgName = user.organization?.name ?? "PM-OS";
  // Migration/seed scripts name orgs "<X>'s Organization" — avoid doubling.
  const orgName = /organization$/i.test(rawOrgName) ? rawOrgName : `${rawOrgName} Organization`;
  // Issue the new link first but keep any earlier one alive until this
  // send is known to have gone out — a failed resend must not kill a link
  // the user may still have.
  const token = await issuePasswordToken(user.id, INVITE_TTL_MS, { revokeOthers: false });
  const link = `${appBaseUrl()}/invite?token=${token}`;
  const inviter = input.invitedByName.trim() || "A PM-OS admin";

  const { html, text } = renderBrandedEmail({
    preheader: `${inviter} invited you to PM-OS`,
    heading: "You're invited to PM-OS",
    paragraphs: [`Hi ${user.name},`, `${inviter} invited you to ${orgName}.`],
    cta: { label: "Complete Sign-Up", url: link },
    note: "The link expires in 7 days and can be used once.",
  });

  const result = await sendEmail({
    to: user.email,
    subject: `${inviter} invited you to PM-OS`,
    text,
    html,
  });
  await revokeOtherPasswordTokens(user.id, token);
  return result;
}
