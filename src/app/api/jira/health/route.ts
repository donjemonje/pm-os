import { NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getJiraHealth } from "@/lib/jira";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";

/** Fresh connection health — the Ideas page asks right before an import. */
export async function GET() {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const [enabled, health, ws] = await Promise.all([
    featureEnabledForCurrentUser("jira"),
    getJiraHealth(workspaceResult),
    db.workspace.findUnique({ where: { id: workspaceResult }, select: { ideasConfig: true } }),
  ]);
  const status =
    health.status === "ok" && enabled && !mergeIdeasJiraConfig(ws?.ideasConfig).jiraProject
      ? "not_configured"
      : health.status;
  return NextResponse.json({ enabled, ...health, status });
}
