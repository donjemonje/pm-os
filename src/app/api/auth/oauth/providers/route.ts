import { NextResponse } from "next/server";
import { getOAuthProviderStatuses } from "@/lib/oauth-providers";
import { isGoogleLoginDisabled, isLoginDisabled } from "@/lib/feature-flags";

export async function GET() {
  if (isLoginDisabled()) {
    return NextResponse.json({ providers: [] });
  }
  const providers = getOAuthProviderStatuses()
    .filter((p) => p.configured && !(p.provider === "google" && isGoogleLoginDisabled()))
    .map((p) => ({ provider: p.provider, label: p.label }));
  return NextResponse.json({ providers });
}
