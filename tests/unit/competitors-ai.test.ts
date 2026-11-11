/**
 * Story 5 (competitors) — the pure parts of the AI step over many pages:
 * chunking by size, the dates facts state,
 * and the page key that keeps a video id.
 */
import { describe, expect, it } from "vitest";
import { chunkPages, cut, factDateOf, packPages, tidy, type PageText } from "@/lib/competitors/ai";
import { pageKey } from "@/lib/competitors/url";

const page = (i: number, chars: number, extra: Partial<PageText> = {}): PageText => ({ url: `https://e.com/p${i}`, title: `P${i}`, text: "x".repeat(chars), ...extra });

describe("chunkPages", () => {
  it("keeps a small set in one chunk, in order", () => {
    const chunks = chunkPages([page(1, 100), page(2, 100), page(3, 100)], 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].map((p) => p.url)).toEqual(["https://e.com/p1", "https://e.com/p2", "https://e.com/p3"]);
  });
  it("splits when the limit is reached and never drops a page", () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(i, 3000));
    const chunks = chunkPages(pages, 7000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((p) => p.url)).toEqual(pages.map((p) => p.url));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2);
  });
  it("a page longer than the per-page cut counts at its truncated size", () => {
    const chunks = chunkPages([page(1, 50_000), page(2, 50_000)], 20_000);
    expect(chunks).toHaveLength(1);
  });
  it("packs the source kind, label and date into the page header", () => {
    const packed = packPages([page(1, 10, { kind: "article", sourceLabel: "Help center", observedAt: "2026-09-29T13:56:20Z" })]);
    expect(packed).toContain("### PAGE https://e.com/p1");
    expect(packed).toContain("Source: article · Help center · dated 2026-09-29");
  });
});

describe("factDateOf", () => {
  it("accepts a year, a month or a day", () => {
    expect(factDateOf("2024")?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(factDateOf("2024-12")?.toISOString()).toBe("2024-12-01T00:00:00.000Z");
    expect(factDateOf("2024-12-20")?.toISOString()).toBe("2024-12-20T00:00:00.000Z");
  });
  it("rejects anything else, including far-off years", () => {
    for (const v of ["", null, undefined, "Dec 2024", "20/12/2024", "1899", "2100-01-01", "2024-13"]) expect(factDateOf(v)).toBeNull();
  });
});

describe("tidy", () => {
  it("cuts a leaked next-field fragment and a dangling quote-comma", () => {
    expect(tidy("Automated detection rule generation (Auto YARA)','domain':'Cyber Threat")).toBe("Automated detection rule generation (Auto YARA)");
    expect(tidy("IBM Security SOAR (IBM Resilient)','")).toBe("IBM Security SOAR (IBM Resilient)");
    expect(tidy("Payment Fraud Intelligence (PFI)\",")).toBe("Payment Fraud Intelligence (PFI)");
  });
  it("leaves ordinary values and balanced quotes alone", () => {
    expect(tidy("Know what matters. Act first.")).toBe("Know what matters. Act first.");
    expect(tidy('supports "Splunk", "QRadar" and more')).toBe('supports "Splunk", "QRadar" and more');
    expect(tidy("Splunk, QRadar")).toBe("Splunk, QRadar");
    expect(tidy("  Boston, MA ")).toBe("Boston, MA");
  });
});

describe("pageKey keeps a video id", () => {
  it("drops queries everywhere except youtube.com/watch", () => {
    expect(pageKey(new URL("https://www.youtube.com/watch?v=abc123&t=10s"))).toBe("https://www.youtube.com/watch?v=abc123");
    expect(pageKey(new URL("https://youtube.com/watch?list=1"))).toBe("https://youtube.com/watch");
    expect(pageKey(new URL("https://e.com/watch?v=abc"))).toBe("https://e.com/watch");
  });
});

describe("cut", () => {
  it("keeps short strings and cuts long ones at a word boundary", () => {
    expect(cut("short name", 80)).toBe("short name");
    expect(cut("AI service network indicator feeds for shadow AI discovery and policy enforcement", 80)).toBe("AI service network indicator feeds for shadow AI discovery and policy");
  });
  it("falls back to a hard cut when there is no usable space", () => {
    expect(cut("x".repeat(100), 80)).toBe("x".repeat(80));
  });
});
