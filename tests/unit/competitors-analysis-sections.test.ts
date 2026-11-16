/** Capability Analysis — the reading plan (analysis/sections.ts): sections, label → what is read, and the "where a PM looks" reading order. Pure module. */
import { describe, expect, it } from "vitest";
import { KIND_RANK } from "@/lib/competitors/analysis/kinds";
import {
  buildSections,
  FRAME_MIN_PAGES,
  FRAME_SHARE,
  compareAddress,
  hostOf,
  inPlan,
  LABEL_RULES,
  MAP_OPENING_CHARS,
  MAP_SKIM_CHARS,
  PAGE_PICK_LABELS,
  pickReadable,
  prefixPath,
  READ_ORDER,
  ReadingPlan,
  readRank,
  sampleOpenings,
  SECTION_LABELS,
  SECTION_SAMPLES,
  sectionKey,
  sortByWhereAPmLooks,
  SPLIT_MIN_PAGES,
  SPLIT_MIN_SUBFOLDER_PAGES,
  SPLIT_MIN_SUBFOLDERS,
  type PlanPage,
  type SectionLabel,
} from "@/lib/competitors/analysis/sections";

const HOST = "acme.example";
const page = (path: string, extra: Partial<PlanPage> = {}): PlanPage => ({
  id: path, url: `https://www.${HOST}${path}`, state: "present", kind: "page", sourceId: "web", sourceType: "website", hasText: true, chars: 100, title: `Title of ${path}`, ...extra,
});
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => page(`${prefix}/p${String(i).padStart(3, "0")}`));
const build = (pages: PlanPage[], existing: string[] = []) => buildSections(pages, { homeHost: HOST, existing });
const prefixes = (pages: PlanPage[], existing: string[] = []) => build(pages, existing).map((s) => `${prefixPath(s.prefix)}:${s.pages}`);
const planOf = (labels: Record<string, SectionLabel>, sourceId = "web") => new ReadingPlan(Object.entries(labels).map(([path, label]) => ({ sourceId, prefix: `${HOST}${path}`, label })));
const read = (plan: ReadingPlan, path: string, extra: Partial<PlanPage> = {}) => plan.read(page(path, extra));

describe("what the map sees of a sample page — its first lines, without the site's frame", () => {
  const MENU = "Products\nSolutions\nPricing\nResources\nLog in\nGet a demo";
  const head = (id: string, own: string, sourceId = "web") => ({ id, sourceId, head: `${MENU}\n${own}\nPrivacy\nTerms` });
  const SITE = [
    head("a", "Plan your roadmap\nPrioritize what to build next with a score every team trusts."),
    head("b", "Pricing plans\nStarter, Team and Enterprise. Billed per maker."),
    head("c", "Customer stories\nHow teams ship faster."),
    head("d", "Release notes\nOctober: bulk edit, new filters."),
  ];

  it("the lines every page of the site starts with — the menu, the footer — are skipped; the page's own first lines are what is shown", () => {
    const o = sampleOpenings(SITE);
    expect(o.get("a")).toBe("Plan your roadmap Prioritize what to build next with a score every team trusts.");
    expect(o.get("d")).toBe("Release notes October: bulk edit, new filters.");
    for (const text of o.values()) expect(text).not.toMatch(/Products|Get a demo|Privacy/);
  });
  it("a line is frame when it shows on at least half of the source's sample pages", () => {
    const o = sampleOpenings([...SITE.slice(0, 2), { id: "c", sourceId: "web", head: "Welcome\nOnly here" }, { id: "d", sourceId: "web", head: "Welcome\nOnly there" }]);
    expect(Math.ceil(4 * FRAME_SHARE)).toBe(2);
    expect(o.get("c")).toBe("Only here");
    expect(o.get("a")).toContain("Plan your roadmap");
    expect(o.get("a")).not.toContain("Products");
  });
  it("a source with fewer sample pages than FRAME_MIN_PAGES has nothing to compare: every line is the page's own", () => {
    const o = sampleOpenings(SITE.slice(0, FRAME_MIN_PAGES - 1));
    expect(o.get("a")).toBe("Products Solutions Pricing Resources Log in Get a demo Plan your roadmap Prioritize what to build next with a score every team trusts. Privacy Terms");
  });
  it("the frame is told apart per source: a help center's menu is not the website's", () => {
    const help = ["h1", "h2", "h3", "h4"].map((id, n) => ({ id, sourceId: "help", head: `Help Center\nSearch\nArticle ${n}: how to do thing ${n}` }));
    const o = sampleOpenings([...SITE, ...help]);
    expect(o.get("h2")).toBe("Article 1: how to do thing 1");
    expect(o.get("b")).toBe("Pricing plans Starter, Team and Enterprise. Billed per maker.");
  });
  it("the opening is cut at a word to MAP_OPENING_CHARS — the map skims, it does not read", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const o = sampleOpenings([{ id: "x", sourceId: "s", head: long }]).get("x")!;
    expect(o.length).toBeLessThanOrEqual(MAP_OPENING_CHARS);
    expect(o.length).toBeGreaterThan(MAP_OPENING_CHARS * 0.6);
    expect(long.startsWith(`${o} `)).toBe(true);
    expect(MAP_OPENING_CHARS).toBe(300);
    expect(MAP_SKIM_CHARS).toBeGreaterThan(MAP_OPENING_CHARS);
  });
  it("a line that only repeats the page's title is skipped: the map already shows the title", () => {
    const o = sampleOpenings([{ id: "x", sourceId: "s", title: "Pricing | Acme", head: "Pricing | Acme\nStarter, Team and Enterprise.\nPricing | Acme is not repeated twice" }]);
    expect(o.get("x")).toBe("Starter, Team and Enterprise. Pricing | Acme is not repeated twice");
  });
  it("a page whose whole start is the site's frame, or that has no text, has no opening", () => {
    const o = sampleOpenings([...SITE, { id: "e", sourceId: "web", head: MENU }, { id: "f", sourceId: "web", head: "" }]);
    expect(o.get("e")).toBe("");
    expect(o.get("f")).toBe("");
  });
});

describe("inPlan — which stored pages take part", () => {
  it("every page that is there and has text", () => {
    expect(inPlan(page("/prisma/cloud"))).toBe(true);
    expect(inPlan(page("/x", { state: "unlinked" }))).toBe(true);
    expect(inPlan(page("/x", { state: "missing" }))).toBe(true);
    expect(inPlan(page("/x", { state: "removed" }))).toBe(false);
    expect(inPlan(page("/x", { hasText: false }))).toBe(false);
  });
  it("minus what code skips with certainty: legal, careers, login, localized copies, jobs and events sources", () => {
    for (const p of ["/legal/dpa", "/careers/eng", "/login", "/de/produkte"]) expect(inPlan(page(p)), p).toBe(false);
    expect(inPlan(page("/roles/1", { sourceType: "jobs" }))).toBe(false);
    expect(inPlan(page("/summit", { sourceType: "events" }))).toBe(false);
  });
  it("/llms.txt is the map's input, not a page", () => {
    expect(inPlan(page("/llms.txt"))).toBe(false);
  });
});

describe("buildSections", () => {
  it("groups by first path segment; the home page is its own section; a top-level page with nothing under it is a section of one page", () => {
    const sections = build([page("/"), page("/pricing"), page("/prisma"), page("/prisma/cloud"), page("/prisma/sase/overview"), page("/cortex/xdr"), page("/about")]);
    expect(sections.map((s) => `${prefixPath(s.prefix)}:${s.pages}`)).toEqual(["/:1", "/about:1", "/cortex:1", "/prisma:3", "/pricing:1"].sort());
    const home = sections.find((s) => s.depth === 0)!;
    expect(home).toMatchObject({ prefix: `${HOST}/`, home: true, pages: 1 });
    expect(sections.filter((s) => s.home)).toHaveLength(1);
    expect(sections.find((s) => s.prefix === `${HOST}/prisma`)).toMatchObject({ depth: 1, chars: 300, sourceId: "web", key: sectionKey("web", `${HOST}/prisma`) });
  });
  it("www and the bare host are one site; the English prefix is not a section", () => {
    const sections = build([page("/en/products/a"), page("/products/b"), { ...page("/products/c"), url: `https://${HOST}/products/c` }]);
    expect(sections.map((s) => `${s.prefix}:${s.pages}`)).toEqual([`${HOST}/products:3`]);
    expect(hostOf("https://WWW.Acme.Example:8443/x")).toBe("acme.example:8443");
  });
  it("skipped pages never reach a section — a document in a skipped folder neither", () => {
    expect(prefixes([page("/legal/terms"), page("/legal/dpa.pdf", { kind: "document" }), page("/de/preise"), page("/x", { state: "removed" }), page("/y", { hasText: false }), page("/llms.txt")])).toEqual([]);
  });
  it("sections are per source: the same folder of two sources is two sections; only the website's root is the home page", () => {
    const sections = build([page("/"), page("/guides/a"), page("/", { id: "h1", sourceId: "help", sourceType: "helpcenter", url: "https://help.acme.example/" }), page("/guides/a", { id: "h2", sourceId: "help", sourceType: "helpcenter", url: "https://help.acme.example/guides/a" })]);
    expect(sections.map((s) => `${s.sourceId}|${s.prefix}|${s.home}`)).toEqual([`web|${HOST}/|true`, `web|${HOST}/guides|false`, "help|help.acme.example/|false", "help|help.acme.example/guides|false"]);
  });
  it("samples: the shallowest pages first, then by address — at most SECTION_SAMPLES pages, each with its id, address and title", () => {
    const s = build([page("/docs/z/deep"), page("/docs/b"), page("/docs"), page("/docs/a"), page("/docs/c", { title: "  The   C page " }), page("/docs/d"), page("/docs/0", { title: null })])[0];
    expect(s.samples).toHaveLength(SECTION_SAMPLES);
    expect(s.samples.map((p) => new URL(p.url).pathname)).toEqual(["/docs", "/docs/0", "/docs/a", "/docs/b"]);
    expect(s.samples.map((p) => p.id)).toEqual(["/docs", "/docs/0", "/docs/a", "/docs/b"]);
    expect(s.samples.map((p) => p.title)).toEqual(["Title of /docs", "", "Title of /docs/a", "Title of /docs/b"]);
    expect(build([page("/docs/c", { title: "  The   C page " })])[0].samples[0].title).toBe("The C page");
  });
  it("a big section with several sizable sub-folders is split one level deeper; the rest stays in the first-segment section", () => {
    const pages = [page("/resources"), page("/resources/overview"), ...many("/resources/blog", 30), ...many("/resources/datasheets", SPLIT_MIN_SUBFOLDER_PAGES), ...many("/resources/tiny", SPLIT_MIN_SUBFOLDER_PAGES - 1), page("/resources/blog/2026/deep")];
    expect(pages.length).toBeGreaterThanOrEqual(SPLIT_MIN_PAGES);
    expect(prefixes(pages)).toEqual([`/resources:${2 + SPLIT_MIN_SUBFOLDER_PAGES - 1}`, "/resources/blog:31", `/resources/datasheets:${SPLIT_MIN_SUBFOLDER_PAGES}`]);
    expect(build(pages).find((s) => s.prefix.endsWith("/resources/blog"))?.depth).toBe(2);
  });
  it("no split below the page threshold, and none with fewer sizable sub-folders than SPLIT_MIN_SUBFOLDERS", () => {
    expect(SPLIT_MIN_SUBFOLDERS).toBe(2);
    expect(prefixes([...many("/docs/api", 10), ...many("/docs/guides", 10)])).toEqual(["/docs:20"]);
    expect(prefixes([...many("/docs/api", SPLIT_MIN_PAGES), page("/docs/guides/a")])).toEqual([`/docs:${SPLIT_MIN_PAGES + 1}`]);
  });
  it("one level only: sub-folders of a sub-folder are never sections", () => {
    const pages = [...many("/docs/api/v1", 30), ...many("/docs/api/v2", 30), ...many("/docs/guides/start", 30)];
    expect(prefixes(pages)).toEqual(["/docs/api:60", "/docs/guides:30"]);
  });
  it("a sub-folder that already has a saved section stays one, whatever its size today", () => {
    const pages = [page("/docs"), page("/docs/api/a"), page("/docs/guides/a")];
    expect(prefixes(pages)).toEqual(["/docs:3"]);
    expect(prefixes(pages, [sectionKey("web", `${HOST}/docs/api`)])).toEqual(["/docs:2", "/docs/api:1"]);
  });
  it("deterministic: the same pages in any order give the same sections", () => {
    const pages = [page("/"), ...many("/a", 3), ...many("/b/c", 7), page("/pricing")];
    expect(build([...pages].reverse())).toEqual(build(pages));
  });
});

describe("LABEL_RULES — label → what is read and how its evidence ranks", () => {
  it("covers the closed set of labels", () => {
    expect([...SECTION_LABELS]).toEqual(["product", "pricing", "compare", "help", "release_notes", "api_docs", "news", "noise"]);
    expect(Object.keys(LABEL_RULES).sort()).toEqual([...SECTION_LABELS].sort());
  });
  it("a label is a kind of content and how strong its evidence is — whether it is READ is not in this table: it is the setting \"What the analysis reads\"", () => {
    expect(LABEL_RULES.product).toEqual({ kind: "product", tier: "strong" });
    expect(LABEL_RULES.pricing).toEqual({ kind: "pricing", tier: "strong" });
    expect(LABEL_RULES.compare).toEqual({ kind: "content", tier: "strong" });
    for (const l of ["help", "release_notes", "api_docs"] as const) expect(LABEL_RULES[l], l).toEqual({ kind: "docs", tier: "strong" });
    expect(LABEL_RULES.news).toEqual({ kind: "news", tier: "weak" });
    expect(LABEL_RULES.noise).toEqual({ kind: "other", tier: "skip" });
    for (const l of SECTION_LABELS) expect(Object.keys(LABEL_RULES[l]).sort(), l).toEqual(["kind", "tier"]);
  });
  it("every label that has a kind maps to a kind the evidence ranking knows", () => {
    for (const l of SECTION_LABELS) if (LABEL_RULES[l].tier !== "skip") expect(KIND_RANK, l).toContain(LABEL_RULES[l].kind);
  });
});

describe("ReadingPlan.read", () => {
  const plan = planOf({ "/": "product", "/prisma": "product", "/pricing": "pricing", "/compare": "compare", "/help": "help", "/changelog": "release_notes", "/developers": "api_docs", "/blog": "news", "/customers": "noise", "/docs": "help", "/docs/api": "api_docs" });
  it("product, pricing and compare pages are read in the broad read, at any depth", () => {
    expect(read(plan, "/")).toEqual({ label: "product", kind: "product", tier: "strong", role: "broad" });
    expect(read(plan, "/prisma/cloud/workload/protection")).toEqual({ label: "product", kind: "product", tier: "strong", role: "broad" });
    expect(read(plan, "/pricing")).toEqual({ label: "pricing", kind: "pricing", tier: "strong", role: "broad" });
    expect(read(plan, "/compare/acme-vs-other")).toEqual({ label: "compare", kind: "content", tier: "strong", role: "broad" });
  });
  it("help, release notes and API docs are read at any depth: the old rule (index pages first, the articles only when going back) is gone", () => {
    expect(read(plan, "/help").role).toBe("broad");
    expect(read(plan, "/help/getting-started/install")).toEqual({ label: "help", kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/changelog/2026/11")).toEqual({ label: "release_notes", kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/developers/reference/v2/users")).toEqual({ label: "api_docs", kind: "docs", tier: "strong", role: "broad" });
  });
  it("a page belongs to the deepest saved section that holds it", () => {
    expect(read(plan, "/docs/start")).toMatchObject({ label: "help", role: "broad" });
    expect(read(plan, "/docs/api")).toMatchObject({ label: "api_docs", role: "broad" });
    expect(read(plan, "/docs/api/users/create")).toMatchObject({ label: "api_docs", role: "broad" });
    expect(plan.sectionOf(page("/docs/api/users"))).toEqual({ prefix: `${HOST}/docs/api`, depth: 2, label: "api_docs" });
  });
  it("news is weak; noise is never read", () => {
    expect(read(plan, "/blog/post")).toEqual({ label: "news", kind: "news", tier: "weak", role: "weak" });
    expect(read(plan, "/customers/big-bank")).toEqual({ label: "noise", kind: "other", tier: "skip", role: "skip" });
  });
  it("a section with no label is not read; the root section holds only the root page", () => {
    expect(read(plan, "/brand-new/page")).toEqual({ label: null, kind: "other", tier: "skip", role: "skip" });
    expect(read(planOf({ "/": "product" }), "/about").role).toBe("skip");
    expect(read(planOf({}), "/").role).toBe("skip");
  });
  it("code skips before the plan is asked: skipped folders, jobs and events sources, /llms.txt", () => {
    expect(read(plan, "/legal/terms")).toMatchObject({ kind: "legal", role: "skip" });
    expect(read(plan, "/de/prisma")).toMatchObject({ kind: "localized", role: "skip" });
    expect(read(plan, "/prisma/roles", { sourceType: "jobs" }).role).toBe("skip");
    expect(read(plan, "/llms.txt").role).toBe("skip");
  });
  it("a plan is per source: another source's sections say nothing about this page", () => {
    expect(read(planOf({ "/prisma": "product" }, "other-source"), "/prisma/cloud").role).toBe("skip");
  });
  it("a document is never skipped for its folder: strong docs — unless its section is read whole (its kind) or is news (weak)", () => {
    const doc = { kind: "document" };
    expect(read(plan, "/wp-content/uploads/core-datasheet.pdf", doc)).toEqual({ label: null, kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/legal/security-overview.pdf", doc)).toEqual({ label: null, kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/customers/case-study.pdf", doc)).toEqual({ label: "noise", kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/help/a/b/manual.pdf", doc)).toEqual({ label: "help", kind: "docs", tier: "strong", role: "broad" });
    expect(read(plan, "/pricing/price-list.pdf", doc)).toEqual({ label: "pricing", kind: "pricing", tier: "strong", role: "broad" });
    expect(read(plan, "/blog/report.pdf", doc)).toEqual({ label: "news", kind: "news", tier: "weak", role: "weak" });
    expect(read(plan, "/x.pdf", { ...doc, sourceType: "events" }).role).toBe("skip");
  });
  it("release notes win over where they sit: a page of a help-center or blog section that the map named a release-notes page IS one", () => {
    expect(read(plan, "/help/product-updates", { readAs: "release_notes" })).toEqual({ label: "release_notes", kind: "docs", tier: "strong", role: "broad" });
    // A changelog published as a blog post is strong evidence, like any release note — not a weak news page.
    expect(read(plan, "/blog/changelog-may", { readAs: "release_notes" })).toEqual({ label: "release_notes", kind: "docs", tier: "strong", role: "broad" });
    // The map looked at it and it is not one, or it was never looked at: it is what its section is.
    expect(read(plan, "/help/how-to", { readAs: "none" }).label).toBe("help");
    expect(read(plan, "/blog/opinion").label).toBe("news");
    // Only inside help-center and blog sections: the mark means nothing elsewhere.
    expect(read(plan, "/prisma/x", { readAs: "release_notes" }).label).toBe("product");
    expect(read(plan, "/customers/x", { readAs: "release_notes" }).role).toBe("skip");
    expect([...PAGE_PICK_LABELS]).toEqual(["help", "news"]);
  });
  it("a saved label outside the closed set is no label", () => {
    expect(new ReadingPlan([{ sourceId: "web", prefix: `${HOST}/prisma`, label: "products" }]).size).toBe(0);
  });
});

describe("pickReadable", () => {
  const plan = planOf({ "/": "product", "/pricing": "pricing", "/blog": "news", "/about": "noise", "/features": "product", "/docs": "help" });
  const pages = [page("/pricing"), page("/blog/a"), page("/about"), page("/features/x"), page("/docs/old", { state: "removed" }), page("/docs/empty", { hasText: false }), page("/"), page("/docs/b", { state: "unlinked" }), page("/docs/b/deep"), page("/unlabeled")];
  it("every page that has a kind, sorted by address — news included: whether a kind is read is the setting's; removed, text-less, noise and unlabeled pages never", () => {
    const picked = pickReadable(pages, plan);
    expect(picked.map((p) => `${p.id}:${p.read.role}`)).toEqual(["/:broad", "/blog/a:weak", "/docs/b:broad", "/docs/b/deep:broad", "/features/x:broad", "/pricing:broad"]);
    expect(picked.find((p) => p.id === "/blog/a")?.read.tier).toBe("weak");
  });
});

describe("where a PM looks — the order pages are read in", () => {
  const plan = planOf({ "/": "product", "/pricing": "pricing", "/compare": "compare", "/help": "help", "/blog": "news", "/prisma": "product", "/api": "api_docs", "/changelog": "release_notes" });
  it("the strongest sources first: release notes, help center, API docs, the pricing page, product pages, comparison pages, news", () => {
    expect([...READ_ORDER]).toEqual(["release_notes", "help", "api_docs", "pricing", "product", "compare", "news"]);
    expect(["/changelog/2026", "/help/a/b", "/api/users", "/pricing", "/prisma/x", "/compare/a", "/blog/a"].map((p) => readRank(read(plan, p)))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("a document outside every section reads with the product pages", () => {
    expect(readRank(read(plan, "/uploads/sheet.pdf", { kind: "document" }))).toBe(READ_ORDER.indexOf("product"));
  });
  it("related pages stay together: a page is followed by its inner pages, not by a page whose name merely starts the same", () => {
    const urls = ["/roadmaps-and-more", "/roadmaps/gantt/zoom", "/roadmaps", "/roadmaps/gantt", "/ideas"].map((p) => `https://www.${HOST}${p}`);
    expect([...urls].sort(compareAddress).map((u) => u.replace(`https://www.${HOST}`, ""))).toEqual(["/ideas", "/roadmaps", "/roadmaps/gantt", "/roadmaps/gantt/zoom", "/roadmaps-and-more"]);
    // A plain text comparison would put "/roadmaps-and-more" between a page and its inner pages.
    expect([...urls].sort()[2]).toContain("/roadmaps-and-more");
  });
  it("one site after the other: another host never interleaves", () => {
    expect(["https://support.acme.example/b", "https://acme.example/z", "https://support.acme.example/a", "https://www.acme.example/a"].sort(compareAddress)).toEqual(["https://www.acme.example/a", "https://acme.example/z", "https://support.acme.example/a", "https://support.acme.example/b"]);
  });
  it("the whole order: by kind of source, inside a kind by address", () => {
    const paths = ["/help/a/b", "/blog/a", "/prisma/b", "/", "/api", "/compare/z", "/pricing", "/help", "/prisma/a", "/compare/a", "/changelog/2026"];
    const sorted = sortByWhereAPmLooks(pickReadable(paths.map((p) => page(p)), plan));
    expect(sorted.map((p) => p.id)).toEqual(["/changelog/2026", "/help", "/help/a/b", "/api", "/pricing", "/", "/prisma/a", "/prisma/b", "/compare/a", "/compare/z", "/blog/a"]);
  });
  it("deterministic: the same pages in any order give the same order", () => {
    const paths = ["/help/a/b", "/prisma/b", "/", "/api", "/pricing", "/help"];
    const a = sortByWhereAPmLooks(pickReadable(paths.map((p) => page(p)), plan)).map((p) => p.id);
    const b = sortByWhereAPmLooks(pickReadable([...paths].reverse().map((p) => page(p)), plan)).map((p) => p.id);
    expect(a).toEqual(b);
  });
});
