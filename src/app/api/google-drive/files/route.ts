import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { listGoogleDriveFiles } from "@/lib/google-drive";

export async function GET(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const search = request.nextUrl.searchParams.get("q")?.trim() || undefined;
  const folderId = request.nextUrl.searchParams.get("folder")?.trim() || undefined;

  try {
    const files = await listGoogleDriveFiles(workspaceResult, { search, folderId });
    return NextResponse.json({ files });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list files";
    const friendly =
      message.includes("not connected") || message.includes("token refresh")
        ? "Google Drive connection expired. Reconnect in Settings."
        : "Could not load files. Try reconnecting in Settings.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
