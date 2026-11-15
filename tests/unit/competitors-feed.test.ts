/** Story 3 (competitors) — the news feed's pure parts: how a status move reads, and its impact. */
import { describe, expect, it } from "vitest";
import { compareFeed, impactOf, sourceTypeForUrl, statusKind } from "@/lib/competitors/feed";

describe("statusKind", () => {
  it("gap when the org lacks it, raised when it has it too, lowered on a drop, nothing on a tie", () => {
    expect(statusKind("missing", "has", "missing")).toBe("gap");
    expect(statusKind("partial", "has", "partial")).toBe("raised");
    expect(statusKind("has", "partial", "has")).toBe("lowered");
    expect(statusKind("has", "has", "missing")).toBeNull();
  });
});

describe("impactOf", () => {
  it("gap is High, status moves Medium, facts and suggestions Low", () => {
    expect(impactOf("gap")).toBe("High");
    expect(impactOf("raised")).toBe("Medium");
    expect(impactOf("lowered")).toBe("Medium");
    expect(impactOf("fact")).toBe("Low");
    expect(impactOf("suggestion")).toBe("Low");
  });
});

describe("compareFeed", () => {
  it("orders high impact first, then newest by the item's own date, then by scan time", () => {
    const rows = [
      { key: "lowOld", impact: "Low" as const, at: "2026-10-29T11:36:00Z", factDate: "2026-07-28T00:00:00Z" },
      { key: "high", impact: "High" as const, at: "2026-10-29T11:36:00Z", factDate: null },
      { key: "lowNew", impact: "Low" as const, at: "2026-10-29T11:36:00Z", factDate: "2026-10-20T00:00:00Z" },
      { key: "medium", impact: "Medium" as const, at: "2026-10-28T09:00:00Z", factDate: null },
      { key: "lowScanLater", impact: "Low" as const, at: "2026-10-29T12:00:00Z", factDate: null },
    ];
    expect([...rows].sort(compareFeed).map((r) => r.key)).toEqual(["high", "medium", "lowScanLater", "lowNew", "lowOld"]);
  });
});

describe("sourceTypeForUrl", () => {
  const sources = [
    { type: "website", url: "https://www.zerofox.com/" },
    { type: "blog", url: "https://www.zerofox.com/blog/" },
    { type: "press", url: "https://www.zerofox.com/news-and-press-releases/" },
  ];
  it("picks the source whose URL is the longest prefix, ignoring the website root", () => {
    expect(sourceTypeForUrl("https://www.zerofox.com/blog/some-post", sources)).toBe("blog");
    expect(sourceTypeForUrl("https://zerofox.com/news-and-press-releases/x", sources)).toBe("press");
  });
  it("falls back to a path hint, else null", () => {
    expect(sourceTypeForUrl("https://www.zerofox.com/press-release/zerofox-launches-hntr", sources)).toBe("press");
    expect(sourceTypeForUrl("https://docs.example.com/changelog/2026", [])).toBe("changelog");
    expect(sourceTypeForUrl("https://www.zerofox.com/platform/", sources)).toBeNull();
    expect(sourceTypeForUrl(null, sources)).toBeNull();
  });
});
