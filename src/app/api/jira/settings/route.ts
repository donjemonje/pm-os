import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { stringifyJsonArray } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const { projectKeys } = await request.json();

  if (!Array.isArray(projectKeys)) {
    return NextResponse.json({ error: "projectKeys must be an array" }, { status: 400 });
  }

  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) {
    return NextResponse.json({ error: "Jira not connected" }, { status: 400 });
  }

  await db.jiraConnection.update({
    where: { id: connection.id },
    data: { projectKeys: stringifyJsonArray(projectKeys) },
  });

  return NextResponse.json({ ok: true });
}
