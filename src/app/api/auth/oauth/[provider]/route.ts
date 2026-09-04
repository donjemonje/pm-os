import { NextRequest } from "next/server";
import { startOAuth } from "@/lib/oauth-flow";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const from = request.nextUrl.searchParams.get("from");
  const invite = request.nextUrl.searchParams.get("invite");
  return startOAuth(provider, from, invite);
}
