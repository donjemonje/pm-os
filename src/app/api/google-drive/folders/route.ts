import { NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { listGoogleDriveFolderOptions } from "@/lib/google-drive";

export async function GET() {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  try {
    const folders = await listGoogleDriveFolderOptions(workspaceResult);
    return NextResponse.json({ folders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list folders";
    const friendly =
      message.includes("not connected") || message.includes("token refresh")
        ? "Google Drive connection expired. Reconnect in Settings."
        : "Could not load folders. Try reconnecting in Settings.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
