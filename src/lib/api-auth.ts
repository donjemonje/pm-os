import { NextResponse } from "next/server";
import { ideasEnabledForCurrentUser } from "./org-features";
import { getWorkspaceId, requireUser, UnauthorizedError } from "./workspace";

/**
 * 404 for Ideas API routes when the flag is off for the caller's org
 * (org override first, IDEAS_ENABLED env default otherwise); null when
 * enabled.
 */
export async function ideasDisabledResponse(): Promise<NextResponse | null> {
  if (await ideasEnabledForCurrentUser()) return null;
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function apiWorkspaceId(): Promise<string | NextResponse> {
  try {
    return await getWorkspaceId();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
}

export interface ApiAuthContext {
  userId: string;
  workspaceId: string;
}

export async function apiAuthContext(): Promise<ApiAuthContext | NextResponse> {
  try {
    const user = await requireUser();
    if (!user.workspaceId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return { userId: user.id, workspaceId: user.workspaceId };
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
}
