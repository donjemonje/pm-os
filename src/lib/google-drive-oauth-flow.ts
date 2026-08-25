import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "./db";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkce,
  getOAuthProviderConfig,
} from "./oauth-providers";
import { GOOGLE_DRIVE_SCOPES } from "./google-drive-oauth-config";
import { fetchGoogleAccountEmail } from "./google-drive";

const GOOGLE_DRIVE_STATE_COOKIE = "pmos_google_drive_oauth";
const GOOGLE_DRIVE_PKCE_COOKIE = "pmos_google_drive_pkce";

function settingsRedirect(params?: Record<string, string>) {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = new URL("/settings/jira", base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return NextResponse.redirect(url);
}

export async function startGoogleDriveOAuth(workspaceId: string) {
  if (!getOAuthProviderConfig("google")) {
    return settingsRedirect({ drive_error: "google_not_configured" });
  }

  const state = randomUUID();
  const { verifier, challenge } = generatePkce();
  const authorizeUrl = buildAuthorizeUrl("google", state, challenge, {
    scopes: [...GOOGLE_DRIVE_SCOPES],
    accessType: "offline",
    prompt: "consent",
    includeGrantedScopes: true,
  });

  if (!authorizeUrl) {
    return settingsRedirect({ drive_error: "google_not_configured" });
  }

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(GOOGLE_DRIVE_STATE_COOKIE, `${state}:${workspaceId}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  response.cookies.set(GOOGLE_DRIVE_PKCE_COOKIE, verifier, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return response;
}

export async function completeGoogleDriveOAuth(
  code: string | null,
  state: string | null,
  oauthError?: string | null
) {
  if (oauthError) {
    return settingsRedirect({ drive_error: oauthError });
  }

  if (!code || !state) {
    return settingsRedirect({ drive_error: "oauth_denied" });
  }

  const cookieStore = await cookies();
  const stored = cookieStore.get(GOOGLE_DRIVE_STATE_COOKIE)?.value;
  const pkceVerifier = cookieStore.get(GOOGLE_DRIVE_PKCE_COOKIE)?.value;

  const clearCookies = (response: NextResponse) => {
    response.cookies.set(GOOGLE_DRIVE_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    response.cookies.set(GOOGLE_DRIVE_PKCE_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  };

  if (!stored || !pkceVerifier) {
    return settingsRedirect({ drive_error: "oauth_expired" });
  }

  const [expectedState, workspaceId] = stored.split(":");
  if (expectedState !== state || !workspaceId) {
    return settingsRedirect({ drive_error: "oauth_state_mismatch" });
  }

  const tokens = await exchangeCodeForTokens("google", code, pkceVerifier);
  if (!tokens?.access_token) {
    return clearCookies(settingsRedirect({ drive_error: "oauth_token_failed" }));
  }

  const existing = await db.googleDriveConnection.findUnique({ where: { workspaceId } });
  const refreshToken = tokens.refresh_token ?? existing?.refreshToken;
  if (!refreshToken) {
    return clearCookies(settingsRedirect({ drive_error: "missing_refresh_token" }));
  }

  const email = await fetchGoogleAccountEmail(tokens.access_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);

  await db.googleDriveConnection.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      email,
    },
    update: {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      email,
    },
  });

  return clearCookies(settingsRedirect({ drive_connected: "1" }));
}

export async function hasPendingGoogleDriveOAuth(): Promise<boolean> {
  const cookieStore = await cookies();
  return Boolean(cookieStore.get(GOOGLE_DRIVE_STATE_COOKIE)?.value);
}
