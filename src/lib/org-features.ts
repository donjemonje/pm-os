import { getCurrentUser } from "./auth";
import {
  envFeatureDefault,
  OrgFeatureKey,
  resolveFeature,
} from "./feature-flags";

/**
 * Flag resolution for the signed-in user's organization: the org's
 * `features` override wins when set; otherwise the env default applies.
 * Logged-out (or org-less) users get the env default.
 */
export async function featureEnabledForCurrentUser(
  key: OrgFeatureKey
): Promise<boolean> {
  const user = await getCurrentUser();
  return resolveFeature(user?.organizationFeatures, key, envFeatureDefault(key));
}

export async function ideasEnabledForCurrentUser(): Promise<boolean> {
  return featureEnabledForCurrentUser("ideas");
}
