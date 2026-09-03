import { NextRequest, NextResponse } from "next/server";
import { loginDisabledResponse } from "@/lib/auth-guard";
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { resetPassword } from "@/lib/password-reset";
import { rateLimit } from "@/lib/rate-limit";

/** POST { token, password } — consumes a 24h single-use reset link. */
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

  try {
    await resetPassword(token, password);
  } catch {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
