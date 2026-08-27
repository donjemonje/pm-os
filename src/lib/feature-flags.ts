export const LOGIN_DISABLED_MESSAGE = "Login is Currently Disabled";
export const SIGNUP_DISABLED_MESSAGE = "Sign-up is currently disabled";

export function isLoginDisabled(): boolean {
  const raw = process.env.DISABLE_LOGIN;
  if (!raw?.trim()) return true;
  const value = raw.trim().toLowerCase();
  if (value === "false" || value === "0") return false;
  return true;
}

/**
 * New-account creation gate. Disabled by default: only existing users may log
 * in. Set ALLOW_SIGNUP=true to open self-service registration (and OAuth
 * first-time account creation). Has no effect when login itself is disabled.
 */
export function isSignupAllowed(): boolean {
  const raw = process.env.ALLOW_SIGNUP;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Hide Google sign-in on /login while keeping Google Drive integration OAuth. */
export function isGoogleLoginDisabled(): boolean {
  const raw = process.env.DISABLE_GOOGLE_LOGIN;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Ideas feature gate — env default. Off by default; set IDEAS_ENABLED=true to enable globally. */
export function isIdeasEnabled(): boolean {
  const raw = process.env.IDEAS_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Docs feature gate — env default. Unlike IDEAS_ENABLED this is ON when
 * unset: docs is a live surface and a missing env var must not hide it.
 * Set DOCS_ENABLED=false to disable globally.
 */
export function isDocsEnabled(): boolean {
  const raw = process.env.DOCS_ENABLED;
  if (!raw?.trim()) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "false" || value === "0");
}

/** Chat feature gate — env default. Same polarity as DOCS_ENABLED: on when unset. */
export function isChatEnabled(): boolean {
  const raw = process.env.CHAT_ENABLED;
  if (!raw?.trim()) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "false" || value === "0");
}

// ————— Per-organization feature overrides —————
//
// Organization.features is a JSON object like {"ideas": true}. Resolution
// rule: an org value wins when the key is present (boolean); otherwise the
// env default applies. Keys outside ORG_FEATURE_KEYS are rejected by the
// admin API and ignored here. Managed in PM-OS Admin → Enablements.

export const ORG_FEATURE_KEYS = ["ideas", "docs", "chat"] as const;
export type OrgFeatureKey = (typeof ORG_FEATURE_KEYS)[number];

/** Env-level default for a flag (what applies when the org has no override). */
export function envFeatureDefault(key: OrgFeatureKey): boolean {
  switch (key) {
    case "ideas":
      return isIdeasEnabled();
    case "docs":
      return isDocsEnabled();
    case "chat":
      return isChatEnabled();
  }
}

export function isOrgFeatureKey(key: string): key is OrgFeatureKey {
  return (ORG_FEATURE_KEYS as readonly string[]).includes(key);
}

/** Pure resolver: org override if present, else the env default. */
export function resolveFeature(
  features: unknown,
  key: OrgFeatureKey,
  envDefault: boolean
): boolean {
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const value = (features as Record<string, unknown>)[key];
    if (typeof value === "boolean") return value;
  }
  return envDefault;
}

