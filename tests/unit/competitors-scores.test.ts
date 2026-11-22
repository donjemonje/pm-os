/** Competitors — the coverage model: scores 0-5, the domain average, the gap rule, proximity, the evidence list. Pure module. */
import { describe, expect, it } from "vitest";
import { domainScore, parseScore, proximityOfScores, readEvidenceList, scoreAgreesWithFeatures, scoreRowKind, valueOfScore } from "@/lib/competitors/scores";

describe("parseScore", () => {
  it("takes whole numbers 0 to 5 only", () => {
    expect([0, 1, 5].map(parseScore)).toEqual([0, 1, 5]);
    for (const v of [-1, 6, 2.5, "3", null, undefined, NaN]) expect(parseScore(v)).toBeUndefined();
  });
});

describe("valueOfScore", () => {
  it("0 is not found, anything above is found", () => {
    expect(valueOfScore(0)).toBe("not_found");
    expect([1, 3, 5].map(valueOfScore)).toEqual(["found", "found", "found"]);
  });
});

describe("domainScore — the average of a company's capability scores", () => {
  it("averages to one decimal; a capability it does not cover counts 0", () => {
    expect(domainScore([4, 4, 4, 4, 3])).toBe(3.8);
    expect(domainScore([5, 0, 0])).toBe(1.7);
    expect(domainScore([0, 0])).toBe(0);
  });
  it("leaves out rows with no score; null when none is scored", () => {
    expect(domainScore([4, null, undefined, 2])).toBe(3);
    expect(domainScore([null, undefined])).toBeNull();
    expect(domainScore([])).toBeNull();
  });
});

describe("scoreRowKind — gap, only, level", () => {
  it("gap: our score is 0 and a competitor is above 0", () => {
    expect(scoreRowKind(0, [0, 2, null])).toBe("gap");
  });
  it("only: we are above 0 and no competitor is", () => {
    expect(scoreRowKind(3, [0, 0, null])).toBe("only");
  });
  it("level otherwise; none with no competitors; null when our score is missing", () => {
    expect(scoreRowKind(3, [1, 0])).toBe("level");
    expect(scoreRowKind(0, [0, 0])).toBe("level");
    expect(scoreRowKind(2, [])).toBe("none");
    expect(scoreRowKind(null, [5])).toBeNull();
    expect(scoreRowKind(undefined, [5])).toBeNull();
  });
});

describe("proximityOfScores — Offering Proximity from scores", () => {
  it("is the average score on a 0-100 scale", () => {
    expect(proximityOfScores([5, 5])).toBe(100);
    expect(proximityOfScores([5, 0, 2, null])).toBe(47);
    expect(proximityOfScores([0])).toBe(0);
    expect(proximityOfScores([null])).toBeNull();
  });
});

describe("scoreAgreesWithFeatures", () => {
  it("one main feature of four or more cannot be 5", () => {
    expect(scoreAgreesWithFeatures(5, 1, 5)).toBe(false);
    expect(scoreAgreesWithFeatures(5, 2, 5)).toBe(true);
    expect(scoreAgreesWithFeatures(5, 1, 3)).toBe(true);
  });
  it("all main features of three or more cannot be 1; 0 means none", () => {
    expect(scoreAgreesWithFeatures(1, 4, 4)).toBe(false);
    expect(scoreAgreesWithFeatures(1, 2, 2)).toBe(true);
    expect(scoreAgreesWithFeatures(0, 1, 4)).toBe(false);
    expect(scoreAgreesWithFeatures(0, 0, 4)).toBe(true);
  });
});

describe("readEvidenceList", () => {
  it("keeps the order and drops what is not evidence", () => {
    expect(readEvidenceList([{ quote: "a", url: "https://x.test/1", pageKind: "help center", strength: "explains", checked: true }, { quote: "" }, null, { quote: "b" }])).toEqual([
      { quote: "a", url: "https://x.test/1", pageKind: "help center", strength: "explains", checked: true },
      { quote: "b", url: null, pageKind: "", strength: "", checked: false },
    ]);
    expect(readEvidenceList(null)).toEqual([]);
    expect(readEvidenceList({})).toEqual([]);
  });
});
