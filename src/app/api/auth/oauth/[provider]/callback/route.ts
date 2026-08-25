import { NextRequest } from "next/server";
import { completeOAuth } from "@/lib/oauth-flow";
import {
  completeGoogleDriveOAuth,
  hasPendingGoogleDriveOAuth,
} from "@/lib/google-drive-oauth-flow";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");

  if (provider === "google" && (await hasPendingGoogleDriveOAuth())) {
    return completeGoogleDriveOAuth(code, state, oauthError);
  }

  if (oauthError) {
    return completeOAuth(provider, null, null);
  }

  return completeOAuth(provider, code, state);
}
