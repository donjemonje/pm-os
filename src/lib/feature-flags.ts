export const LOGIN_DISABLED_MESSAGE = "Login is Currently Disabled";

export function isLoginDisabled(): boolean {
  const raw = process.env.DISABLE_LOGIN;
  if (!raw?.trim()) return true;
  const value = raw.trim().toLowerCase();
  if (value === "false" || value === "0") return false;
  return true;
}

/** Env-only switch: hide Google sign-in everywhere (login, invites, OAuth flow). */
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
 * Docs feature gate — env default. Off when unset (same polarity as
 * IDEAS_ENABLED since 2026-09-03): surfaces are opted in per organization in
 * PM-OS Admin → Enablements, or globally with DOCS_ENABLED=true.
 */
export function isDocsEnabled(): boolean {
  const raw = process.env.DOCS_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Chat feature gate — env default. Off when unset; CHAT_ENABLED=true turns it on globally. */
export function isChatEnabled(): boolean {
  const raw = process.env.CHAT_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Ideas undo gate — env default. Off by default like IDEAS_ENABLED: undo of a
 * merge is a demo affordance until proven safe for production workflows.
 */
export function isIdeasUndoEnabled(): boolean {
  const raw = process.env.IDEAS_UNDO_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Env default for the per-org "ssoSkips2fa" flag: Google sign-ins skip the
 * TOTP step. Off unless SSO_SKIPS_2FA=true — 2FA is mandatory by default.
 */
export function isSsoSkips2faDefault(): boolean {
  const raw = process.env.SSO_SKIPS_2FA;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Dashboard feature gate — env default. Off when unset; DASHBOARD_ENABLED=true turns it on globally. */
export function isDashboardEnabled(): boolean {
  const raw = process.env.DASHBOARD_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

// ————— Per-organization feature overrides —————
//
// Organization.features is a JSON object like {"ideas": true}. Resolution
// rule: an org value wins when the key is present (boolean); otherwise the
// env default applies. Keys outside ORG_FEATURE_KEYS are rejected by the
// admin API and ignored here. Managed in PM-OS Admin → Enablements.

export const ORG_FEATURE_KEYS = [
  "ideas",
  "docs",
  "chat",
  "dashboard",
  "ideasUndo",
  "ssoSkips2fa",
] as const;
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
    case "dashboard":
      return isDashboardEnabled();
    case "ideasUndo":
      return isIdeasUndoEnabled();
    case "ssoSkips2fa":
      return isSsoSkips2faDefault();
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

