import type { NextResponse } from "next/server";
import { orgFeatureDisabledResponse } from "../api-auth";
import { featureEnabledForCurrentUser } from "../org-features";
import { PART_FLAGS, type CompetitorsParts } from "./parts";

/** Which switched parts of the Competitors page are on for the signed-in user's organization (the page passes this to the view). */
export async function competitorsPartsForCurrentUser(): Promise<CompetitorsParts> {
  const [profiles, cards, roadmap] = await Promise.all([featureEnabledForCurrentUser(PART_FLAGS.profiles), featureEnabledForCurrentUser(PART_FLAGS.cards), featureEnabledForCurrentUser(PART_FLAGS.roadmap)]);
  return { profiles, cards, roadmap };
}

/** For an API route that serves one part only: a 404 when that part is off for the caller's organization, null when on. Call it after competitorsGuard(). */
export async function competitorsPartOff(part: keyof CompetitorsParts): Promise<NextResponse | null> {
  return orgFeatureDisabledResponse(PART_FLAGS[part]);
}
