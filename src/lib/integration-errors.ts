const INTEGRATION_ERRORS: Record<string, string> = {
  google_not_configured: "Google Drive isn't available yet. Ask your administrator.",
  oauth_not_configured: "This integration isn't available yet. Ask your administrator.",
  oauth_denied: "Connection was cancelled.",
  oauth_expired: "Connection timed out. Please try again.",
  oauth_state_mismatch: "Something went wrong. Please try again.",
  oauth_token_failed: "Could not connect. Please try again.",
  missing_refresh_token:
    "Google didn't grant ongoing access. Remove PM-OS from your Google account permissions, then connect again.",
  redirect_uri_mismatch:
    "Google OAuth redirect URI isn't registered. Add the callback URL shown in Settings to your GCP OAuth client.",
  missing_code: "Connection was cancelled.",
  invalid_state: "Connection timed out. Please try again.",
  state_mismatch: "Something went wrong. Please try again.",
  no_site: "No Jira site was found on your account.",
};

/** Map OAuth / setup error codes to plain-language messages for the settings UI. */
export function formatIntegrationError(error: string): string {
  if (INTEGRATION_ERRORS[error]) return INTEGRATION_ERRORS[error];

  if (error.startsWith("missing_refresh_token")) {
    return INTEGRATION_ERRORS.missing_refresh_token;
  }

  if (
    error.includes("GOOGLE_CLIENT") ||
    error.includes("ATLASSIAN_CLIENT") ||
    error.includes(".env") ||
    error.includes("NEXT_PUBLIC_APP_URL")
  ) {
    return INTEGRATION_ERRORS.oauth_not_configured;
  }

  return "Could not connect. Please try again.";
}
