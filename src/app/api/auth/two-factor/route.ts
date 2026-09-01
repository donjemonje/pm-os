import { NextResponse } from "next/server";
import {
  getSessionToken,
  twoFactorPendingCookieOptions,
  verifyTwoFactorChallenge,
} from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/** Login-time 2FA challenge: TOTP code or backup code for the pending session. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!rateLimit(`2fa-challenge:${token}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts — wait a minute and try again" },
      { status: 429 }
    );
  }

  const result = await verifyTwoFactorChallenge(code);
  if (result.status === "no_session") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (result.status === "no_setup") {
    return NextResponse.json(
      { error: "Setup incomplete — reload the page and scan the QR code again" },
      { status: 400 }
    );
  }
  if (result.status === "invalid") {
    return NextResponse.json(
      { error: "That code didn't match or was already used — wait for the next code and try again" },
      { status: 400 }
    );
  }

  const response = NextResponse.json({ ok: true });
  const opts = twoFactorPendingCookieOptions(false);
  response.cookies.set(opts.name, opts.value, opts);
  return response;
}
