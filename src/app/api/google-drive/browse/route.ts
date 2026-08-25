import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { browseGoogleDrive } from "@/lib/google-drive";

export async function GET(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const parent = request.nextUrl.searchParams.get("parent")?.trim() || undefined;
  const search = request.nextUrl.searchParams.get("q")?.trim() || undefined;

  try {
    const result = await browseGoogleDrive(workspaceResult, { parentId: parent, search });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to browse Drive";
    const friendly =
      message.includes("not connected") || message.includes("token refresh")
        ? "Google Drive connection expired. Reconnect in Settings."
        : "Could not load Google Drive. Try reconnecting in Settings.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
