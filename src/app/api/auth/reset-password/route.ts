import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  sessionCookieOptions,
  twoFactorPendingCookieOptions,
} from "@/lib/auth";
import { loginDisabledResponse } from "@/lib/auth-guard";
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { resetPassword } from "@/lib/password-reset";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST { token, password } — consumes a single-use set-password link (reset
 * or invite) and signs the user in: the response sets a session cookie with
 * the 2FA step still owed, so the client goes straight to /login/2fa (the
 * TOTP challenge, or enrollment for a new account) and then into the app.
 */
export async function POST(request: NextRequest) {
  const disabled = loginDisabledResponse();
  if (disabled) return disabled;

  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = body.token?.trim();
  const password = body.password;
  if (!token || !password) {
    return NextResponse.json(
      { error: "Token and password are required" },
      { status: 400 }
    );
  }
  if (!isPasswordValid(password)) {
    return NextResponse.json({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
  }

  if (!rateLimit(`pw-reset-consume:${token.slice(0, 16)}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts — wait a minute and try again" },
      { status: 429 }
    );
  }

  let userId: string;
  try {
    ({ userId } = await resetPassword(token, password));
  } catch {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 }
    );
  }

  const session = await createSession(userId);
  const response = NextResponse.json({ ok: true, twoFactorRequired: true });
  const opts = sessionCookieOptions(session);
  response.cookies.set(opts.name, opts.value, {
    httpOnly: opts.httpOnly,
    sameSite: opts.sameSite,
    path: opts.path,
    secure: opts.secure,
    maxAge: opts.maxAge,
  });
  const pending = twoFactorPendingCookieOptions(true);
  response.cookies.set(pending.name, pending.value, pending);
  return response;
}
