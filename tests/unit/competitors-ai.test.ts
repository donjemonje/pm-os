/**
 * Story 5 (competitors) — the pure parts of the AI step over many pages:
 * chunking by size, merging statuses across chunks, the dates facts state,
 * and the page key that keeps a video id.
 */
import { describe, expect, it } from "vitest";
import { chunkPages, factDateOf, mergeStatus, packPages, type ClassifiedStatus, type PageText } from "@/lib/competitors/ai";
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

describe("mergeStatus", () => {
  const s = (value: ClassifiedStatus["value"], confidence: number, product = ""): ClassifiedStatus => ({ capability: "A", value, confidence, quote: value === "unknown" ? "" : `q-${value}`, url: value === "unknown" ? "" : `https://e.com/${value}`, product });
  it("presence beats absence whatever the confidence", () => {
    expect(mergeStatus(s("missing", 0.95), s("has", 0.6)).value).toBe("has");
    expect(mergeStatus(s("partial", 0.9), s("missing", 0.99)).value).toBe("partial");
    expect(mergeStatus(s("has", 0.5), s("partial", 0.9)).value).toBe("has");
  });
  it("unknown never wins over a value", () => {
    expect(mergeStatus(s("unknown", 1), s("missing", 0.3)).value).toBe("missing");
    expect(mergeStatus(s("has", 0.4), s("unknown", 1)).value).toBe("has");
  });
  it("same value: the more confident answer wins, and a product name survives from either side", () => {
    const m = mergeStatus(s("has", 0.6, ""), s("has", 0.9, "Core"));
    expect(m.confidence).toBe(0.9);
    expect(m.product).toBe("Core");
    expect(mergeStatus(s("has", 0.9, "Edge"), s("has", 0.6, "")).product).toBe("Edge");
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

describe("pageKey keeps a video id", () => {
  it("drops queries everywhere except youtube.com/watch", () => {
    expect(pageKey(new URL("https://www.youtube.com/watch?v=abc123&t=10s"))).toBe("https://www.youtube.com/watch?v=abc123");
    expect(pageKey(new URL("https://youtube.com/watch?list=1"))).toBe("https://youtube.com/watch");
    expect(pageKey(new URL("https://e.com/watch?v=abc"))).toBe("https://e.com/watch");
  });
});
