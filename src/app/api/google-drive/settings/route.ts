import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { disconnectGoogleDrive, saveGoogleDriveFolderIds } from "@/lib/google-drive";

export async function POST(request: NextRequest) {
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const body = await request.json();
  const { folderIds } = body as { folderIds?: string[] };

  if (!Array.isArray(folderIds)) {
    return NextResponse.json({ error: "folderIds array required" }, { status: 400 });
  }

  await saveGoogleDriveFolderIds(workspaceResult, folderIds);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  await disconnectGoogleDrive(workspaceResult);
  return NextResponse.json({ ok: true });
}
