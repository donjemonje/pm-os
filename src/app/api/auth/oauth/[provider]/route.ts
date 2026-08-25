import { NextRequest } from "next/server";
import { startOAuth } from "@/lib/oauth-flow";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const from = request.nextUrl.searchParams.get("from");
  return startOAuth(provider, from);
}
