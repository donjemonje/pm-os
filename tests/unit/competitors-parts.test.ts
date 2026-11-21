import { afterEach, describe, expect, it } from "vitest";
import { envFeatureDefault, isOrgFeatureKey, ORG_FEATURE_KEYS, resolveFeature } from "@/lib/feature-flags";
import { FLAG_AREAS } from "@/lib/flag-catalog";

/**
 * The Profiles, Battle cards and Roadmap tabs of the Competitors page each have a switch of their own, off by
 * default (Daniel 2026-11-21, for production).
 */
const PARTS = [
  ["competitorsProfiles", "COMPETITORS_PROFILES_ENABLED"],
  ["competitorsBattleCards", "COMPETITORS_BATTLE_CARDS_ENABLED"],
  ["competitorsRoadmap", "COMPETITORS_ROADMAP_ENABLED"],
] as const;

describe("the switches of the Competitors page's parts", () => {
  afterEach(() => { for (const [, env] of PARTS) delete process.env[env]; delete process.env.COMPETITORS_ENABLED; });

  it("are per-organization flags the admin API accepts", () => {
    for (const [key] of PARTS) { expect(isOrgFeatureKey(key)).toBe(true); expect(ORG_FEATURE_KEYS).toContain(key); }
  });

  it("are off when their variable is unset — also when the Competitors page itself is on", () => {
    process.env.COMPETITORS_ENABLED = "true";
    for (const [key] of PARTS) expect(envFeatureDefault(key)).toBe(false);
  });

  it("follow their own variable, each apart from the others", () => {
    process.env.COMPETITORS_ROADMAP_ENABLED = "true";
    expect(envFeatureDefault("competitorsRoadmap")).toBe(true);
    expect(envFeatureDefault("competitorsProfiles")).toBe(false);
    expect(envFeatureDefault("competitorsBattleCards")).toBe(false);
  });

  it("are turned on for one organization by its override, and stay off for an organization that only has Competitors on", () => {
    expect(resolveFeature({ competitors: true, competitorsProfiles: true }, "competitorsProfiles", false)).toBe(true);
    expect(resolveFeature({ competitors: true }, "competitorsProfiles", false)).toBe(false);
    expect(resolveFeature({ competitors: true }, "competitorsBattleCards", false)).toBe(false);
    expect(resolveFeature({ competitors: true }, "competitorsRoadmap", false)).toBe(false);
  });

  it("are listed in Admin → Enablements under Competitors, and every listed switch is a real flag", () => {
    const area = FLAG_AREAS.find((a) => a.key === "competitors")!;
    expect(area.flags.map((f) => f.key)).toEqual(["competitors", "competitorsProfiles", "competitorsBattleCards", "competitorsRoadmap"]);
    for (const a of FLAG_AREAS) for (const f of a.flags) expect(isOrgFeatureKey(f.key)).toBe(true);
    expect(new Set(FLAG_AREAS.flatMap((a) => a.flags.map((f) => f.key)))).toEqual(new Set(ORG_FEATURE_KEYS));
  });
});
