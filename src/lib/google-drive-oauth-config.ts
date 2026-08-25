/** Google Drive integration — reuses Sign in with Google OAuth (same callback URL). */

import { oauthCallbackUrl } from "./oauth-providers";
import { getOAuthProviderConfig } from "./oauth-providers";

/** GCP project that owns PM-OS OAuth (consent screen + client credentials). */
export const PMOS_GCP_PROJECT_ID = "pm-os-9d992";

/** Shown on Google's OAuth consent screen — configured in GCP, not in app code. */
export const PMOS_GOOGLE_OAUTH_BRANDING = {
  appName: "PM-OS",
  supportEmail: "daniel@pm-os.io",
} as const;

export function googleOAuthClientProjectNumber(clientId: string): string | null {
  const match = clientId.match(/^(\d+)-/);
  return match?.[1] ?? null;
}

export function googleOAuthConsoleUrl(path: string): string {
  return `https://console.cloud.google.com/${path}?project=${PMOS_GCP_PROJECT_ID}`;
}

export const GOOGLE_DRIVE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
] as const;

export function getGoogleDriveRedirectUri(): string | null {
  if (!getOAuthProviderConfig("google")) return null;
  return oauthCallbackUrl("google");
}

export function getGoogleDriveClientCredentials(): { clientId: string; clientSecret: string } | null {
  const config = getOAuthProviderConfig("google");
  if (!config) return null;
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

export interface GoogleDriveOAuthSetupStatus {
  ready: boolean;
  issues: string[];
  redirectUri: string | null;
  clientIdHint: string | null;
  usesLoginOAuth: boolean;
}

export function getGoogleDriveOAuthSetupStatus(): GoogleDriveOAuthSetupStatus {
  const config = getOAuthProviderConfig("google");
  const redirectUri = getGoogleDriveRedirectUri();
  const issues: string[] = [];

  if (!config) {
    issues.push(
      "Google Sign-In is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (same credentials used for login)."
    );
  }

  if (!process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    issues.push("NEXT_PUBLIC_APP_URL is empty. Set it to your app origin, e.g. http://localhost:3000");
  }

  return {
    ready: issues.length === 0 && Boolean(redirectUri),
    issues,
    redirectUri,
    clientIdHint: config?.clientId ? `${config.clientId.slice(0, 8)}…` : null,
    usesLoginOAuth: true,
  };
}

export function assertGoogleDriveOAuthReady(): void {
  const status = getGoogleDriveOAuthSetupStatus();
  if (!status.ready) {
    throw new Error(status.issues.join(" "));
  }
}

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
