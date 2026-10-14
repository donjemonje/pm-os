import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { exchangeJiraCode, getAccessibleResources } from "@/lib/jira";
import { getAppBaseUrl } from "@/lib/jira-oauth-config";

/** Redirect target after the OAuth round trip. The request URL is the host the
 *  server listens on — inside App Hosting that is 0.0.0.0 — so the browser is
 *  sent to the public app URL instead. */
function back(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, getAppBaseUrl() ?? request.url));
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return back(request, `/settings/jira?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return back(request, "/settings/jira?error=missing_code");
  }

  const cookieStore = await cookies();
  const stored = cookieStore.get("jira_oauth_state")?.value;
  cookieStore.delete("jira_oauth_state");

  if (!stored) {
    return back(request, "/settings/jira?error=invalid_state");
  }

  const [storedState, workspaceId] = stored.split(":");
  if (storedState !== state) {
    return back(request, "/settings/jira?error=state_mismatch");
  }

  try {
    const tokens = await exchangeJiraCode(code);
    const resources = await getAccessibleResources(tokens.access_token);
    const site = resources[0];

    if (!site) {
      return back(request, "/settings/jira?error=no_site");
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
        authType: "oauth",
        cloudId: site.id,
        siteUrl: site.url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });

    return back(request, "/settings/jira?connected=1");
  } catch {
    return back(request, "/settings/jira?error=oauth_token_failed");
  }
}
