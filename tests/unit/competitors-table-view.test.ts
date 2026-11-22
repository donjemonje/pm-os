/** Competitors — how the table opens and marks its cells: the default open state, close all / open all, the winners of a row, the colour step of a score's number, scrolling inside an open card. Pure module. */
import { describe, expect, it } from "vitest";
import { allOpen, boxCanScroll, defaultOpenDomains, featureIsDifferentiator, placeCard, rowKindCounts, SCORE_COLORS, scoreColor, scoreStep, toggleAll, topScoreKeys } from "@/lib/competitors/table-view";
import { scoreRowKind } from "@/lib/competitors/scores";

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

describe("rowKindCounts — a domain's header: its gaps and what only the organization has", () => {
  it("counts each kind", () => {
    expect(rowKindCounts(["gap", "only", "level", "only", "none"])).toEqual({ gaps: 1, only: 2 });
    expect(rowKindCounts([])).toEqual({ gaps: 0, only: 0 });
  });
  it("with scored rows: only = our score above 0 and every competitor at 0; gap = ours 0 and a competitor above 0", () => {
    const rows: Array<[number, number[]]> = [[3, [0, 0]], [0, [2, 0]], [4, [1, 0]], [1, [0, 0, 0]], [0, [0, 0]]];
    expect(rowKindCounts(rows.map(([own, theirs]) => scoreRowKind(own, theirs) ?? "none"))).toEqual({ gaps: 1, only: 2 });
  });
});

describe("placeCard — where a floating card opens", () => {
  const win = { width: 1200, height: 800 };
  const anchorAt = (top: number) => ({ top, bottom: top + 36, left: 500, width: 64 });
  it("below its anchor when the whole card fits there", () => {
    const p = placeCard(anchorAt(100), { width: 320, height: 200 }, win, "center");
    expect(p.side).toBe("below");
    expect(p.top).toBe(142); // anchor's bottom + the gap
    expect(p.left).toBe(372); // centred on the anchor
    expect(p.maxHeight).toBe(650); // the room below
  });
  it("above when it does not fit below but fits above — near the bottom of the window", () => {
    const p = placeCard(anchorAt(700), { width: 320, height: 200 }, win, "center");
    expect(p.side).toBe("above");
    expect(p.top).toBe(494); // its bottom edge sits a gap above the anchor: 700 - 6 - 200
    expect(p.top + 200).toBeLessThanOrEqual(700);
  });
  it("fits neither side, more room above: above, capped to that room", () => {
    const p = placeCard(anchorAt(520), { width: 320, height: 700 }, win);
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(506); // 520 - 6 - 8
    expect(p.top).toBe(8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(520);
  });
  it("fits neither side, more room below: below, capped to that room", () => {
    const p = placeCard(anchorAt(250), { width: 320, height: 700 }, win);
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(500); // 800 - 8 - (286 + 6)
    expect(p.top).toBe(292);
  });
  it("a card that grows after opening moves above when it no longer fits below", () => {
    const anchor = anchorAt(480);
    const first = placeCard(anchor, { width: 340, height: 180 }, win, "center");
    expect(first.side).toBe("below");
    const grown = placeCard(anchor, { width: 340, height: 420 }, win, "center"); // "Show more evidence" opened
    expect(grown.side).toBe("above");
    expect(grown.top).toBe(54); // 480 - 6 - 420
  });
  it("the bottom is the bottom of the window, wherever the page is scrolled: the same anchor place gives the same card place", () => {
    expect(placeCard(anchorAt(740), { width: 320, height: 120 }, win)).toEqual({ top: 614, left: 500, maxHeight: 726, side: "above" });
  });
  it("stays inside the window sideways", () => {
    expect(placeCard({ top: 100, bottom: 136, left: 1150, width: 40 }, { width: 320, height: 100 }, win, "center").left).toBe(872);
    expect(placeCard({ top: 100, bottom: 136, left: 2, width: 20 }, { width: 320, height: 100 }, win, "center").left).toBe(8);
  });
});

describe("featureIsDifferentiator — a feature only the organization has", () => {
  it("our mark is found and no competitor's is", () => {
    expect(featureIsDifferentiator("found", ["not_found", "not_found"])).toBe(true);
    expect(featureIsDifferentiator("found", ["not_found", undefined, null])).toBe(true); // a competitor with no cell has not got it
  });
  it("not when a competitor has it, also with low confidence", () => {
    expect(featureIsDifferentiator("found", ["not_found", "found"])).toBe(false);
    expect(featureIsDifferentiator("found", ["low", "not_found"])).toBe(false);
  });
  it("not when we do not have it, and never with no competitors", () => {
    expect(featureIsDifferentiator("not_found", ["not_found"])).toBe(false);
    expect(featureIsDifferentiator("found", [])).toBe(false);
  });
});

