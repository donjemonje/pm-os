import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getJiraHealth } from "@/lib/jira";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";

/** Connection health; `?fresh=1` skips the cached probe — the Ideas page
 *  asks that way right before an import. */
export async function GET(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const [enabled, health, ws] = await Promise.all([
    featureEnabledForCurrentUser("jira"),
    getJiraHealth(workspaceResult, { fresh: request.nextUrl.searchParams.get("fresh") === "1" }),
    db.workspace.findUnique({ where: { id: workspaceResult }, select: { ideasConfig: true } }),
  ]);
  const status =
    health.status === "ok" && enabled && !mergeIdeasJiraConfig(ws?.ideasConfig).jiraProject
      ? "not_configured"
      : health.status;
  return NextResponse.json({ enabled, ...health, status });
}
