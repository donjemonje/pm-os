/**
 * The parts of the Competitors page that have a switch of their own (feature-flags.ts): off by default, turned on
 * per organization in Admin → Enablements. The parity matrix and the news feed are the page itself and have none.
 * Pure data — safe for client components. The server side (who has what on) is parts-server.ts.
 */
export interface CompetitorsParts {
  profiles: boolean;
  cards: boolean;
  roadmap: boolean;
}

export const NO_PARTS: CompetitorsParts = { profiles: false, cards: false, roadmap: false };

/** The per-organization flag behind each part. */
export const PART_FLAGS = { profiles: "competitorsProfiles", cards: "competitorsBattleCards", roadmap: "competitorsRoadmap" } as const;
