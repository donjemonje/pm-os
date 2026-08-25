import { createHash, randomBytes } from "crypto";

export const OAUTH_PROVIDERS = ["google", "microsoft"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function oauthCallbackUrl(provider: OAuthProvider): string {
  return `${appBaseUrl()}/api/auth/oauth/${provider}/callback`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type OAuthProviderStatus = {
  provider: OAuthProvider;
  configured: boolean;
  label: string;
};

export function getOAuthProviderStatuses(): OAuthProviderStatus[] {
  return [
    {
      provider: "google",
      label: "Google",
      configured: Boolean(
        process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()
      ),
    },
    {
      provider: "microsoft",
      label: "Microsoft",
      configured: Boolean(
        process.env.MICROSOFT_CLIENT_ID?.trim() &&
          process.env.MICROSOFT_CLIENT_SECRET?.trim()
      ),
    },
  ];
}

export function getOAuthProviderConfig(provider: OAuthProvider) {
  const redirectUri = oauthCallbackUrl(provider);
  const baseUrl = appBaseUrl();

  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      return null;
    }
    return {
      provider,
      clientId,
      clientSecret,
      redirectUri,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email", "profile"],
    };
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim() || "common";
  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    provider,
    clientId,
    clientSecret,
    redirectUri,
    tenant,
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: ["openid", "profile", "email", "User.Read"],
  };
}

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  state: string,
  codeChallenge: string,
  options?: {
    scopes?: string[];
    accessType?: "online" | "offline";
    prompt?: string;
    includeGrantedScopes?: boolean;
  }
): string | null {
  const config = getOAuthProviderConfig(provider);
  if (!config) return null;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: (options?.scopes ?? config.scopes).join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (provider === "google") {
    params.set("access_type", options?.accessType ?? "online");
    params.set("prompt", options?.prompt ?? "select_account");
    if (options?.includeGrantedScopes) {
      params.set("include_granted_scopes", "true");
    }
  }

  return `${config.authorizeUrl}?${params.toString()}`;
}

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  code: string,
  codeVerifier: string
): Promise<OAuthTokens | null> {
  const config = getOAuthProviderConfig(provider);
  if (!config) return null;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) return null;
  const data = (await res.json()) as OAuthTokens;
  return data.access_token ? data : null;
}

export type OAuthProfile = {
  providerUserId: string;
  email: string;
  name: string;
};

export async function fetchOAuthProfile(
  provider: OAuthProvider,
  accessToken: string
): Promise<OAuthProfile | null> {
  if (provider === "google") {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: string;
      email?: string;
      name?: string;
    };
    if (!data.id || !data.email) return null;
    return {
      providerUserId: data.id,
      email: data.email,
      name: data.name?.trim() || data.email.split("@")[0],
    };
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    id?: string;
    mail?: string | null;
    userPrincipalName?: string;
    displayName?: string;
  };
  const email = (data.mail || data.userPrincipalName || "").trim().toLowerCase();
  if (!data.id || !email) return null;
  return {
    providerUserId: data.id,
    email,
    name: data.displayName?.trim() || email.split("@")[0],
  };
}
