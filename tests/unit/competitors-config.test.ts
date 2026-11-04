/**
 * Competitors — workspace config merge and time helpers. Pure modules.
 * Since the Website Scanning PRD (2026-11-04) the scan frequency lives per
 * source and there is no page cap, so the config carries only the manual
 * rescan limit, the recipients and the news baseline; old keys are ignored.
 */
import { describe, expect, it } from "vitest";
import { CEILING_MS, CEILING_PAGES, DEFAULT_SCAN_EVERY_DAYS, mergeCompetitorsConfig, splitSuggestedQuote, STALE_MS } from "@/lib/competitors/config";
import { shortDate, timeAgo, timeUntil } from "@/lib/competitors/time";

describe("mergeCompetitorsConfig", () => {
  it("fills defaults and ignores the retired per-org frequency and page cap", () => {
    expect(mergeCompetitorsConfig(null)).toEqual({ manualRescansPerDay: 1, notifyUserIds: [], baselineUntil: null });
    expect(mergeCompetitorsConfig({ scanFrequency: "daily", maxPagesPerScan: 2 })).toEqual({ manualRescansPerDay: 1, notifyUserIds: [], baselineUntil: null });
    expect(mergeCompetitorsConfig("junk")).toEqual({ manualRescansPerDay: 1, notifyUserIds: [], baselineUntil: null });
    expect(mergeCompetitorsConfig({ notifyUserIds: ["u1", "u1", 7, "u2"] }).notifyUserIds).toEqual(["u1", "u2"]);
    expect(mergeCompetitorsConfig({ baselineUntil: "2026-11-01T00:00:00Z" }).baselineUntil).toBe("2026-11-01T00:00:00Z");
    expect(mergeCompetitorsConfig({ baselineUntil: "not a date" }).baselineUntil).toBeNull();
  });
  it("carries the PRD's numbers: every 2 days, 2,000 pages or 3 h ceiling, stale after 10 min", () => {
    expect(DEFAULT_SCAN_EVERY_DAYS).toBe(2);
    expect(CEILING_PAGES).toBe(2000);
    expect(CEILING_MS).toBe(3 * 3600_000);
    expect(STALE_MS).toBe(10 * 60_000);
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

describe("splitSuggestedQuote", () => {
  it("splits the quote from a trailing source URL", () => {
    expect(splitSuggestedQuote("Detects weapons in images — https://example.com/p")).toEqual({ quote: "Detects weapons in images", url: "https://example.com/p" });
  });
  it("keeps a quote without a URL and tolerates null", () => {
    expect(splitSuggestedQuote("Plain quote")).toEqual({ quote: "Plain quote", url: null });
    expect(splitSuggestedQuote(null)).toEqual({ quote: "", url: null });
  });
});
