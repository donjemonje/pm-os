/** Capability Analysis — what the analysis never reads, decided in code (analysis/kinds.ts). Pure module. */
import { describe, expect, it } from "vitest";
import { folderSkip, KIND_RANK, segmentsOf, SKIP_RULES, SKIPPED_SOURCE_TYPES, sourceSkip } from "@/lib/competitors/analysis/kinds";

const skip = (path: string) => folderSkip(`https://www.acme.example${path}`);

describe("folderSkip — the folders code skips with certainty", () => {
  it("careers, legal, account and listing pages", () => {
    for (const p of ["/careers", "/career/eng", "/jobs/1", "/legal/dpa", "/terms", "/privacy", "/cookie", "/login", "/sign-in", "/thank-you", "/search", "/tag/x", "/authors/y", "/events/2026", "/checkout"]) {
      expect(skip(p), p).toBe("legal");
    }
  });
  it("a localized copy of the site; a site under /en/ is not one", () => {
    expect(skip("/de/products/x")).toBe("localized");
    expect(skip("/zh-cn/")).toBe("localized");
    expect(skip("/en/products/x")).toBeNull();
    expect(skip("/en-us/pricing")).toBeNull();
  });
  it("nothing else: every other folder goes to the map, whatever its name", () => {
    for (const p of ["/", "/about", "/customers/acme", "/blog/post", "/prisma", "/cortex/xdr", "/network-security", "/product-brain", "/compare/us-vs-them", "/pricing", "/docs/api"]) expect(skip(p), p).toBeNull();
  });
  it("the rules are data: a kind and a pattern on the first segment", () => {
    for (const r of SKIP_RULES) {
      expect(typeof r.kind).toBe("string");
      expect(r.first).toBeInstanceOf(RegExp);
    }
  });
});

describe("sourceSkip", () => {
  it("a collector's source of jobs or events is never read", () => {
    expect(SKIPPED_SOURCE_TYPES).toEqual(["jobs", "events"]);
    expect(sourceSkip("jobs")).toBe(true);
    expect(sourceSkip("events")).toBe(true);
    for (const t of ["website", "helpcenter", "documents", "blog", "press"]) expect(sourceSkip(t), t).toBe(false);
  });
});

describe("segmentsOf", () => {
  it("lower case, file extension and a trailing index dropped, the English prefix dropped", () => {
    expect(segmentsOf("https://acme.example/Products/Core.html")).toEqual(["products", "core"]);
    expect(segmentsOf("https://acme.example/docs/index.html")).toEqual(["docs"]);
    expect(segmentsOf("https://acme.example/en/products/x")).toEqual(["products", "x"]);
    expect(segmentsOf("https://acme.example/en-gb/")).toEqual([]);
    expect(segmentsOf("https://acme.example")).toEqual([]);
    expect(segmentsOf("https://acme.example/a/b?x=1#y")).toEqual(["a", "b"]);
  });
});

describe("KIND_RANK", () => {
  it("evidence ranks pricing, docs, product, content, news", () => {
    expect(KIND_RANK).toEqual(["pricing", "docs", "product", "content", "news"]);
  });
});
