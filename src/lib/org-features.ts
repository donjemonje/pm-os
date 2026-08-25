import { getCurrentUser } from "./auth";
import { isIdeasEnabled, resolveFeature } from "./feature-flags";

/**
 * Ideas gate for the signed-in user's organization: the org's `features`
 * override wins when set; otherwise the IDEAS_ENABLED env default applies.
 * Logged-out (or org-less) users get the env default.
 */
export async function ideasEnabledForCurrentUser(): Promise<boolean> {
  const user = await getCurrentUser();
  return resolveFeature(user?.organizationFeatures, "ideas", isIdeasEnabled());
}
