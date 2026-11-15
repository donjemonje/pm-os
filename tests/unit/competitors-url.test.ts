/**
 * Story 2 (competitors) — URL rules of the website scanner, pure module:
 * normalization of what a PM types, the registrable host that bounds a
 * crawl, the private-network guard (checklist §12), page priority.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidUrlError,
  isInsideSite,
  looksLikePage,
  normalizeWebsite,
  pageKey,
  pagePriority,
  registrableHost,
} from "@/lib/competitors/url";

// These tests check the product defaults: the e2e environment (CI sets it for the whole job) must not leak in.
delete process.env.COMPETITORS_ALLOW_PRIVATE_HOSTS;

describe("normalizeWebsite", () => {
  it("accepts a bare host, a www host and a URL with a path, and keeps the https origin", () => {
    expect(normalizeWebsite("recordedfuture.com")).toEqual({ url: "https://recordedfuture.com", host: "recordedfuture.com" });
    expect(normalizeWebsite(" www.Flashpoint.io/pricing ")).toEqual({ url: "https://www.flashpoint.io", host: "flashpoint.io" });
    // PRD 2026-11-04: a subdomain is its own site ("app.pm-os.io is a separate add"); only www. folds into the bare host.
    expect(normalizeWebsite("http://docs.example.co.uk/a?b=1")).toEqual({ url: "http://docs.example.co.uk", host: "docs.example.co.uk" });
  });
  it("refuses private and local addresses before any fetch", () => {
    for (const bad of ["http://10.0.0.1", "http://localhost", "http://127.0.0.1:3000", "http://192.168.1.4", "http://169.254.169.254", "http://[::1]"]) {
      expect(() => normalizeWebsite(bad)).toThrow(InvalidUrlError);
      try {
        normalizeWebsite(bad);
      } catch (e) {
        expect((e as InvalidUrlError).reason).toBe("private");
      }
    }
  });
  it("refuses empty input, other schemes and credentials in the URL", () => {
    expect(() => normalizeWebsite("")).toThrow(InvalidUrlError);
    expect(() => normalizeWebsite("ftp://example.com")).toThrow(InvalidUrlError);
    expect(() => normalizeWebsite("https://user:pw@example.com")).toThrow(InvalidUrlError);
    expect(() => normalizeWebsite("not a url at all")).toThrow(InvalidUrlError);
  });
});

describe("registrableHost / isInsideSite", () => {
  it("collapses subdomains to the registrable host, with two-level public suffixes", () => {
    expect(registrableHost("www.docs.example.com")).toBe("example.com");
    expect(registrableHost("shop.example.co.il")).toBe("example.co.il");
    expect(registrableHost("example.com")).toBe("example.com");
  });
  it("keeps the crawl inside the site: www yes, other subdomains no (separate sources), other hosts and private hosts no", () => {
    expect(isInsideSite(new URL("https://www.example.com/x"), "example.com")).toBe(true);
    expect(isInsideSite(new URL("https://docs.example.com/x"), "example.com")).toBe(false);
    expect(isInsideSite(new URL("https://example.com.evil.net/x"), "example.com")).toBe(false);
    expect(isInsideSite(new URL("https://other.com/"), "example.com")).toBe(false);
    expect(isInsideSite(new URL("mailto:a@example.com"), "example.com")).toBe(false);
    expect(isInsideSite(new URL("http://10.1.2.3/"), "10.1.2.3")).toBe(false);
  });
});

describe("pageKey / looksLikePage / pagePriority", () => {
  it("drops query, hash and trailing slash so one page has one key", () => {
    expect(pageKey(new URL("https://Example.com/pricing/?utm=1#top"))).toBe("https://example.com/pricing");
    expect(pageKey(new URL("https://example.com/"))).toBe("https://example.com/");
  });
  it("skips assets and documents", () => {
    expect(looksLikePage(new URL("https://e.com/platform"))).toBe(true);
    expect(looksLikePage(new URL("https://e.com/d.pdf"))).toBe(true); // PDFs are pages (PRD 2026-11-04)
    for (const p of ["/a.css", "/b.js", "/c.png", "/sitemap.xml", "/f.woff2"]) {
      expect(looksLikePage(new URL(`https://e.com${p}`))).toBe(false);
    }
  });
  it("reads the home, pricing and product pages before blog and legal pages", () => {
    const order = ["/", "/pricing", "/platform/threat-intel", "/integrations", "/trust", "/customers", "/about", "/release-notes", "/anything", "/blog/post"]
      .map((p) => pagePriority(new URL(`https://e.com${p}`)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(pagePriority(new URL("https://e.com/blog/x"))).toBeGreaterThan(pagePriority(new URL("https://e.com/products/x")));
  });
  it("a blog post about product updates is still a blog post; legal pages are not product pages; case studies beat both", () => {
    const blog = pagePriority(new URL("https://e.com/blog/product-updates-platform-solutions"));
    const legal = pagePriority(new URL("https://e.com/product-terms"));
    const caseStudy = pagePriority(new URL("https://e.com/case-study/financial-services-company"));
    const product = pagePriority(new URL("https://e.com/platform/ai"));
    expect(blog).toBe(9);
    expect(legal).toBe(9);
    expect(caseStudy).toBeLessThan(blog);
    expect(product).toBeLessThan(caseStudy);
    // a research post whose slug mentions use cases is not a use-case page
    expect(pagePriority(new URL("https://e.com/research/red-teaming-malicious-use-cases-ai"))).toBe(8);
    expect(pagePriority(new URL("https://e.com/use-case/ransomware"))).toBe(2);
  });
});
