import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { aggregateTickets } from "@/lib/aggregation";
import { fetchIssuesForScope } from "@/lib/jira";

export async function POST(request: NextRequest) {
  try {
    const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
    const body = await request.json();
    const { projectKey, versionName, epicKey, statuses } = body;

    if (!projectKey) {
      return NextResponse.json({ error: "projectKey required" }, { status: 400 });
    }

    const issues = await fetchIssuesForScope(workspaceId, {
      projectKey,
      versionName: versionName || undefined,
      epicKey: epicKey || undefined,
      statuses: Array.isArray(statuses) ? statuses : undefined,
    });

    const result = await aggregateTickets(issues);

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Aggregation failed" },
      { status: 500 }
    );
  }
}
