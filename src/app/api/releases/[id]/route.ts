import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiWorkspaceId } from "@/lib/api-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

  const { id } = await params;
  const release = await db.release.findFirst({
    where: { id, workspaceId },
    include: { documents: true },
  });

  if (!release) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ release });
}
