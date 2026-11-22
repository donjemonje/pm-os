/** Competitors — the companies' order after a column is dragged in the table. Pure module. */
import { describe, expect, it } from "vitest";
import { isSameSet, moveNextTo } from "@/lib/competitors/order";

describe("moveNextTo", () => {
  const ids = ["a", "b", "c", "d"];
  it("puts the dragged company just before or just after the one it was dropped on", () => {
    expect(moveNextTo(ids, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(moveNextTo(ids, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveNextTo(ids, "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
    expect(moveNextTo(ids, "c", "b", "before")).toEqual(["a", "c", "b", "d"]);
  });
  it("changes nothing when dropped on itself, on its own edge, or with an unknown id", () => {
    expect(moveNextTo(ids, "b", "b", "after")).toEqual(ids);
    expect(moveNextTo(ids, "b", "c", "before")).toEqual(ids);
    expect(moveNextTo(ids, "b", "a", "after")).toEqual(ids);
    expect(moveNextTo(ids, "x", "a", "before")).toEqual(ids);
    expect(moveNextTo(ids, "a", "x", "before")).toEqual(ids);
  });
});

describe("isSameSet — the only list an order is saved from", () => {
  it("takes the same ids in any order", () => {
    expect(isSameSet(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
    expect(isSameSet([], [])).toBe(true);
  });
  it("refuses a missing, an extra, a repeated or a non-text id, and anything that is not a list", () => {
    expect(isSameSet(["a", "b"], ["a"])).toBe(false);
    expect(isSameSet(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(isSameSet(["a", "b"], ["a", "a"])).toBe(false);
    expect(isSameSet(["a", "b"], ["a", 2])).toBe(false);
    expect(isSameSet(["a"], "a")).toBe(false);
    expect(isSameSet(["a"], undefined)).toBe(false);
  });
});
