import { NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { getJiraAuthUrl } from "@/lib/jira";
import { getJiraOAuthSetupStatus } from "@/lib/jira-oauth-config";
import { randomUUID } from "crypto";
import { cookies } from "next/headers";

export async function GET() {
  const setup = getJiraOAuthSetupStatus();
  if (!setup.ready) {
    return NextResponse.redirect(
      new URL(
        "/settings/jira?error=oauth_not_configured",
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
      )
    );
  }

  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) {
    return NextResponse.redirect(
      new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    );
  }
  const workspaceId = workspaceResult;
  const state = randomUUID();
  const cookieStore = await cookies();

  cookieStore.set("jira_oauth_state", `${state}:${workspaceId}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(getJiraAuthUrl(state));
}
