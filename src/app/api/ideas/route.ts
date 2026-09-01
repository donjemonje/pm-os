import { NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { clearIdeas, getIdeasState } from "@/lib/ideas/store";

export async function GET() {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  return NextResponse.json(await getIdeasState(workspaceResult));
}

export async function DELETE() {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  return NextResponse.json(await clearIdeas(workspaceResult));
}
