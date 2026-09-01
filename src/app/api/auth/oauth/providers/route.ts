import { NextResponse } from "next/server";
import { getOAuthProviderStatuses } from "@/lib/oauth-providers";
import { isLoginDisabled } from "@/lib/feature-flags";
import { systemFlagEnabled } from "@/lib/system-flags";

export async function GET() {
  if (isLoginDisabled()) {
    return NextResponse.json({ providers: [] });
  }
  const googleSso = await systemFlagEnabled("googleSso");
  const providers = getOAuthProviderStatuses()
    .filter((p) => p.configured && !(p.provider === "google" && !googleSso))
    .map((p) => ({ provider: p.provider, label: p.label }));
  return NextResponse.json({ providers });
}
