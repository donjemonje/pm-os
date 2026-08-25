import { NextRequest, NextResponse } from "next/server";

/** Legacy callback — redirects to unified Google OAuth callback. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const target = new URL("/api/auth/oauth/google/callback", url.origin);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  return NextResponse.redirect(target);
}
