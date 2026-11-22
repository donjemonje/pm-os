/** Competitors — a company's relevance level per user (1 = most relevant). Pure module. */
import { describe, expect, it } from "vitest";
import { parseRelevance, RELEVANCE_LEVELS } from "@/lib/competitors/relevance";

describe("parseRelevance", () => {
  it("takes the three levels", () => {
    expect(RELEVANCE_LEVELS).toEqual([1, 2, 3]);
    expect([1, 2, 3].map(parseRelevance)).toEqual([1, 2, 3]);
  });
  it("null clears the level", () => {
    expect(parseRelevance(null)).toBeNull();
  });
  it("anything else is refused", () => {
    for (const v of [0, 4, 1.5, "1", undefined, {}, true]) expect(parseRelevance(v)).toBeUndefined();
  });
});
