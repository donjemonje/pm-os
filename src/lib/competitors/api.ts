import { NextResponse } from "next/server";
import { canManageOrgSettings } from "../admin-auth";
import { orgFeatureDisabledResponse } from "../api-auth";
import { getCurrentUser, type AuthUser } from "../auth";
import { MAX_CAPABILITY_DESCRIPTION } from "./config";
import { getCompetitorsState, type CompetitorsState } from "./store";

/**
 * Shared guard of every /api/competitors route: the org flag (404 when off),
 * a signed-in user with a workspace (401), and — for catalog and settings
 * writes — the customer-admin role (403). Mutations answer with the whole
 * state so the client swaps it in one go.
 */

export interface CompetitorsApiContext {
  user: AuthUser;
  workspaceId: string;
  orgName: string;
}

export async function competitorsGuard(opts: { admin?: boolean } = {}): Promise<CompetitorsApiContext | NextResponse> {
  const disabled = await orgFeatureDisabledResponse("competitors");
  if (disabled) return disabled;
  const user = await getCurrentUser();
  if (!user || !user.workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (opts.admin && !canManageOrgSettings(user)) {
    return NextResponse.json({ error: "Only an admin can change competitors settings" }, { status: 403 });
  }
  return { user, workspaceId: user.workspaceId, orgName: user.organizationName ?? "" };
}

export async function stateResponse(ctx: CompetitorsApiContext, status = 200): Promise<NextResponse> {
  const state: CompetitorsState = await getCompetitorsState(ctx.workspaceId, ctx.orgName, ctx.user.id);
  return NextResponse.json({ state }, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

export function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export const MAX_NAME = 80;
export const MAX_DESCRIPTION = MAX_CAPABILITY_DESCRIPTION;
export const MAX_NOTE = 500;

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s && s.length <= MAX_NAME ? s : null;
}

export function cleanText(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}
