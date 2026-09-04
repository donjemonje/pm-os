import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchOAuthProfile,
  generatePkce,
  getOAuthProviderConfig,
  isOAuthProvider,
  type OAuthProvider,
} from "./oauth-providers";
import {
  createSession,
  sessionCookieOptions,
  signInWithOAuth,
  twoFactorPendingCookieOptions,
} from "./auth";
import {
  envFeatureDefault,
  isGoogleLoginDisabled,
  isLoginDisabled,
  resolveFeature,
} from "./feature-flags";

const OAUTH_STATE_COOKIE = "pmos_oauth_state";
const OAUTH_PKCE_COOKIE = "pmos_oauth_pkce";
const OAUTH_INVITE_COOKIE = "pmos_oauth_invite";

/**
 * Only same-origin app paths may be used as a post-login redirect. A bare
 * startsWith("/") check lets "//evil.com" and "/\\evil.com" through (both
 * resolve to another host), so the value is parsed against the app origin.
 */
function safeAppPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/";
  }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin) return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

function authRedirect(path: string, params?: Record<string, string>) {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return NextResponse.redirect(url);
}

function setOAuthCookies(
  response: NextResponse,
  state: string,
  provider: OAuthProvider,
  from: string,
  pkceVerifier: string
) {
  response.cookies.set(OAUTH_STATE_COOKIE, `${state}:${provider}:${from}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  response.cookies.set(OAUTH_PKCE_COOKIE, pkceVerifier, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
}

function clearOAuthCookies(response: NextResponse) {
  response.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_PKCE_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_INVITE_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function startOAuth(
  provider: string,
  fromParam?: string | null,
  inviteToken?: string | null
) {
  if (isLoginDisabled()) {
    return authRedirect("/login");
  }
  if (!isOAuthProvider(provider)) {
    return authRedirect("/login", { error: "invalid_provider" });
  }

  if (provider === "google" && isGoogleLoginDisabled()) {
    return authRedirect("/login", { error: "google_sso_disabled" });
  }

  if (!getOAuthProviderConfig(provider)) {
    return authRedirect("/login", { error: `${provider}_not_configured` });
  }

  const from = safeAppPath(fromParam);
  const state = randomUUID();
  const { verifier, challenge } = generatePkce();
  const authorizeUrl = buildAuthorizeUrl(provider, state, challenge);

  if (!authorizeUrl) {
    return authRedirect("/login", { error: `${provider}_not_configured` });
  }

  const response = NextResponse.redirect(authorizeUrl);
  setOAuthCookies(response, state, provider, from, verifier);
  // Invite completion via Google: carry the invite token across the round
  // trip so signInWithOAuth can require and consume it.
  if (inviteToken?.trim()) {
    response.cookies.set(OAUTH_INVITE_COOKIE, inviteToken.trim(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  }
  return response;
}

export async function completeOAuth(provider: string, code: string | null, state: string | null) {
  if (isLoginDisabled()) {
    return authRedirect("/login");
  }

  const loginError = (error: string) => authRedirect("/login", { error });

  if (!isOAuthProvider(provider)) {
    return loginError("invalid_provider");
  }

  if (provider === "google" && isGoogleLoginDisabled()) {
    return loginError("google_sso_disabled");
  }

  if (!code || !state) {
    return loginError("oauth_denied");
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  const pkceVerifier = cookieStore.get(OAUTH_PKCE_COOKIE)?.value;
  const inviteToken = cookieStore.get(OAUTH_INVITE_COOKIE)?.value ?? null;

  if (!storedState || !pkceVerifier) {
    return loginError("oauth_expired");
  }

  const [expectedState, expectedProvider, from] = storedState.split(":");
  if (expectedState !== state || expectedProvider !== provider) {
    return loginError("oauth_state_mismatch");
  }

  const tokens = await exchangeCodeForTokens(provider, code, pkceVerifier);
  if (!tokens) {
    return loginError("oauth_token_failed");
  }

  const profile = await fetchOAuthProfile(provider, tokens.access_token);
  if (!profile) {
    return loginError("oauth_profile_failed");
  }

  try {
    const user = await signInWithOAuth({
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      inviteToken,
    });
    const redirectTo = safeAppPath(from);
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    // 2FA is mandatory — every OAuth login lands on the TOTP step — unless
    // the user's organization has "Google SSO skips 2FA" on (PM-OS Admin →
    // Enablements → Login). Then the session starts verified and the user
    // goes straight to the app.
    const skipTwoFactor = resolveFeature(
      user.organizationFeatures,
      "ssoSkips2fa",
      envFeatureDefault("ssoSkips2fa")
    );
    const token = await createSession(user.id, { twoFactorVerified: skipTwoFactor });

    let target: URL;
    if (skipTwoFactor) {
      target = new URL(redirectTo, base);
    } else {
      target = new URL("/login/2fa", base);
      target.searchParams.set("from", redirectTo);
    }
    const response = NextResponse.redirect(target);
    clearOAuthCookies(response);
    const opts = sessionCookieOptions(token);
    response.cookies.set(opts.name, opts.value, {
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      path: opts.path,
      secure: opts.secure,
      maxAge: opts.maxAge,
    });
    const pending = twoFactorPendingCookieOptions(!skipTwoFactor);
    response.cookies.set(pending.name, pending.value, pending);
    return response;
  } catch (e) {
    const message = e instanceof Error ? e.message : "oauth_signin_failed";
    return loginError(message);
  }
}
