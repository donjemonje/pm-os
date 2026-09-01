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

  // The Jira issue type created ideas get lives on the workspace's Jira
  // connection (also settable in Settings → Jira) — mergeIdeasJiraConfig
  // drops it from the stored config, so it never exists in two places.
  let ideasIssueType = workspace.jiraConnection?.ideasIssueType ?? null;
  const requestedIssueType =
    body && typeof body === "object" ? (body as Record<string, unknown>).ideasIssueType : undefined;
  if (
    workspace.jiraConnection &&
    typeof requestedIssueType === "string" &&
    requestedIssueType.trim().length > 0
  ) {
    ideasIssueType = requestedIssueType.trim();
    await db.jiraConnection.update({
      where: { id: workspace.jiraConnection.id },
      data: { ideasIssueType },
    });
  }

  return NextResponse.json({ config, ideasIssueType });
}
