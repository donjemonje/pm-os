import { NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { listJiraProjects } from "@/lib/jira";

export async function GET() {
  try {
    const workspaceResult = await apiWorkspaceId();
    if (workspaceResult instanceof NextResponse) return workspaceResult;
    const workspaceId = workspaceResult;
    const projects = await listJiraProjects(workspaceId);
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch projects" },
      { status: 400 }
    );
  }
}
