import { NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getJiraHealth } from "@/lib/jira";

/** Fresh connection health — the Ideas page asks right before an import. */
export async function GET() {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const [enabled, health] = await Promise.all([
    featureEnabledForCurrentUser("jira"),
    getJiraHealth(workspaceResult),
  ]);
  return NextResponse.json({ enabled, ...health });
}
