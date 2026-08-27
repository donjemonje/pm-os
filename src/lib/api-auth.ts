import { NextResponse } from "next/server";
import { OrgFeatureKey } from "./feature-flags";
import { featureEnabledForCurrentUser } from "./org-features";
import { getWorkspaceId, requireUser, UnauthorizedError } from "./workspace";

/**
 * 404 for API routes behind an org feature flag when it is off for the
 * caller's org (org override first, env default otherwise); null when
 * enabled.
 */
export async function orgFeatureDisabledResponse(
  key: OrgFeatureKey
): Promise<NextResponse | null> {
  if (await featureEnabledForCurrentUser(key)) return null;
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function ideasDisabledResponse(): Promise<NextResponse | null> {
  return orgFeatureDisabledResponse("ideas");
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
