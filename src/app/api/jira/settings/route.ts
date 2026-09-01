import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { stringifyJsonArray } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const { projectKeys, ideasProjectKey, ideasIssueType } = await request.json();

  if (!Array.isArray(projectKeys)) {
    return NextResponse.json({ error: "projectKeys must be an array" }, { status: 400 });
  }

  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) {
    return NextResponse.json({ error: "Jira not connected" }, { status: 400 });
  }

  // The ideas target must stay inside the connected project list — otherwise
  // the next import can't see the issues the merge created.
  const target =
    typeof ideasProjectKey === "string" && ideasProjectKey.length > 0 ? ideasProjectKey : null;
  if (target && !projectKeys.includes(target)) {
    return NextResponse.json(
      { error: "ideasProjectKey must be one of the selected projects" },
      { status: 400 }
    );
  }

  await db.jiraConnection.update({
    where: { id: connection.id },
    data: {
      projectKeys: stringifyJsonArray(projectKeys),
      ideasProjectKey: target,
      ...(typeof ideasIssueType === "string" && ideasIssueType.length > 0
        ? { ideasIssueType }
        : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
