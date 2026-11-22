/** Story 6 (competitors) — closeness ranking in the summary strip. Pure module. */
import { describe, expect, it } from "vitest";
import { closenessOf, proximityPicks, rankByCloseness } from "@/lib/competitors/closeness";
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
