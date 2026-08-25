import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { fetchEpicsForProject } from "@/lib/jira";

export async function GET(request: NextRequest) {
  const projectKey = request.nextUrl.searchParams.get("projectKey");
  if (!projectKey) {
    return NextResponse.json({ error: "projectKey required" }, { status: 400 });
  }

  try {
    const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
    const epics = await fetchEpicsForProject(workspaceId, projectKey);
    return NextResponse.json({ epics });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch epics" },
      { status: 400 }
    );
  }
}
