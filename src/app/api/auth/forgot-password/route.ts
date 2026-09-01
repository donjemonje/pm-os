import { NextRequest, NextResponse } from "next/server";
import { loginDisabledResponse } from "@/lib/auth-guard";
import { requestPasswordReset } from "@/lib/password-reset";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST { email } — always responds { ok: true } (whether or not the email
 * has an account, and regardless of its login type) so account existence is
 * never revealed. The actual gating lives in requestPasswordReset.
 */
export async function POST(request: NextRequest) {
  const disabled = loginDisabledResponse();
  if (disabled) return disabled;

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  if (!rateLimit(`pw-reset:${email}`, 3, 15 * 60_000)) {
    return NextResponse.json(
      { error: "Too many reset requests — try again in a few minutes" },
      { status: 429 }
    );
  }

  try {
    await requestPasswordReset(email);
  } catch (e) {
    // Send failures must not reveal that the email had an account.
    console.error("Password reset email failed:", e);
  }
  return NextResponse.json({ ok: true });
}
