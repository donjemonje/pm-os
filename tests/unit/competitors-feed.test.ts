/** The news feed's pure parts: the date an item is about, and the order of the items. (The feed holds new abilities only since 2026-11-22: the status-move, fact and suggestion items and their helpers are gone.) */
import { describe, expect, it } from "vitest";
import { compareFeed, newsDate } from "@/lib/competitors/feed";

describe("newsDate", () => {
  it("is the date the page states when it states one, else the time the item was found", () => {
    expect(newsDate({ at: "2026-11-22T10:00:00Z", publishedAt: "2026-11-18T00:00:00Z" })).toBe("2026-11-18T00:00:00Z");
    expect(newsDate({ at: "2026-11-22T10:00:00Z", publishedAt: null })).toBe("2026-11-22T10:00:00Z");
  });
});

describe("compareFeed", () => {
  it("orders high impact first, then newest by the item's own date, then by the time it was found", () => {
    const rows = [
      { key: "lowOld", impact: "Low" as const, at: "2026-10-29T11:36:00Z", publishedAt: "2026-07-28T00:00:00Z" },
      { key: "high", impact: "High" as const, at: "2026-10-29T11:36:00Z", publishedAt: null },
      { key: "lowNew", impact: "Low" as const, at: "2026-10-29T11:36:00Z", publishedAt: "2026-10-20T00:00:00Z" },
      { key: "medium", impact: "Medium" as const, at: "2026-10-28T09:00:00Z", publishedAt: null },
      { key: "lowFoundLater", impact: "Low" as const, at: "2026-10-29T12:00:00Z", publishedAt: null },
    ];
    expect([...rows].sort(compareFeed).map((r) => r.key)).toEqual(["high", "medium", "lowFoundLater", "lowNew", "lowOld"]);
  });
  it("new abilities, all of one impact, read newest first by the page's date", () => {
    const rows = [
      { key: "foundTodayDatedOld", impact: "High" as const, at: "2026-11-22T10:00:00Z", publishedAt: "2026-11-17T00:00:00Z" },
      { key: "datedNew", impact: "High" as const, at: "2026-11-22T09:00:00Z", publishedAt: "2026-11-21T00:00:00Z" },
    ];
    expect([...rows].sort(compareFeed).map((r) => r.key)).toEqual(["datedNew", "foundTodayDatedOld"]);
  });
});
