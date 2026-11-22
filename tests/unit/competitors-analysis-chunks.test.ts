/** Capability Analysis — the chunks of the reading (analysis/chunks.ts, chunk-view.ts): what one request holds. Pure modules. */
import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_TOKENS,
  chunkKey,
  chunkTokens,
  FRAME_MIN_PAGES,
  FRAME_MIN_RUN,
  NO_FRAME,
  packChunks,
  PAGE_HEADER_TOKENS,
  renderChunk,
  renderPage,
  sampleEvenly,
  SHOW_SITE_FRAME_ONCE,
  siteFrame,
  tokensOf,
  withoutFrame,
  type ChunkPage,
} from "@/lib/competitors/analysis/chunks";
import { chunkView, kindsText, readUnexplained, resultText } from "@/lib/competitors/analysis/chunk-view";
import { compareAddress, pickReadable, ReadingPlan, sectionKey, sortByWhereAPmLooks, type PlanPage, type SectionLabel } from "@/lib/competitors/analysis/sections";

const H = PAGE_HEADER_TOKENS;
/** A page of `tokens` tokens of text (its header is on top). */
const p = (id: string, tokens: number, section = "s", sourceId = "web"): ChunkPage => ({ id, tokens: tokens - H, section, sourceId });
const ids = (chunks: ChunkPage[][]) => chunks.map((c) => c.map((x) => x.id));

describe("the size cap", () => {
  it("starts at 500,000 tokens per request", () => {
    expect(CHUNK_MAX_TOKENS).toBe(500_000);
    expect(tokensOf(2_000_000)).toBe(500_000);
  });
  it("a company whose pages fit under the cap is ONE request — a small site is one hit", () => {
    const pages = [p("home", 1_000, "home"), p("a", 30_000, "product"), p("b", 30_000, "product"), p("help1", 100_000, "help", "hc"), p("help2", 200_000, "help", "hc")];
    expect(ids(packChunks(pages, { maxTokens: 500_000 }))).toEqual([["home", "a", "b", "help1", "help2"]]);
  });
  it("as many pages as fit: a page that does not fit starts the next chunk, and no page is dropped or reordered", () => {
    const pages = Array.from({ length: 10 }, (_, i) => p(`p${i}`, 30));
    const chunks = packChunks(pages, { maxTokens: 100 });
    expect(ids(chunks)).toEqual([["p0", "p1", "p2"], ["p3", "p4", "p5"], ["p6", "p7", "p8"], ["p9"]]);
    for (const c of chunks) expect(chunkTokens(c)).toBeLessThanOrEqual(100);
  });
  it("a page larger than the cap goes alone", () => {
    expect(ids(packChunks([p("a", 10), p("huge", 500), p("b", 10)], { maxTokens: 100 }))).toEqual([["a"], ["huge"], ["b"]]);
  });
  it("no pages, no chunk", () => {
    expect(packChunks([], { maxTokens: 100 })).toEqual([]);
  });
});

describe("related pages stay together", () => {
  it("a section that fits in a chunk of its own is not cut in two to fill a request: it starts the next chunk when the current one is at least half full", () => {
    // 60 of 100 used; the next section (3 × 20) does not fit in the 40 that are left.
    const pages = [p("a1", 30, "a"), p("a2", 30, "a"), p("b1", 20, "b"), p("b2", 20, "b"), p("b3", 20, "b")];
    expect(ids(packChunks(pages, { maxTokens: 100 }))).toEqual([["a1", "a2"], ["b1", "b2", "b3"]]);
  });
  it("a chunk that is less than half full is filled, even when that cuts the next section", () => {
    const pages = [p("a1", 40, "a"), p("b1", 30, "b"), p("b2", 30, "b"), p("b3", 30, "b")];
    expect(ids(packChunks(pages, { maxTokens: 100 }))).toEqual([["a1", "b1", "b2"], ["b3"]]);
  });
  it("a section larger than a whole chunk is cut only where the cap forces it", () => {
    const pages = [p("a1", 60, "a"), ...Array.from({ length: 6 }, (_, i) => p(`b${i}`, 30, "b"))];
    expect(ids(packChunks(pages, { maxTokens: 100 }))).toEqual([["a1", "b0"], ["b1", "b2", "b3"], ["b4", "b5"]]);
  });
  it("the same folder of another source is another section", () => {
    const pages = [p("w1", 30, "docs", "web"), p("w2", 30, "docs", "web"), p("h1", 20, "docs", "hc"), p("h2", 20, "docs", "hc"), p("h3", 20, "docs", "hc")];
    expect(ids(packChunks(pages, { maxTokens: 100 }))).toEqual([["w1", "w2"], ["h1", "h2", "h3"]]);
  });
});

describe("the order of the pages: where a PM looks, one site after the other, a page before its inner pages", () => {
  const HOST = "acme.example";
  const page = (path: string, sourceId = "web", host = `www.${HOST}`): PlanPage => ({ id: `${sourceId}:${path}`, url: `https://${host}${path}`, state: "present", kind: "page", sourceId, sourceType: sourceId === "web" ? "website" : "helpcenter", hasText: true, chars: 400 });
  const plan = new ReadingPlan([
    ...(Object.entries({ "/": "product", "/pricing": "pricing", "/features": "product", "/vs": "compare", "/changelog": "release_notes" }) as Array<[string, SectionLabel]>).map(([path, label]) => ({ sourceId: "web", prefix: `${HOST}${path}`, label })),
    { sourceId: "hc", prefix: `support.${HOST}/articles`, label: "help" },
    { sourceId: "hc", prefix: `support.${HOST}/release-notes`, label: "release_notes" },
  ]);
  const pages = [page("/"), page("/pricing"), page("/features/roadmaps/gantt"), page("/features/roadmaps"), page("/features/roadmaps-pro"), page("/vs/other"), page("/changelog/2026"), page("/articles/sso", "hc", `support.${HOST}`), page("/articles/sso/okta", "hc", `support.${HOST}`), page("/release-notes/2026-11", "hc", `support.${HOST}`)];
  const ordered = sortByWhereAPmLooks(pickReadable(pages, plan));
  it("release notes first — of every source — then the help center, then pricing, product, comparison pages", () => {
    expect(ordered.map((x) => x.id)).toEqual([
      "web:/changelog/2026", "hc:/release-notes/2026-11",
      "hc:/articles/sso", "hc:/articles/sso/okta",
      "web:/pricing",
      "web:/", "web:/features/roadmaps", "web:/features/roadmaps/gantt", "web:/features/roadmaps-pro",
      "web:/vs/other",
    ]);
  });
  it("packed in that order, a company that needs two requests reads its strongest sources in the first", () => {
    const sized = ordered.map((x) => ({ id: x.id, sourceId: x.sourceId, section: sectionKey(x.sourceId, plan.sectionOf(x)?.prefix ?? ""), tokens: 100 - H }));
    const chunks = packChunks(sized, { maxTokens: 500 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].map((x) => x.id)).toEqual(["web:/changelog/2026", "hc:/release-notes/2026-11", "hc:/articles/sso", "hc:/articles/sso/okta", "web:/pricing"]);
    expect(compareAddress(pages[3].url, pages[2].url)).toBeLessThan(0);
  });
});

describe("the boundaries are reproducible: a run that stopped continues with the very same requests", () => {
  const pages = [
    ...Array.from({ length: 7 }, (_, i) => p(`rn${i}`, 35, "release-notes", "hc")),
    ...Array.from({ length: 5 }, (_, i) => p(`help${i}`, 25, "help", "hc")),
    p("pricing", 10, "pricing"), ...Array.from({ length: 4 }, (_, i) => p(`feat${i}`, 45, "features")), p("vs", 15, "vs"),
  ];
  const frameTokens = new Map([["hc", 12]]);
  const all = packChunks(pages, { maxTokens: 150, frameTokens });
  it("the same pages always give the same chunks", () => {
    expect(ids(packChunks([...pages], { maxTokens: 150, frameTokens }))).toEqual(ids(all));
    expect(all.length).toBeGreaterThan(3);
  });
  it("packing what is left after the first k chunks gives exactly the chunks that were left — for every k", () => {
    for (let k = 1; k < all.length; k++) {
      const read = new Set(all.slice(0, k).flat().map((x) => x.id));
      expect(ids(packChunks(pages.filter((x) => !read.has(x.id)), { maxTokens: 150, frameTokens })), `after ${k} chunks`).toEqual(ids(all.slice(k)));
    }
  });
  it("a chunk's key is its pages and the text each had: a changed page makes another key", () => {
    const a = chunkKey([{ id: "p1", hash: "h1" }, { id: "p2", hash: "h2" }]);
    expect(chunkKey([{ id: "p1", hash: "h1" }, { id: "p2", hash: "h2" }])).toBe(a);
    expect(chunkKey([{ id: "p1", hash: "h1" }, { id: "p2", hash: "h2b" }])).not.toBe(a);
  });
});

describe("the site's frame is shown once per request — nothing is trimmed", () => {
  const MENU = ["Release notes", "System status", "Get help", "Submit an idea", "Log in", "Free trial"];
  const TOC = ["Account", "Billing", "Single sign-on", "Integrations", "Jira", "MCP server", "Whiteboards"];
  const article = (n: number) => [`Article ${n}`, ...MENU, `Breadcrumb ${n}`, `This is what article ${n} says about the product.`, "Integrations", `And a second own line of article ${n}.`, ...TOC, "© Acme"].join("\n");
  const texts = Array.from({ length: FRAME_MIN_PAGES }, (_, i) => article(i));
  const frame = siteFrame(texts);
  it("is on by default", () => {
    expect(SHOW_SITE_FRAME_ONCE).toBe(true);
  });
  it("the frame of a source is the lines that show on at least half of a sample of its pages", () => {
    for (const line of [...MENU, ...TOC, "© Acme"]) expect(frame.lines.has(line), line).toBe(true);
    expect(frame.lines.has("Article 3")).toBe(false);
    expect(frame.lines.has("This is what article 3 says about the product.")).toBe(false);
    // The block keeps a page's own order.
    expect(frame.text.split("\n").slice(0, 3)).toEqual(MENU.slice(0, 3));
  });
  it("a source with fewer pages than FRAME_MIN_PAGES has no frame: every page is sent as stored", () => {
    expect(siteFrame(texts.slice(0, FRAME_MIN_PAGES - 1))).toBe(NO_FRAME);
    expect(withoutFrame(article(1), NO_FRAME)).toBe(article(1));
  });
  it("whole runs of frame lines leave the page; its own lines stay, in place and unchanged", () => {
    const own = withoutFrame(article(4), frame).split("\n");
    expect(own).toEqual(["Article 4", "Breadcrumb 4", "This is what article 4 says about the product.", "Integrations", "And a second own line of article 4."]);
  });
  it("a line inside an article that merely equals a menu entry stays where it is: only runs of at least FRAME_MIN_RUN lines are moved", () => {
    expect(FRAME_MIN_RUN).toBe(5);
    expect(withoutFrame(article(4), frame)).toContain("says about the product.\nIntegrations\nAnd a second own line");
    const short = ["Own line", "Account", "Billing", "Jira", "Own line two"].join("\n");
    expect(withoutFrame(short, frame)).toBe(short);
  });
  it("every line of the page is still in the request: in the page, or in the frame block shown once", () => {
    const sent = renderChunk([{ label: "Help center support.acme.example", text: frame.text }], [{ code: "P1", url: "https://support.acme.example/a/4", kind: "help", title: "Article 4", text: withoutFrame(article(4), frame) }]);
    for (const line of article(4).split("\n")) expect(sent, line).toContain(line);
    expect(sent.startsWith("=== SITE FRAME | Help center support.acme.example")).toBe(true);
  });
  it("the frame counts once per chunk, however many pages of the source are in it", () => {
    const pages = [p("a", 30, "s", "hc"), p("b", 30, "s", "hc"), p("c", 30, "s", "hc")];
    expect(chunkTokens(pages, new Map([["hc", 25]]))).toBe(115);
    expect(ids(packChunks(pages, { maxTokens: 100, frameTokens: new Map([["hc", 25]]) }))).toEqual([["a", "b"], ["c"]]);
  });
  it("the sample is the same pages for the same list", () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    expect(sampleEvenly(list, 200)).toEqual(sampleEvenly(list, 200));
    expect(sampleEvenly(list, 200)).toHaveLength(200);
    expect(sampleEvenly(list, 200)[0]).toBe(0);
    expect(sampleEvenly([1, 2, 3], 200)).toEqual([1, 2, 3]);
  });
});

describe("what a request looks like", () => {
  it("a page: one header line with its code, address, kind and title, then its text, whole", () => {
    expect(renderPage({ code: "P7", url: "https://acme.example/pricing", kind: "pricing", title: "  Plans \n and pricing ", text: "Starter\nPro" })).toBe("=== PAGE P7 | https://acme.example/pricing | kind: pricing | title: Plans and pricing\nStarter\nPro");
  });
  it("no frame block when the source has none", () => {
    expect(renderChunk([], [{ code: "P1", url: "u", kind: "product", title: "t", text: "x" }])).toBe("=== PAGE P1 | u | kind: product | title: t\nx");
  });
});

describe("a reading request as Administration shows it", () => {
  it("pages by kind, in reading order", () => {
    expect(kindsText({ product: 30, help: 210, release_notes: 40, document: 2 })).toBe("40 release notes, 210 help, 30 product, 2 document");
    expect(kindsText(null)).toBe("");
  });
  it("what the answer did: the list for the first request, the changes for a later one", () => {
    expect(resultText("list", { capabilities: 42, features: 180 })).toBe("the list: 42 capabilities, 180 features");
    expect(resultText("changes", { capabilities: 44, features: 207, newCapabilities: 2, newFeatures: 27, corrections: 3, removed: 0 })).toBe("+2 capabilities, +27 features, 3 corrections, 0 removed → 44 capabilities, 207 features");
  });
  it("the whole row: pages, tokens, model, time, incidents and the labels seen but not explained", () => {
    const view = chunkView({
      id: "c1", analysisId: "run", position: 2, kind: "changes", pages: 269, tokens: 502_000, kinds: { help: 269 }, firstUrl: "https://support.acme.example/a", lastUrl: "https://support.acme.example/z", model: "gemini-4-argon",
      inputTokens: 439_402, outputTokens: 3_339, thinkingTokens: 0, ms: 64_200, result: { capabilities: 9, features: 117, newCapabilities: 0, newFeatures: 27, corrections: 3, removed: 0, incidents: 1 }, unexplained: [{ label: "Custom fields", url: "https://acme.example/pricing" }, { nope: true }], createdAt: new Date("2026-11-16T16:24:00Z"),
    });
    expect(view).toMatchObject({ position: 2, kind: "changes", pages: 269, kinds: "269 help", tokens: 502_000, inputTokens: 439_402, outputTokens: 3_339, seconds: 64, incidents: 1, unexplained: 1, model: "gemini-4-argon" });
    expect(readUnexplained("junk")).toEqual([]);
  });
});
