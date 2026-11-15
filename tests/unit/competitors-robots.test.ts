import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, robotsRuleMatches } from "../../src/lib/competitors/crawl";

/** robots.txt reading (remote lane): group rule and the wildcard matcher — Tomer's review 2026-11-10, items 21 and 22. */
describe("parseRobots", () => {
  it("keeps the rules of a group that lists several user-agents, ours among them", () => {
    const r = parseRobots("User-agent: *\nUser-agent: Googlebot\nDisallow: /private\nCrawl-delay: 2\n\nUser-agent: Bingbot\nDisallow: /bing-only\nSitemap: https://acme.com/sitemap.xml\n");
    expect(r.disallow).toEqual(["/private"]);
    expect(r.crawlDelaySec).toBe(2);
    expect(r.sitemaps).toEqual(["https://acme.com/sitemap.xml"]);
  });
  it("a group that names only another bot does not apply to us", () => {
    const r = parseRobots("User-agent: Googlebot\nDisallow: /google-only\n\nUser-agent: *\nDisallow: /everyone\n");
    expect(r.disallow).toEqual(["/everyone"]);
  });
  it("a pm-os group wins over nothing special: its rules apply", () => {
    expect(parseRobots("User-agent: PM-OS\nDisallow: /no-pmos\n").disallow).toEqual(["/no-pmos"]);
  });
});

describe("robotsRuleMatches", () => {
  it("is a prefix match", () => {
    expect(robotsRuleMatches("/private", "/private/docs")).toBe(true);
    expect(robotsRuleMatches("/private", "/public")).toBe(false);
  });
  it("* stands for any run of characters, $ anchors the end", () => {
    expect(robotsRuleMatches("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(robotsRuleMatches("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(robotsRuleMatches("/*/print", "/blog/1/print")).toBe(true);
    expect(robotsRuleMatches("/a*b*c", "/aXXbYYc-and-more")).toBe(true);
    expect(robotsRuleMatches("/a*b*c", "/aXXbYY")).toBe(false);
  });
  it("many stars stay fast (no backtracking regex)", () => {
    const rule = "/" + "*a".repeat(30) + "*b";
    const path = "/" + "a".repeat(5000);
    const t0 = Date.now();
    expect(robotsRuleMatches(rule, path)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it("isAllowed takes absolute URLs in Disallow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: https://acme.com/search\n");
    expect(isAllowed(new URL("https://acme.com/search?q=x"), rules)).toBe(false);
    expect(isAllowed(new URL("https://acme.com/pricing"), rules)).toBe(true);
  });
});
