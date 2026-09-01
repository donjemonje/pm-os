import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { listProjectIssueTypes } from "@/lib/jira";

/** Non-subtask issue type names of a project — feeds the ideas-target picker. */
export async function GET(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  const projectKey = request.nextUrl.searchParams.get("project");
  if (!projectKey) {
    return NextResponse.json({ error: "project is required" }, { status: 400 });
  }

  try {
    const issueTypes = await listProjectIssueTypes(workspaceResult, projectKey);
    return NextResponse.json({ issueTypes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load issue types" },
      { status: 502 }
    );
  }
}
