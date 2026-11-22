/** Story 6 (competitors) — closeness ranking in the summary strip. Pure module. */
import { describe, expect, it } from "vitest";
import { closenessOf, PROXIMITY_SHOWN, proximityPicks, rankByCloseness } from "@/lib/competitors/closeness";
import type { StatusValue } from "@/lib/competitors/config";

describe("closenessOf", () => {
  it("counts found in full and low confidence as half; no cell counts as nothing", () => {
    const values: Record<string, StatusValue> = { a: "found", b: "low", c: "not_found" };
    expect(closenessOf(["a", "b", "c", "d"], (id) => values[id])).toEqual({ score: 38, found: 1, low: 1, total: 4 });
  });
  it("is null with no capabilities", () => {
    expect(closenessOf([], () => undefined).score).toBeNull();
  });
});

describe("rankByCloseness", () => {
  it("orders closest first and keeps column order on ties", () => {
    const cells: Record<string, Record<string, StatusValue>> = { x: { a: "low" }, y: { a: "found", b: "found" }, z: { a: "low" } };
    const ranked = rankByCloseness([{ id: "x" }, { id: "y" }, { id: "z" }], ["a", "b"], (c, k) => cells[c]?.[k]);
    expect(ranked.map((r) => r.competitor.id)).toEqual(["y", "x", "z"]);
    expect(ranked[0].closeness.score).toBe(100);
  });
});

describe("proximityPicks — the Offering Proximity card shows at most six", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => i);
  it("shows everyone when there are six or fewer", () => {
    expect(proximityPicks(list(0))).toEqual([]);
    expect(proximityPicks(list(4))).toEqual([0, 1, 2, 3]);
    expect(proximityPicks(list(6))).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("with more: the two closest, the two in the middle, the two farthest, in ranking order", () => {
    expect(proximityPicks(list(7))).toEqual([0, 1, 2, 3, 5, 6]);
    expect(proximityPicks(list(8))).toEqual([0, 1, 3, 4, 6, 7]);
    expect(proximityPicks(list(15))).toEqual([0, 1, 6, 7, 13, 14]);
  });
});

describe("closeness from scores (the coverage model)", () => {
  it("is the average score on the 0-100 scale when the capabilities are scored", () => {
    const scores: Record<string, Record<string, number>> = { x: { a: 5, b: 0 }, y: { a: 2, b: 2 } };
    const values: Record<string, Record<string, StatusValue>> = { x: { a: "found", b: "not_found" }, y: { a: "found", b: "found" } };
    const ranked = rankByCloseness([{ id: "y" }, { id: "x" }], ["a", "b"], (c, k) => values[c]?.[k], (c, k) => scores[c]?.[k]);
    expect(ranked.map((r) => [r.competitor.id, r.closeness.score])).toEqual([["x", 50], ["y", 40]]);
    expect(ranked[0].closeness.found).toBe(1);
  });
  it("falls back to the share found when nothing is scored", () => {
    expect(closenessOf(["a", "b"], (k) => (k === "a" ? "found" : "not_found"), () => null).score).toBe(50);
  });
});

describe("Offering Proximity leaves out a company that is not analysed yet", () => {
  const caps = ["a", "b", "c"];
  it("the coverage model: a company with no score on any capability is neither ranked nor shown", () => {
    // Seven companies, one of them with pages stored and no analysis (no cell at all): it must not take a "farthest" place.
    const scores: Record<string, number[]> = { zf: [5, 3, 1], rf: [4, 3, 1], bs: [4, 2, 1], i4: [3, 2, 1], fp: [3, 2, 0], sc: [1, 1, 1] };
    const companies = ["rf", "fp", "i4", "sc", "zf", "bs", "new"].map((id) => ({ id }));
    const ranked = rankByCloseness(companies, caps, (c, k) => (scores[c] ? (scores[c][caps.indexOf(k)] > 0 ? "found" : "not_found") : undefined), (c, k) => scores[c]?.[caps.indexOf(k)]);
    expect(ranked.map((r) => r.competitor.id)).toEqual(["zf", "rf", "bs", "i4", "fp", "sc"]);
    // Six analysed companies: all of them show, the unanalysed one does not.
    expect(ranked).toHaveLength(PROXIMITY_SHOWN);
    expect(proximityPicks(ranked).map((r) => r.competitor.id)).toEqual(["zf", "rf", "bs", "i4", "fp", "sc"]);
  });
  it("a company whose cells are of the earlier model (no score) is left out of a scored table too", () => {
    const ranked = rankByCloseness([{ id: "x" }, { id: "old" }], ["a"], (c) => "found", (c) => (c === "x" ? 3 : null));
    expect(ranked.map((r) => r.competitor.id)).toEqual(["x"]);
  });
  it("a table without scores: a company with no cell is left out", () => {
    const cells: Record<string, Record<string, StatusValue>> = { x: { a: "found" }, y: { a: "not_found" } };
    const ranked = rankByCloseness([{ id: "x" }, { id: "y" }, { id: "new" }], ["a", "b"], (c, k) => cells[c]?.[k]);
    expect(ranked.map((r) => r.competitor.id)).toEqual(["x", "y"]);
  });
  it("nobody analysed at all: every company stays", () => {
    expect(rankByCloseness([{ id: "x" }, { id: "y" }], ["a"], () => undefined).map((r) => r.competitor.id)).toEqual(["x", "y"]);
  });
});

