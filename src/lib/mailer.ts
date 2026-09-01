/**
 * Outbound email. Transport is env-driven:
 *   - RESEND_API_KEY set  -> send via Resend's HTTP API (no SDK dependency).
 *     EMAIL_FROM sets the sender (default onboarding@resend.dev, Resend's
 *     sandbox sender — replace once a domain is verified).
 *   - otherwise           -> dev fallback: the full email is printed to the
 *     server console so flows are testable locally without a provider.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    console.log(
      `\n━━━ DEV EMAIL (no RESEND_API_KEY — not sent) ━━━\n` +
        `To: ${input.to}\nSubject: ${input.subject}\n\n${input.text}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM?.trim() || "onboarding@resend.dev",
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
  }
}
