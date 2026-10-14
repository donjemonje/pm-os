import { NextRequest, NextResponse } from "next/server";
import { orgFeatureDisabledResponse } from "@/lib/api-auth";

/** Legacy callback — redirects to unified Google OAuth callback. */
export async function GET(request: NextRequest) {
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const url = new URL(request.url);
  // The public app URL, not the host the server listens on (0.0.0.0 inside App Hosting).
  const target = new URL("/api/auth/oauth/google/callback", process.env.NEXT_PUBLIC_APP_URL?.trim() || url.origin);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  return NextResponse.redirect(target);
}
