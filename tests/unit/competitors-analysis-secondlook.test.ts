/** Capability Analysis — the second look (analysis/secondlook.ts): which pages are shown, and when it is asked again. Pure module. */
import { describe, expect, it } from "vitest";
import { capLooks, indexPages, lookKey, pagesFor, scorePage, type LookPage } from "@/lib/competitors/analysis/secondlook";

const page = (path: string, title: string, text: string): LookPage => ({ id: path, url: `https://acme.example${path}`, title, text, hash: `h${path}` });

describe("scorePage", () => {
  const score = (terms: string[], p: LookPage) => scorePage(terms, indexPages([p])[0]);
  it("the whole name in the title beats the address, which beats the text", () => {
    const inTitle = score(["Single sign-on"], page("/x", "Single Sign-On for teams", "nothing here"));
    const inPath = score(["Single sign-on"], page("/single-sign-on", "Docs", "nothing here"));
    const inText = score(["Single sign-on"], page("/x", "Docs", "We offer single sign-on."));
    expect(inTitle).toBeGreaterThan(inPath);
    expect(inPath).toBeGreaterThan(inText);
    expect(inText).toBeGreaterThan(0);
  });
  it("counts each word in the text up to 5 times", () => {
    const few = score(["Takedown"], page("/x", "Docs", "takedown takedown"));
    const many = score(["Takedown"], page("/x", "Docs", Array(30).fill("takedown").join(" ")));
    // whole term 10 + word occurrences (2, then capped at 5)
    expect(few).toBe(12);
    expect(many).toBe(15);
  });
  it("words that say nothing (management, platform, the …) and words under 3 letters do not score", () => {
    expect(score(["Management Platform of AI"], page("/x", "Docs", "our management platform for the win"))).toBe(0);
    expect(score(["Exposure Management"], page("/x", "Docs", "exposure of assets"))).toBe(1);
  });
  it("an alias scores like the name", () => {
    expect(score(["Single sign-on", "SSO"], page("/sso", "SSO", "SSO for all"))).toBeGreaterThan(score(["Single sign-on"], page("/sso", "SSO", "SSO for all")));
  });
});

describe("pagesFor", () => {
  const cap = { name: "Brand protection", aliases: [] as string[] };
  it("best first; ties by address; pages that do not score are out", () => {
    const pages = indexPages([
      page("/b", "Other", "brand protection is here"),
      page("/a", "Other", "brand protection is here"),
      page("/brand-protection", "Brand Protection", "Protect your brand."),
      page("/pricing", "Pricing", "Plans and prices."),
    ]);
    expect(pagesFor(cap, pages).map((p) => p.id)).toEqual(["/brand-protection", "/a", "/b"]);
  });
  it("at most 4 pages", () => {
    const pages = indexPages(Array.from({ length: 9 }, (_, i) => page(`/p${i}`, "Brand protection", "brand")));
    expect(pagesFor(cap, pages).map((p) => p.id)).toEqual(["/p0", "/p1", "/p2", "/p3"]);
  });
  it("stops when the texts would pass 80,000 characters in all", () => {
    const pages = indexPages([page("/a", "Brand protection", "x".repeat(50_000)), page("/b", "Brand protection", "y".repeat(40_000)), page("/c", "Brand protection", "z".repeat(10))]);
    expect(pagesFor(cap, pages).map((p) => p.id)).toEqual(["/a"]);
    expect(pagesFor(cap, pages, { maxChars: 100_000 }).map((p) => p.id)).toEqual(["/a", "/b", "/c"]);
  });
  it("the first page is always in, cut when it alone is larger than the limit", () => {
    const picked = pagesFor(cap, indexPages([page("/a", "Brand protection", "x".repeat(200_000))]));
    expect(picked).toHaveLength(1);
    expect(picked[0].text.length).toBe(80_000);
  });
  it("no page scores → no page, so no call is made", () => {
    expect(pagesFor(cap, indexPages([page("/pricing", "Pricing", "Plans and prices.")]))).toEqual([]);
    expect(pagesFor(cap, [])).toEqual([]);
  });
});

describe("lookKey", () => {
  const capability = { name: "SSO", description: "One login.", aliases: ["Single sign-on"] };
  const domain = { name: "Identity", description: "Who gets in." };
  const pages = [{ id: "p1", hash: "h1" }, { id: "p2", hash: "h2" }];
  const base = lookKey(capability, domain, pages, "model-a");
  it("is 32 hex characters and does not depend on the order of the pages", () => {
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(lookKey(capability, domain, [...pages].reverse(), "model-a")).toBe(base);
  });
  it("does not change when a page's text changes: the research step reads the changed page, the look is not asked again", () => {
    const edited = [{ id: "p1", hash: "h1-changed" }, { id: "p2", hash: "h2-changed" }];
    expect(lookKey(capability, domain, edited, "model-a")).toBe(base);
    expect(lookKey(capability, domain, [{ id: "p1" }, { id: "p2" }], "model-a")).toBe(base);
  });
  it("changes with the description, an alias, the page set and the model", () => {
    expect(lookKey({ ...capability, description: "One login for all apps." }, domain, pages, "model-a")).not.toBe(base);
    expect(lookKey({ ...capability, aliases: [] }, domain, pages, "model-a")).not.toBe(base);
    expect(lookKey(capability, domain, [{ id: "p3" }, pages[1]], "model-a")).not.toBe(base);
    expect(lookKey(capability, domain, [pages[0]], "model-a")).not.toBe(base);
    expect(lookKey(capability, domain, pages, "model-b")).not.toBe(base);
    expect(lookKey(capability, { ...domain, description: "Who may enter." }, pages, "model-a")).not.toBe(base);
    expect(lookKey(capability, domain, [], "model-a")).not.toBe(base);
  });
});

describe("capLooks — the limit on second looks per run", () => {
  const todo = Array.from({ length: 50 }, (_, i) => `k${i + 1}`);
  it("under the limit everything is asked now", () => {
    expect(capLooks(todo.slice(0, 12), 0, 30)).toEqual({ now: todo.slice(0, 12), later: [] });
    expect(capLooks([], 0, 30)).toEqual({ now: [], later: [] });
  });
  it("over the limit: the first 30 in the to-do's order now, the rest stay due for the next run", () => {
    const r = capLooks(todo, 0, 30);
    expect(r.now).toEqual(todo.slice(0, 30));
    expect(r.later).toEqual(todo.slice(30));
  });
  it("a run that continues counts the looks it made before it stopped", () => {
    // 12 were asked before the stop, so they are no longer on the to-do; 18 more fit.
    const left = todo.slice(12);
    const r = capLooks(left, 12, 30);
    expect(r.now).toEqual(left.slice(0, 18));
    expect(r.later).toHaveLength(20);
    expect(capLooks(left, 30, 30).now).toEqual([]);
    expect(capLooks(left, 45, 30)).toEqual({ now: [], later: left });
  });
});
