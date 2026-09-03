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
 * Env default for the "selfSignup" system flag (self-service registration and
 * OAuth first-time account creation). Off by default: only existing users may
 * log in. ALLOW_SIGNUP=true opens it; PM-OS Admin → Enablements can override
 * either way (resolution: isSelfSignupEnabled in system-flags.ts). Has no
 * effect when login itself is disabled.
 */
export function isSignupAllowed(): boolean {
  const raw = process.env.ALLOW_SIGNUP;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Env default for the per-org "googleSso" flag (DISABLE_GOOGLE_LOGIN=true → off). */
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

/** Dashboard feature gate — env default. Same polarity as DOCS_ENABLED: on when unset. */
export function isDashboardEnabled(): boolean {
  const raw = process.env.DASHBOARD_ENABLED;
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

export const ORG_FEATURE_KEYS = [
  "ideas",
  "docs",
  "chat",
  "dashboard",
  "ideasUndo",
  "googleSso",
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
    case "googleSso":
      return !isGoogleLoginDisabled();
    case "ssoSkips2fa":
      return isSsoSkips2faDefault();
  }
}

export function isOrgFeatureKey(key: string): key is OrgFeatureKey {
  return (ORG_FEATURE_KEYS as readonly string[]).includes(key);
}

// ————— System-wide flag overrides —————
//
// Switches that must resolve BEFORE sign-in (no user, so no org): e.g.
// self-service sign-up. Stored one row per key in SystemFlag; a stored row
// wins, otherwise the env default applies. Resolution lives in
// src/lib/system-flags.ts (needs the DB); managed in PM-OS Admin → Enablements.
// (Google SSO used to live here; since 2026-09-03 it is a per-org flag —
// the /login button shows whenever Google is configured, and the org's flag
// is enforced once Google returns the email, in signInWithOAuth.)

export const SYSTEM_FLAG_KEYS = ["selfSignup"] as const;
export type SystemFlagKey = (typeof SYSTEM_FLAG_KEYS)[number];

export function isSystemFlagKey(key: string): key is SystemFlagKey {
  return (SYSTEM_FLAG_KEYS as readonly string[]).includes(key);
}

/** Env-level default for a system flag (applies when no override row exists). */
export function envSystemFlagDefault(key: SystemFlagKey): boolean {
  switch (key) {
    case "selfSignup":
      return isSignupAllowed();
  }
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

