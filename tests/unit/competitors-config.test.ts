/**
 * Story 2 (competitors) — workspace config merge and time helpers. Pure modules.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PAGES, frequencyMs, mergeCompetitorsConfig } from "@/lib/competitors/config";
import { shortDate, timeAgo, timeUntil } from "@/lib/competitors/time";

describe("mergeCompetitorsConfig", () => {
  it("fills defaults (weekly, 50 pages) and clamps the page limit", () => {
    expect(mergeCompetitorsConfig(null)).toEqual({ scanFrequency: "weekly", maxPagesPerScan: DEFAULT_MAX_PAGES });
    expect(mergeCompetitorsConfig({ scanFrequency: "daily", maxPagesPerScan: 2 })).toEqual({ scanFrequency: "daily", maxPagesPerScan: 5 });
    expect(mergeCompetitorsConfig({ scanFrequency: "hourly", maxPagesPerScan: 10_000 })).toEqual({ scanFrequency: "weekly", maxPagesPerScan: 500 });
    expect(mergeCompetitorsConfig("junk")).toEqual({ scanFrequency: "weekly", maxPagesPerScan: DEFAULT_MAX_PAGES });
  });
  it("turns a frequency into its interval", () => {
    expect(frequencyMs("daily")).toBe(86_400_000);
    expect(frequencyMs("weekly")).toBe(7 * 86_400_000);
    expect(frequencyMs("monthly")).toBe(30 * 86_400_000);
  });
});

describe("time helpers", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  it("timeAgo", () => {
    expect(timeAgo("2026-10-25T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-10-25T11:45:00Z", now)).toBe("15 min ago");
    expect(timeAgo("2026-10-25T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-10-24T11:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-10-20T12:00:00Z", now)).toBe("5 days ago");
    expect(timeAgo("2026-09-01T12:00:00Z", now)).toBe("Sep 1");
    expect(timeAgo(null, now)).toBe("");
  });
  it("shortDate adds the year only when it differs", () => {
    expect(shortDate("2026-10-21T00:00:00Z", now)).toMatch(/Oct 2[01]/);
    expect(shortDate("2025-10-21T00:00:00Z", now)).toMatch(/2025/);
  });
  it("timeUntil", () => {
    expect(timeUntil("2026-10-25T11:00:00Z", now)).toBe("on the next run");
    expect(timeUntil("2026-10-25T17:00:00Z", now)).toBe("in 5 h");
    expect(timeUntil("2026-10-28T12:00:00Z", now)).toBe("in 3 days");
  });
});

describe("domain name mentions (rename cascade)", () => {
  it("matches whole names only, including ones with parentheses and ampersands, and rewrites them", async () => {
    const { mentionsName, renameMentions } = await import("@/lib/competitors/mentions");
    const text = "Not here: exposed credentials belong to Exposure & response; see also Cyber Threat Intelligence (CTI) and CTI feeds.";
    expect(mentionsName(text, "Exposure & response")).toBe(true);
    expect(mentionsName(text, "Cyber Threat Intelligence (CTI)")).toBe(true);
    expect(mentionsName(text, "Exposure")).toBe(true);
    expect(mentionsName(text, "response; see")).toBe(true);
    expect(mentionsName(text, "Threat Intelligence (CT")).toBe(false); // partial word
    expect(mentionsName(text, "Response")).toBe(false); // case-sensitive proper noun
    expect(renameMentions(text, "Cyber Threat Intelligence (CTI)", "Threat Intelligence")).toBe(
      "Not here: exposed credentials belong to Exposure & response; see also Threat Intelligence and CTI feeds.",
    );
    expect(renameMentions("", "a", "b")).toBe("");
  });
});
