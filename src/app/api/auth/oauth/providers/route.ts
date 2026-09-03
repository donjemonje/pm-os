import { NextResponse } from "next/server";
import { getOAuthProviderStatuses } from "@/lib/oauth-providers";
import { isLoginDisabled } from "@/lib/feature-flags";

export async function GET() {
  if (isLoginDisabled()) {
    return NextResponse.json({ providers: [] });
  }
  // Google SSO is a per-org flag enforced after Google returns the email
  // (signInWithOAuth); before sign-in the button shows whenever configured.
  const providers = getOAuthProviderStatuses()
    .filter((p) => p.configured)
    .map((p) => ({ provider: p.provider, label: p.label }));
  return NextResponse.json({ providers });
}
