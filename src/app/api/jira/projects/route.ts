import { NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { listJiraProjects } from "@/lib/jira";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";

export async function GET() {
  try {
    const workspaceResult = await apiWorkspaceId();
    if (workspaceResult instanceof NextResponse) return workspaceResult;
    const workspaceId = workspaceResult;
    const [all, ws] = await Promise.all([
      listJiraProjects(workspaceId),
      db.workspace.findUnique({ where: { id: workspaceId }, select: { ideasConfig: true } }),
    ]);
    // Admin → Ideas → Jira projects: the org sees only its own keys.
    const allowed = mergeIdeasJiraConfig(ws?.ideasConfig).jiraProject;
    const projects = allowed ? all.filter((p) => p.key === allowed) : all;
    return NextResponse.json({ projects, restricted: Boolean(allowed) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch projects" },
      { status: 400 }
    );
  }
}
