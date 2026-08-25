import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { exchangeJiraCode, getAccessibleResources } from "@/lib/jira";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings/jira?error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/settings/jira?error=missing_code", request.url));
  }

  const cookieStore = await cookies();
  const stored = cookieStore.get("jira_oauth_state")?.value;
  cookieStore.delete("jira_oauth_state");

  if (!stored) {
    return NextResponse.redirect(new URL("/settings/jira?error=invalid_state", request.url));
  }

  const [storedState, workspaceId] = stored.split(":");
  if (storedState !== state) {
    return NextResponse.redirect(new URL("/settings/jira?error=state_mismatch", request.url));
  }

  try {
    const tokens = await exchangeJiraCode(code);
    const resources = await getAccessibleResources(tokens.access_token);
    const site = resources[0];

    if (!site) {
      return NextResponse.redirect(new URL("/settings/jira?error=no_site", request.url));
    }

    await db.jiraConnection.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        cloudId: site.id,
        siteUrl: site.url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
      update: {
        cloudId: site.id,
        siteUrl: site.url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });

    return NextResponse.redirect(new URL("/settings/jira?connected=1", request.url));
  } catch {
    return NextResponse.redirect(new URL("/settings/jira?error=oauth_token_failed", request.url));
  }
}
