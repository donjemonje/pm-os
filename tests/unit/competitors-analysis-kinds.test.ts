/** Capability Analysis — which stored pages the analysis reads (analysis/kinds.ts). Pure module. */
import { describe, expect, it } from "vitest";
import { DEFAULT_KIND, KIND_RANK, PAGE_KIND_RULES, pageTier, pickPages, type PickablePage } from "@/lib/competitors/analysis/kinds";

const web = (path: string, pageKind = "page") => pageTier(`https://www.acme.example${path}`, "website", pageKind);

describe("pageTier — the rules, one address each", () => {
  it("a collector's source type decides before any path", () => {
    expect(pageTier("https://help.acme.example/blog/x", "helpcenter", "article")).toEqual({ kind: "docs", tier: "strong" });
    expect(pageTier("https://acme.example/products/x", "press", "page")).toEqual({ kind: "news", tier: "weak" });
    expect(pageTier("https://acme.example/products/x", "jobs", "page").tier).toBe("skip");
    expect(pageTier("https://acme.example/products/x", "events", "page").tier).toBe("skip");
  });
  it("careers, legal, account and listing pages are skipped", () => {
    for (const p of ["/careers", "/career/eng", "/jobs/1", "/legal/dpa", "/terms", "/privacy", "/cookie", "/login", "/sign-in", "/thank-you", "/search", "/tag/x", "/authors/y", "/events/2026", "/checkout"]) {
      expect(web(p), p).toEqual({ kind: "legal", tier: "skip" });
    }
  });
  it("blog, news and press are weak", () => {
    for (const p of ["/blog/post", "/news/x", "/press", "/newsroom/a", "/press-releases/b", "/media/c"]) expect(web(p), p).toEqual({ kind: "news", tier: "weak" });
  });
  it("content marketing is weak", () => {
    for (const p of ["/resources/guide", "/insights", "/whitepapers/x", "/webinars/y", "/glossary/z", "/academy"]) expect(web(p), p).toEqual({ kind: "content", tier: "weak" });
  });
  it("pricing is strong, in the first or the second segment", () => {
    expect(web("/pricing")).toEqual({ kind: "pricing", tier: "strong" });
    expect(web("/plans/enterprise")).toEqual({ kind: "pricing", tier: "strong" });
    expect(web("/product/pricing")).toEqual({ kind: "pricing", tier: "strong" });
    expect(web("/pricing-plans.html")).toEqual({ kind: "pricing", tier: "strong" });
  });
  it("docs and help are strong", () => {
    for (const p of ["/docs/api", "/documentation", "/developers/sdk", "/help/article", "/support", "/kb/1", "/knowledge-base/x", "/faq", "/release-notes/5", "/datasheets/core"]) expect(web(p), p).toEqual({ kind: "docs", tier: "strong" });
  });
  it("product, features and integrations are strong", () => {
    for (const p of ["/product", "/products/core", "/platform", "/solutions/finance", "/features/sso", "/capabilities", "/integrations/jira", "/use-cases/x", "/security"]) expect(web(p), p).toEqual({ kind: "product", tier: "strong" });
  });
  it("the home page is read as a product page", () => {
    expect(web("/")).toEqual({ kind: "product", tier: "strong" });
    expect(pageTier("https://www.acme.example", "website", "page")).toEqual({ kind: "product", tier: "strong" });
    expect(web("/index.html")).toEqual({ kind: "product", tier: "strong" });
  });
  it("everything else is not read (Daniel 2026-11-11: start lean)", () => {
    expect(DEFAULT_KIND).toEqual({ kind: "other", tier: "skip" });
    for (const p of ["/about", "/customers/acme", "/company/team", "/contact", "/why-us"]) expect(web(p), p).toEqual({ kind: "other", tier: "skip" });
  });
});

describe("pageTier — order and exceptions", () => {
  it("first match wins: /blog/product-updates is weak, not product", () => {
    expect(web("/blog/product-updates")).toEqual({ kind: "news", tier: "weak" });
  });
  it("a site under /en/ is read; a localized copy is skipped", () => {
    expect(web("/en/products/x")).toEqual({ kind: "product", tier: "strong" });
    expect(web("/en-us/pricing")).toEqual({ kind: "pricing", tier: "strong" });
    expect(web("/en/")).toEqual({ kind: "product", tier: "strong" });
    expect(web("/de/products/x")).toEqual({ kind: "localized", tier: "skip" });
    expect(web("/zh-cn/")).toEqual({ kind: "localized", tier: "skip" });
  });
  it("a PDF is never skipped for its folder: strong under /wp-content/uploads/, weak under /resources/", () => {
    expect(web("/wp-content/uploads/2026/core-datasheet.pdf", "document")).toEqual({ kind: "docs", tier: "strong" });
    expect(web("/legal/security-overview.pdf", "document")).toEqual({ kind: "docs", tier: "strong" });
    expect(web("/de/datenblatt.pdf", "document")).toEqual({ kind: "docs", tier: "strong" });
    expect(web("/resources/whitepaper.pdf", "document")).toEqual({ kind: "content", tier: "weak" });
    expect(web("/blog/report.pdf", "document")).toEqual({ kind: "news", tier: "weak" });
    expect(web("/pricing/price-list.pdf", "document")).toEqual({ kind: "pricing", tier: "strong" });
  });
  it("kinds are data: every rule has a tier, and every strong or weak kind has an evidence rank", () => {
    for (const r of PAGE_KIND_RULES) {
      expect(["strong", "weak", "skip"]).toContain(r.tier);
      if (r.tier !== "skip") expect(KIND_RANK, r.kind).toContain(r.kind);
    }
  });
});

describe("pickPages", () => {
  const page = (url: string, extra: Partial<PickablePage> = {}): PickablePage => ({ id: url, url: `https://acme.example${url}`, hash: "h", chars: 100, state: "present", kind: "page", sourceType: "website", hasText: true, ...extra });
  const pages = [page("/pricing"), page("/blog/a"), page("/about"), page("/features/x"), page("/docs/old", { state: "removed" }), page("/docs/empty", { hasText: false }), page("/"), page("/docs/b", { state: "unlinked" })];
  it("reads strong pages only by default, sorted by address; removed and text-less pages never", () => {
    const picked = pickPages(pages, { readWeak: false });
    expect(picked.map((p) => p.id)).toEqual(["/", "/docs/b", "/features/x", "/pricing"]);
    expect(picked.every((p) => p.tier === "strong")).toBe(true);
    expect(picked.find((p) => p.id === "/pricing")?.pageKind).toBe("pricing");
  });
  it("reads weak pages too when the setting is on — never skipped ones", () => {
    const picked = pickPages(pages, { readWeak: true });
    expect(picked.map((p) => p.id)).toEqual(["/", "/blog/a", "/docs/b", "/features/x", "/pricing"]);
    expect(picked.find((p) => p.id === "/blog/a")?.tier).toBe("weak");
  });
});
