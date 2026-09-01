import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { undoIdeaPush } from "@/lib/ideas/undo";

/** Per-idea undo of the last merge to Jira. Behind the "ideasUndo" org flag. */
export async function POST(request: NextRequest) {
  const disabled = (await ideasDisabledResponse()) ?? (await orgFeatureDisabledResponse("ideasUndo"));
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  let ideaId: unknown;
  try {
    ({ ideaId } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof ideaId !== "string" || !ideaId) {
    return NextResponse.json({ error: "ideaId is required" }, { status: 400 });
  }

  const result = await undoIdeaPush(workspaceResult, ideaId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(result);
}
