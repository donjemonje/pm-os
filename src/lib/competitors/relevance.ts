/**
 * A company's relevance level for one user (Daniel 2026-11-22): 1 = most relevant, 2, 3. Each user sets their own.
 * Pure: no database.
 */
export const RELEVANCE_LEVELS = [1, 2, 3] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];

/** What a request asks for: a level, null (clear the level), or undefined when the value is neither. */
export function parseRelevance(value: unknown): RelevanceLevel | null | undefined {
  if (value === null) return null;
  return RELEVANCE_LEVELS.find((l) => l === value);
}
