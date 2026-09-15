import { NextResponse } from "next/server";
import { getOAuthProviderStatuses } from "@/lib/oauth-providers";

export async function GET() {
  const providers = getOAuthProviderStatuses()
    .filter((p) => p.configured)
    .map((p) => ({ provider: p.provider, label: p.label }));
  return NextResponse.json({ providers });
}
