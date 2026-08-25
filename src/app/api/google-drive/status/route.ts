import { NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { getGoogleDriveConnectionStatus } from "@/lib/google-drive";

export async function GET() {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const status = await getGoogleDriveConnectionStatus(workspaceResult);
  return NextResponse.json({ status });
}
