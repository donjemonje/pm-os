import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { listJiraProjects } from "@/lib/jira";

/** The organization's Jira projects, for Admin → Ideas → Jira projects. Not connected → []. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    select: { id: true, jiraConnection: { select: { id: true } } },
  });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  if (!workspace.jiraConnection) return NextResponse.json({ connected: false, projects: [] });
  try {
    const projects = await listJiraProjects(workspace.id);
    return NextResponse.json({ connected: true, projects: projects.map((p) => ({ key: p.key, name: p.name })) });
  } catch (err) {
    return NextResponse.json({
      connected: true,
      projects: [],
      error: err instanceof Error ? err.message : "Could not list projects",
    });
  }
}
