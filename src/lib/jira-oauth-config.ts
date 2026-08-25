/** Atlassian OAuth 2.0 (3LO) — https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/ */

export const JIRA_OAUTH_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
] as const;

export function getAppBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export function getJiraRedirectUri(): string | null {
  const base = getAppBaseUrl();
  if (!base) return null;
  return `${base}/api/auth/jira/callback`;
}

export interface JiraOAuthSetupStatus {
  ready: boolean;
  issues: string[];
  redirectUri: string | null;
  /** First 8 chars of client id — safe to show for debugging */
  clientIdHint: string | null;
}

export function getJiraOAuthSetupStatus(): JiraOAuthSetupStatus {
  const clientId = process.env.ATLASSIAN_CLIENT_ID?.trim();
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET?.trim();
  const redirectUri = getJiraRedirectUri();
  const issues: string[] = [];

  if (!clientId) {
    issues.push(
      "ATLASSIAN_CLIENT_ID is empty. Copy the Client ID from developer.atlassian.com → your app → Settings (OAuth 2.0 app, not Forge)."
    );
  }

  if (!clientSecret) {
    issues.push("ATLASSIAN_CLIENT_SECRET is empty. Copy the Secret from the same Settings page.");
  }

  if (!getAppBaseUrl()) {
    issues.push(
      "NEXT_PUBLIC_APP_URL is empty. Set it to your app origin, e.g. http://localhost:3000 (no trailing slash)."
    );
  }

  if (getAppBaseUrl() && !getAppBaseUrl()!.startsWith("http")) {
    issues.push("NEXT_PUBLIC_APP_URL must start with http:// or https://");
  }

  return {
    ready: issues.length === 0 && Boolean(redirectUri),
    issues,
    redirectUri,
    clientIdHint: clientId ? `${clientId.slice(0, 8)}…` : null,
  };
}

export function assertJiraOAuthReady(): void {
  const status = getJiraOAuthSetupStatus();
  if (!status.ready) {
    throw new Error(status.issues.join(" "));
  }
}
