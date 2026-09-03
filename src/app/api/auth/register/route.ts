import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  registerUser,
  sessionCookieOptions,
  twoFactorPendingCookieOptions,
} from "@/lib/auth";
import { loginDisabledResponse, signupDisabledResponse } from "@/lib/auth-guard";
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";

export async function POST(request: NextRequest) {
  const disabled = loginDisabledResponse();
  if (disabled) return disabled;
  const signupBlocked = await signupDisabledResponse();
  if (signupBlocked) return signupBlocked;
  let body: {
    email?: string;
    password?: string;
    name?: string;
    organizationName?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim();
  const password = body.password;
  const name = body.name?.trim();
  const organizationName = body.organizationName?.trim();
  if (!email || !password || !name) {
    return NextResponse.json(
      { error: "Name, email, and password are required" },
      { status: 400 }
    );
  }
  if (!organizationName) {
    return NextResponse.json(
      { error: "Organization name is required" },
      { status: 400 }
    );
  }
  if (!isPasswordValid(password)) {
    return NextResponse.json({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  try {
    const user = await registerUser({
      email,
      password,
      name,
      organizationName,
    });
    // New accounts enroll in 2FA immediately — the step is mandatory.
    const token = await createSession(user.id);
    const response = NextResponse.json({ user, twoFactorRequired: true });
    const opts = sessionCookieOptions(token);
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
  } catch (e) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
