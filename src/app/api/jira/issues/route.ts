import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import {
  fetchIssuesByKeys,
  fetchIssuesForVersion,
  fetchRecentDoneIssues,
} from "@/lib/jira";

export async function GET(request: NextRequest) {
  const projectKey = request.nextUrl.searchParams.get("projectKey");
  const versionName = request.nextUrl.searchParams.get("versionName");
  const keys = request.nextUrl.searchParams.get("keys");

  try {
    const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

    if (keys) {
      const issueKeys = keys.split(",").map((k) => k.trim()).filter(Boolean);
      const issues = await fetchIssuesByKeys(workspaceId, issueKeys);
      return NextResponse.json({ issues });
    }

    if (projectKey && versionName) {
      const issues = await fetchIssuesForVersion(workspaceId, projectKey, versionName);
      return NextResponse.json({ issues });
    }

    if (projectKey) {
      const issues = await fetchRecentDoneIssues(workspaceId, projectKey);
      return NextResponse.json({ issues });
    }

    return NextResponse.json({ error: "Provide projectKey or keys" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch issues" },
      { status: 400 }
    );
  }
}
