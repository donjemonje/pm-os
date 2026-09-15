import { featureEnabledForCurrentUser } from "./org-features";
import type { OrgFeatureKey } from "./feature-flags";

/**
 * Post-login landing page = the first surface that is ON for the caller's
 * organization, in the sidebar's menu order. Settings is always on, so there
 * is always a landing. Every "go to the app" path (login, 2FA, invite,
 * set-password, logo, admin "back to app", stale bookmarks on /dashboard)
 * resolves through "/" → this.
 */
const MENU_ORDER: { href: string; flag: OrgFeatureKey | null }[] = [
  { href: "/dashboard", flag: "dashboard" },
  { href: "/ideas", flag: "ideas" },
  { href: "/docs", flag: "docs" },
  { href: "/chat", flag: "chat" },
  { href: "/settings/jira", flag: null },
];

export async function landingPathForCurrentUser(): Promise<string> {
  for (const item of MENU_ORDER) {
    if (item.flag === null) return item.href;
    if (await featureEnabledForCurrentUser(item.flag)) return item.href;
  }
  return "/settings/jira";
}
