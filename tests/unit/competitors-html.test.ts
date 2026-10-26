/**
 * Story 2 (competitors) — HTML → text, links, change detection and bot-wall
 * detection of the website scanner (src/lib/competitors/html.ts). Pure module.
 */
import { describe, expect, it } from "vitest";
import { contentHash, extractLinks, htmlToText, looksEmptyWithoutJs, looksLikeBotWall, metaDescription, siteNameOf, titleOf } from "@/lib/competitors/html";
import { Frontier, isAllowed, orderCandidates } from "@/lib/competitors/crawl";

const PAGE = `<!doctype html><html><head><title>Acme &amp; Co — Platform</title>
<meta name="description" content="Threat intel for &quot;everyone&quot;">
<style>.x{color:red}</style><script>var a = 1;</script></head>
<body><nav><a href="/pricing">Pricing</a></nav>
<main><h1>Dark web monitoring</h1><p>We watch closed forums&nbsp;24/7.</p>
<ul><li>Takedown requests</li><li>SIEM integrations</li></ul>
<a href="/platform/intel">Intel</a> <a href="https://other.com/x">Out</a> <a href="/docs/api#top">Docs</a></main>
<footer>© 2026 Acme</footer></body></html>`;

describe("htmlToText", () => {
  it("keeps the content, drops scripts, styles, nav and footer, and separates blocks by line", () => {
    const text = htmlToText(PAGE);
    expect(text).toContain("Dark web monitoring");
    expect(text).toContain("We watch closed forums 24/7.");
    expect(text.split("\n")).toContain("Takedown requests");
    expect(text).not.toContain("var a");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Pricing"); // nav is chrome
    expect(text).not.toContain("© 2026");
  });
  it("decodes entities in title and description", () => {
    expect(titleOf(PAGE)).toBe("Acme & Co — Platform");
    expect(metaDescription(PAGE)).toBe('Threat intel for "everyone"');
  });
});

describe("extractLinks + contentHash", () => {
  it("resolves every href against the page and strips fragments", () => {
    const links = extractLinks(PAGE, "https://acme.com/home").map((u) => u.href);
    expect(links).toEqual(["https://acme.com/pricing", "https://acme.com/platform/intel", "https://other.com/x", "https://acme.com/docs/api"]);
  });
  it("hashes the text, so markup churn is not a change but a word is", () => {
    const a = htmlToText(PAGE);
    const b = htmlToText(PAGE.replace("<p>", '<p class="new">').replace("<style>.x{color:red}</style>", ""));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(a.replace("24/7", "9–5")));
    expect(contentHash(a)).toHaveLength(32);
  });
});

describe("bot wall and JS-only detection", () => {
  it("recognises Cloudflare's interstitial and a 403 with a challenge, not an ordinary 403", () => {
    expect(looksLikeBotWall(403, "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>")).toBe(true);
    expect(looksLikeBotWall(200, "<title>Attention Required! | Cloudflare</title>")).toBe(true);
    expect(looksLikeBotWall(403, "<html><body><h1>Forbidden</h1><p>You don't have permission.</p></body></html>")).toBe(false);
    expect(looksLikeBotWall(200, PAGE)).toBe(false);
  });
  it("flags an empty SPA shell as needing a browser, and a normal page as not", () => {
    expect(looksEmptyWithoutJs("", '<html><body><div id="root"></div><script src="/app.js"></script></body></html>')).toBe(true);
    expect(looksEmptyWithoutJs(htmlToText(PAGE).padEnd(500, " x"), PAGE)).toBe(false);
  });
});

describe("Frontier", () => {
  const rules = { disallow: ["/wp-admin/", "/thank-you", "/*.pdf$", "https://acme.com/private/"], sitemaps: [] };
  it("honours robots.txt rules with wildcards and absolute URLs", () => {
    expect(isAllowed(new URL("https://acme.com/platform"), rules)).toBe(true);
    expect(isAllowed(new URL("https://acme.com/wp-admin/x"), rules)).toBe(false);
    expect(isAllowed(new URL("https://acme.com/thank-you-page"), rules)).toBe(false);
    expect(isAllowed(new URL("https://acme.com/files/a.pdf"), rules)).toBe(false);
    expect(isAllowed(new URL("https://acme.com/private/x"), rules)).toBe(false);
  });
  it("dedupes by page key, stays inside the site, skips assets, feeds and locales, and hands out the most useful page first", () => {
    const f = new Frontier("acme.com", rules);
    expect(f.add(new URL("https://acme.com/"), "home")).toBe(true);
    expect(f.add(new URL("https://acme.com/?utm=1"), "link")).toBe(false); // same page
    expect(f.add(new URL("https://acme.com/blog/post-1"), "link")).toBe(true);
    expect(f.add(new URL("https://acme.com/pricing/"), "link")).toBe(true);
    expect(f.add(new URL("https://acme.com/de/pricing"), "link")).toBe(false); // localized duplicate
    expect(f.add(new URL("https://acme.com/feed"), "link")).toBe(false);
    expect(f.add(new URL("https://acme.com/logo.png"), "link")).toBe(false);
    expect(f.add(new URL("https://other.com/"), "link")).toBe(false);
    expect(f.next()?.url).toBe("https://acme.com/");
    expect(f.next()?.url).toBe("https://acme.com/pricing");
    expect(f.next()?.url).toBe("https://acme.com/blog/post-1");
    expect(f.next()).toBeUndefined();
  });
  it("orders equal priorities by depth, then name", () => {
    const sorted = orderCandidates([
      { key: "c", url: "https://a.com/products/one/two", priority: 2, via: "link" },
      { key: "b", url: "https://a.com/products/zeta", priority: 2, via: "link" },
      { key: "a", url: "https://a.com/products/alpha", priority: 2, via: "link" },
    ]).map((c) => c.url);
    expect(sorted).toEqual(["https://a.com/products/alpha", "https://a.com/products/zeta", "https://a.com/products/one/two"]);
  });
});

describe("siteNameOf", () => {
  it("prefers og:site_name, then the shortest title segment, then the host", () => {

    expect(siteNameOf('<head><meta property="og:site_name" content="Recorded Future"><title>Advanced Cyber Threat Intelligence | Recorded Future</title></head>', "recordedfuture.com")).toBe("Recorded Future");
    expect(siteNameOf("<title>Flashpoint | Threat Intelligence With Industry-Best Data</title>", "flashpoint.io")).toBe("Flashpoint");
    expect(siteNameOf("<title>Check Point Exposure Management | Formerly Cyberint</title>", "cyberint.com")).toBe("Formerly Cyberint");
    expect(siteNameOf("<html></html>", "intel471.com")).toBe("Intel471");
  });
});
