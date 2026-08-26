import { NextRequest, NextResponse } from "next/server";
import {
  authenticateUser,
  createSession,
  sessionCookieOptions,
  twoFactorPendingCookieOptions,
  userHasTwoFactor,
} from "@/lib/auth";
import { loginDisabledResponse } from "@/lib/auth-guard";

export async function POST(request: NextRequest) {
  const disabled = loginDisabledResponse();
  if (disabled) return disabled;
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim();
  const password = body.password;
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const user = await authenticateUser(email, password);
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const token = await createSession(user.id);
  const twoFactorRequired = await userHasTwoFactor(user.id);
  const response = NextResponse.json({ user, twoFactorRequired });
  const opts = sessionCookieOptions(token);
  response.cookies.set(opts.name, opts.value, {
    httpOnly: opts.httpOnly,
    sameSite: opts.sameSite,
    path: opts.path,
    secure: opts.secure,
    maxAge: opts.maxAge,
  });
  // Always set: clears a stale pending marker from an abandoned 2FA login.
  const pending = twoFactorPendingCookieOptions(twoFactorRequired);
  response.cookies.set(pending.name, pending.value, pending);
  return response;
}
