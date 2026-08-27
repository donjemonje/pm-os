import { NextRequest, NextResponse } from "next/server";
import {
  getLiveSessionState,
  SESSION_COOKIE,
  TWO_FACTOR_PENDING_COOKIE,
} from "@/lib/auth";

/**
 * Dead-cookie exit ramp. Server code that finds a session cookie with no
 * valid session behind it (user deactivated, session revoked or expired)
 * redirects here; this handler clears the stale cookies and lands on /login
 * so the user can sign in again with zero manual cookie clearing.
 *
 * The state check is deterministic and conservative: a live-but-unverified
 * session (mid-TOTP-challenge) is never cleared — it is sent back to the
 * challenge instead.
 */
export async function GET(request: NextRequest) {
  const rawFrom = request.nextUrl.searchParams.get("from");
  // Only same-site paths; anything else is dropped.
  const from =
    rawFrom && rawFrom.startsWith("/") && !rawFrom.startsWith("//")
      ? rawFrom
      : null;

  const state = await getLiveSessionState();

  if (state === "pending") {
    const challenge = new URL("/login/2fa", request.url);
    if (from) challenge.searchParams.set("from", from);
    return NextResponse.redirect(challenge);
  }

  if (state === "verified") {
    return NextResponse.redirect(new URL(from ?? "/dashboard", request.url));
  }

  // "dead" or "none": land on /login; clear whatever stale cookies exist.
  const login = new URL("/login", request.url);
  if (from) login.searchParams.set("from", from);
  const response = NextResponse.redirect(login);
  for (const name of [SESSION_COOKIE, TWO_FACTOR_PENDING_COOKIE]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
