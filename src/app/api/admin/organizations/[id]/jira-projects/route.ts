import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { listJiraProjects, listProjectIssueTypes } from "@/lib/jira";

/**
 * Admin → Ideas → Jira onboarding data, read through the ORGANIZATION's own
 * connection: its projects, and — with ?project=KEY — that project's work
 * types plus the suggested default (the type the pulled issues use most,
 * else the first non-subtask type Jira lists). Not connected → empty lists.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    select: { id: true, jiraConnection: { select: { id: true } } },
  });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  const project = request.nextUrl.searchParams.get("project")?.trim().toUpperCase() || null;
  if (!workspace.jiraConnection) {
    return NextResponse.json({ connected: false, projects: [], issueTypes: [], defaultIssueType: "" });
  }
  try {
    const [projects, issueTypes] = await Promise.all([
      listJiraProjects(workspace.id),
      project ? listProjectIssueTypes(workspace.id, project) : Promise.resolve([] as string[]),
    ]);
    let defaultIssueType = "";
    if (project) {
      const pulled = await db.jiraIdeaSnapshot.groupBy({
        by: ["issueType"],
        where: { workspaceId: workspace.id, key: { startsWith: `${project}-` } },
        _count: { _all: true },
        orderBy: { _count: { issueType: "desc" } },
      });
      defaultIssueType = pulled.find((p) => p.issueType)?.issueType ?? issueTypes[0] ?? "";
    }
    return NextResponse.json({
      connected: true,
      projects: projects.map((p) => ({ key: p.key, name: p.name })),
      issueTypes,
      defaultIssueType,
    });
  } catch (err) {
    return NextResponse.json({
      connected: true,
      projects: [],
      issueTypes: [],
      defaultIssueType: "",
      error: err instanceof Error ? err.message : "Could not read Jira",
    });
  }
}
