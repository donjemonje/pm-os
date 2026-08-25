import { NextResponse } from "next/server";
import type { AuthUser } from "./auth";
import { isIdeasEnabled } from "./feature-flags";
import { getWorkspaceId, requireUser, UnauthorizedError } from "./workspace";

/** Auth without the workspace requirement — for account-level routes (2FA). */
export async function apiUser(): Promise<AuthUser | NextResponse> {
  try {
    return await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
}

/** 404 for Ideas API routes when the feature flag is off; null when enabled. */
export function ideasDisabledResponse(): NextResponse | null {
  if (isIdeasEnabled()) return null;
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
