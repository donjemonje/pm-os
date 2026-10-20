import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";

/**
 * Ideas → Jira output config for one organization (stored on its workspace).
 * PUT replaces the config: the body is normalized through the same merge the
 * push path uses, so whatever is stored is always a complete, valid config.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    include: { jiraConnection: { select: { id: true, ideasIssueType: true } } },
  });
  if (!workspace) {
    return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  }

  const config = mergeIdeasJiraConfig(body);
  await db.workspace.update({
    where: { id: workspace.id },
    data: { ideasConfig: config as unknown as Prisma.InputJsonValue },
  });

  // The config is the source of truth for the org's Jira project and work
  // type; the connection row mirrors them so every reader of the connection
  // (Docs catalog, legacy paths) sees the same project.
  if (workspace.jiraConnection && config.jiraProject) {
    await db.jiraConnection.update({
      where: { id: workspace.jiraConnection.id },
      data: {
        projectKeys: JSON.stringify([config.jiraProject]),
        ideasProjectKey: config.jiraProject,
        ...(config.jiraIssueType ? { ideasIssueType: config.jiraIssueType } : {}),
      },
    });
  }

  return NextResponse.json({ config });
}
