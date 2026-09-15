import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outbound email over SMTP (Google Workspace / Gmail by default — the same
 * approach as the marketing site). Env:
 *   SMTP_USER + SMTP_PASSWORD  mailbox login (Google app password). Both set
 *                              → real sends. Either missing → dev fallback:
 *                              the full email is printed to the server
 *                              console so flows are testable locally.
 *   SMTP_HOST / SMTP_PORT      default smtp.gmail.com / 465 (implicit TLS).
 *   SMTP_FROM                 visible sender, default "PM-OS <SMTP_USER>".
 *                              A Workspace alias (support@pm-os.io) works
 *                              when it is configured as "Send mail as" on
 *                              the SMTP_USER mailbox; otherwise Gmail
 *                              rewrites it to SMTP_USER.
 *   SMTP_REPLY_TO             optional Reply-To.
 */

export type OutboundEmail = {
  to: string;
  subject: string;
  /** Plain-text body — always required (fallback + what the dev console shows). */
  text: string;
  /** Optional HTML twin (see email-templates.ts). */
  html?: string;
  /** Inline/CID attachments for the HTML (e.g. the brand logo). */
  attachments?: { filename: string; content: Buffer; contentType: string; cid: string }[];
};

export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_USER?.trim() && process.env.SMTP_PASSWORD?.trim()
  );
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: port === 465,
    // 587 must upgrade to TLS, never fall back to plaintext.
    requireTLS: port !== 465,
    // Bounded waits: an unreachable SMTP host must fail the request in
    // seconds, not hang the admin's "Add user" call for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: process.env.SMTP_USER!.trim(),
      pass: process.env.SMTP_PASSWORD!.trim(),
    },
  });
  return transporter;
}

/**
 * Send one plain-text email. Resolves { delivered: true } after the SMTP
 * server accepted it, { delivered: false } when no transport is configured
 * (dev fallback — printed to the console instead). Throws on SMTP failure.
 */
export async function sendEmail(
  input: OutboundEmail
): Promise<{ delivered: boolean }> {
  if (!isEmailConfigured()) {
    console.log(
      `\n━━━ DEV EMAIL (SMTP_USER/SMTP_PASSWORD unset — not sent) ━━━\n` +
        `To: ${input.to}\nSubject: ${input.subject}\n\n${input.text}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    return { delivered: false };
  }

  const user = process.env.SMTP_USER!.trim();
  const from = process.env.SMTP_FROM?.trim() || `PM-OS <${user}>`;
  const replyTo = process.env.SMTP_REPLY_TO?.trim() || undefined;

  await getTransporter().sendMail({
    from,
    to: input.to,
    replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });
  return { delivered: true };
}
