import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  registerUser,
  sessionCookieOptions,
} from "@/lib/auth";
import { loginDisabledResponse, signupDisabledResponse } from "@/lib/auth-guard";

export async function POST(request: NextRequest) {
  const disabled = loginDisabledResponse();
  if (disabled) return disabled;
  const signupBlocked = signupDisabledResponse();
  if (signupBlocked) return signupBlocked;
  let body: {
    email?: string;
    password?: string;
    name?: string;
    organizationName?: string;
    inviteCode?: string;
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
  const inviteCode = body.inviteCode?.trim();
  if (!email || !password || !name) {
    return NextResponse.json(
      { error: "Name, email, and password are required" },
      { status: 400 }
    );
  }
  if (!organizationName && !inviteCode) {
    return NextResponse.json(
      { error: "Provide an organization name to create one, or an invite code to join one" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
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
      inviteCode,
    });
    const token = await createSession(user.id);
    const response = NextResponse.json({ user });
    const opts = sessionCookieOptions(token);
    response.cookies.set(opts.name, opts.value, {
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      path: opts.path,
      secure: opts.secure,
      maxAge: opts.maxAge,
    });
    return response;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
