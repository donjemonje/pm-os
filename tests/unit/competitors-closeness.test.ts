/** Story 6 (competitors) — closeness ranking in the summary strip. Pure module. */
import { describe, expect, it } from "vitest";
import { closenessOf, rankByCloseness } from "@/lib/competitors/closeness";
import type { StatusValue } from "@/lib/competitors/config";

describe("closenessOf", () => {
  it("counts has in full and partial as half", () => {
    const values: Record<string, StatusValue> = { a: "has", b: "partial", c: "missing", d: "unknown" };
    expect(closenessOf(["a", "b", "c", "d"], (id) => values[id])).toEqual({ score: 38, has: 1, partial: 1, total: 4 });
  });
  it("is null with no capabilities", () => {
    expect(closenessOf([], () => undefined).score).toBeNull();
  });
});

describe("rankByCloseness", () => {
  it("orders closest first and keeps column order on ties", () => {
    const cells: Record<string, Record<string, StatusValue>> = { x: { a: "partial" }, y: { a: "has", b: "has" }, z: { a: "partial" } };
    const ranked = rankByCloseness([{ id: "x" }, { id: "y" }, { id: "z" }], ["a", "b"], (c, k) => cells[c]?.[k]);
    expect(ranked.map((r) => r.competitor.id)).toEqual(["y", "x", "z"]);
    expect(ranked[0].closeness.score).toBe(100);
  });
});
