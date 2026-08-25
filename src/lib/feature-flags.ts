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

/** Ideas feature gate. Off by default; set IDEAS_ENABLED=true to show the Ideas page and its settings. */
export function isIdeasEnabled(): boolean {
  const raw = process.env.IDEAS_ENABLED;
  if (!raw?.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

