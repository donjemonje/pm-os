/**
 * Catalog of every switch shown in PM-OS Admin → Enablements, grouped by
 * product area. Pure data (safe for client components). The keys must match
 * SYSTEM_FLAG_KEYS / ORG_FEATURE_KEYS in feature-flags.ts — the admin APIs
 * validate against those.
 *
 * scope "system" = one value for the whole install (resolves before
 * sign-in); scope "org" = per-organization override with an env default.
 */

export type FlagScope = "system" | "org";

export type FlagDef = {
  key: string;
  scope: FlagScope;
  label: string;
  description: string;
};

export type FlagArea = {
  key: string;
  label: string;
  flags: FlagDef[];
};

export const FLAG_AREAS: readonly FlagArea[] = [
  {
    key: "login",
    label: "Login",
    flags: [
      {
        key: "googleSso",
        scope: "org",
        label: "Google SSO",
        description:
          "Members of this org may sign in with Google, and invites offer Google sign-up. Enforced once Google returns the email; the /login button shows whenever Google is configured.",
      },
      {
        key: "selfSignup",
        scope: "system",
        label: "Self-service sign-up",
        description:
          "Lets visitors create their own account and organization via /register (and first-time Google sign-in). Off = only users added in Admin can sign in.",
      },
      {
        key: "ssoSkips2fa",
        scope: "org",
        label: "Google SSO skips 2FA",
        description:
          "Members who sign in with Google land in the app without the TOTP challenge or enrollment. Password sign-ins still require 2FA.",
      },
    ],
  },
  {
    key: "ideas",
    label: "Ideas",
    flags: [
      {
        key: "ideas",
        scope: "org",
        label: "Ideas",
        description: "Ideas pipeline: page, settings, and import APIs.",
      },
      {
        key: "ideasUndo",
        scope: "org",
        label: "Ideas undo",
        description:
          "Per-idea undo of the last Jira merge — restores fields (only if unedited since), deletes created issues. Demo affordance.",
      },
    ],
  },
  {
    key: "docs",
    label: "Docs",
    flags: [
      {
        key: "docs",
        scope: "org",
        label: "Docs",
        description:
          "Documents: pages, editor, generation APIs, dashboard cards.",
      },
    ],
  },
  {
    key: "chat",
    label: "Chat",
    flags: [
      {
        key: "chat",
        scope: "org",
        label: "Chat",
        description: "PMOS Chat: page, floating panel, and chat APIs.",
      },
    ],
  },
  {
    key: "dashboard",
    label: "Dashboard",
    flags: [
      {
        key: "dashboard",
        scope: "org",
        label: "Dashboard",
        description:
          "Dashboard landing page; when off, /dashboard redirects to Releases.",
      },
    ],
  },
];
