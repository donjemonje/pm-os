/** Competitors — how the table opens and marks its cells: the default open state, close all / open all, the winners of a row, the colour step of a score's number, scrolling inside an open card. Pure module. */
import { describe, expect, it } from "vitest";
import { allOpen, boxCanScroll, defaultOpenDomains, SCORE_COLORS, scoreColor, scoreStep, toggleAll, topScoreKeys } from "@/lib/competitors/table-view";

describe("defaultOpenDomains", () => {
  it("only the first domain is open when the page loads", () => {
    expect(defaultOpenDomains(["d1", "d2", "d3"])).toEqual(["d1"]);
    expect(defaultOpenDomains([])).toEqual([]);
  });
});

describe("close all / open all", () => {
  it("opens all unless all are open, then closes all", () => {
    expect([...toggleAll(["a", "b"], new Set(["a"]))].sort()).toEqual(["a", "b"]);
    expect([...toggleAll(["a", "b"], new Set(["a", "b"]))]).toEqual([]);
    expect([...toggleAll(["a", "b"], new Set())].sort()).toEqual(["a", "b"]);
  });
  it("leaves the ids outside the list as they are", () => {
    expect([...toggleAll(["a", "b"], new Set(["a", "b", "z"]))]).toEqual(["z"]);
    expect([...toggleAll(["a"], new Set(["z"]))].sort()).toEqual(["a", "z"]);
  });
  it("allOpen is false for an empty list", () => {
    expect(allOpen([], new Set(["a"]))).toBe(false);
    expect(allOpen(["a"], new Set(["a"]))).toBe(true);
  });
});

describe("topScoreKeys — the winners of a row (their numbers are underlined)", () => {
  it("the highest score among the companies shown, the organization included", () => {
    expect([...topScoreKeys([{ key: "own", score: 3 }, { key: "c1", score: 5 }, { key: "c2", score: 2 }])]).toEqual(["c1"]);
    expect([...topScoreKeys([{ key: "own", score: 4 }, { key: "c1", score: 1 }])]).toEqual(["own"]);
  });
  it("works the same for a domain's header row: averages with a decimal", () => {
    expect([...topScoreKeys([{ key: "own", score: 3.6 }, { key: "c1", score: 4.2 }, { key: "c2", score: 4.2 }, { key: "c3", score: null }])].sort()).toEqual(["c1", "c2"]);
  });
  it("ties are all top", () => {
    expect([...topScoreKeys([{ key: "own", score: 4 }, { key: "c1", score: 4 }, { key: "c2", score: 0 }])].sort()).toEqual(["c1", "own"]);
  });
  it("a top of 0 marks nothing; a cell with no score is never top", () => {
    expect([...topScoreKeys([{ key: "own", score: 0 }, { key: "c1", score: 0 }])]).toEqual([]);
    expect([...topScoreKeys([{ key: "own", score: null }, { key: "c1", score: undefined }])]).toEqual([]);
    expect([...topScoreKeys([{ key: "own", score: null }, { key: "c1", score: 2 }])]).toEqual(["c1"]);
  });
});

describe("the score's colour", () => {
  it("six steps from gray (0) to green (5)", () => {
    expect(SCORE_COLORS).toHaveLength(6);
    expect(scoreColor(0)).toBe(SCORE_COLORS[0]);
    expect(scoreColor(5)).toBe(SCORE_COLORS[5]);
    expect(new Set(SCORE_COLORS).size).toBe(6);
  });
  it("a domain's average takes its nearest step; nothing is outside 0-5", () => {
    expect([2.4, 2.5, 3.8, -1, 9].map(scoreStep)).toEqual([2, 3, 4, 0, 5]);
  });
});

describe("boxCanScroll — scrolling inside an open card", () => {
  const box = (scrollTop: number) => ({ scrollTop, clientHeight: 100, scrollHeight: 300 });
  it("a box that is not longer than its frame never scrolls", () => {
    expect(boxCanScroll({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 }, 10)).toBe(false);
  });
  it("moves until its end, in each direction", () => {
    expect(boxCanScroll(box(0), 10)).toBe(true);
    expect(boxCanScroll(box(0), -10)).toBe(false);
    expect(boxCanScroll(box(200), 10)).toBe(false);
    expect(boxCanScroll(box(200), -10)).toBe(true);
    expect(boxCanScroll(box(120), 10)).toBe(true);
  });
});
