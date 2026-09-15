import { NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { getGoogleDriveConnectionStatus } from "@/lib/google-drive";

export async function GET() {
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const status = await getGoogleDriveConnectionStatus(workspaceResult);
  return NextResponse.json({ status });
}
