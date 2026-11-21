/** Capability Analysis — the organization's own site (lib/competitors/own.ts): listings, the product-lines page, the own cell. Pure module. */
import { describe, expect, it } from "vitest";
import { contentHash } from "@/lib/competitors/html";
import {
  competitorsOnly,
  isProductLinesPage,
  NOT_OWN,
  OWN_MATERIAL_SOURCE_TYPE,
  ownEvidenceOf,
  ownStatusAfterRun,
  PRODUCT_LINES_PAGE_URL,
  productLinesPageText,
  productLinesPageTitle,
  readOwnEvidence,
} from "@/lib/competitors/own";
import { SOURCE_TYPES } from "@/lib/competitors/config";
import { buildSections, ReadingPlan } from "@/lib/competitors/analysis/sections";

describe("competitor listings leave the own source out", () => {
  it("the query part every listing carries excludes rows flagged isOwn", () => {
    expect(NOT_OWN).toEqual({ isOwn: false });
  });
  it("a list of companies without the own source keeps its order", () => {
    const rows = [
      { id: "a", name: "Acme", isOwn: false },
      { id: "us", name: "Us", isOwn: true },
      { id: "b", name: "Beta", isOwn: false },
    ];
    expect(competitorsOnly(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(competitorsOnly([rows[1]])).toEqual([]);
  });
  it("the source that holds the product-lines page is not a source type anything can import into or scan", () => {
    expect((SOURCE_TYPES as readonly string[]).includes(OWN_MATERIAL_SOURCE_TYPE)).toBe(false);
    expect(OWN_MATERIAL_SOURCE_TYPE).not.toBe("website");
  });
});

describe("the product lines as a stored page", () => {
  const lines = [
    { name: "Roadmaps", description: "Plan and share what is built next.", position: 1 },
    { name: "Ideas", description: "Collect feedback\nand rank it.", position: 0 },
    { name: "Notebooks", description: "", position: 2 },
  ];
  it("is the title, then one block per product line — name, then description — in the order of Settings", () => {
    expect(productLinesPageText("Aha", lines)).toBe(
      "Product lines of Aha\n\nIdeas\nCollect feedback\nand rank it.\n\nRoadmaps\nPlan and share what is built next.\n\nNotebooks",
    );
    expect(productLinesPageTitle("  Aha ")).toBe("Product lines of Aha");
    expect(productLinesPageTitle("")).toBe("Product lines");
  });
  it("the same lines always give the same text and the same hash, whatever order they are loaded in", () => {
    const a = productLinesPageText("Aha", lines)!;
    const b = productLinesPageText("Aha", [...lines].reverse())!;
    expect(b).toBe(a);
    expect(contentHash(b)).toBe(contentHash(a));
  });
  it("lines at the same position are ordered by name", () => {
    expect(productLinesPageText("Aha", [{ name: "B", description: "", position: 0 }, { name: "A", description: "", position: 0 }])).toBe("Product lines of Aha\n\nA\n\nB");
  });
  it("a changed product line moves the hash: the page is due again", () => {
    const before = contentHash(productLinesPageText("Aha", lines)!);
    const described = lines.map((l) => (l.name === "Notebooks" ? { ...l, description: "Write product documents together." } : l));
    expect(contentHash(productLinesPageText("Aha", described)!)).not.toBe(before);
    expect(contentHash(productLinesPageText("Aha", lines.map((l) => (l.name === "Ideas" ? { ...l, name: "Idea Portal" } : l)))!)).not.toBe(before);
    expect(contentHash(productLinesPageText("Aha", lines.slice(0, 2))!)).not.toBe(before);
    expect(contentHash(productLinesPageText("Aha", [...lines, { name: "Whiteboards", description: "", position: 3 }])!)).not.toBe(before);
  });
  it("extra spaces do not change the page", () => {
    const spaced = lines.map((l) => ({ ...l, name: `  ${l.name}  `, description: l.description.replace(/ /g, "   ") }));
    expect(productLinesPageText("Aha", spaced)).toBe(productLinesPageText("Aha", lines));
  });
  it("no product line with a name → no page", () => {
    expect(productLinesPageText("Aha", [])).toBeNull();
    expect(productLinesPageText("Aha", [{ name: "  ", description: "Something", position: 0 }])).toBeNull();
  });
  it("lives at a fixed internal address that is a section of its own, read as a strong product page once labeled", () => {
    expect(isProductLinesPage(PRODUCT_LINES_PAGE_URL)).toBe(true);
    expect(isProductLinesPage("https://aha.io/product-lines")).toBe(false);
    expect(isProductLinesPage(null)).toBe(false);
    expect(new URL(PRODUCT_LINES_PAGE_URL).hostname.endsWith(".internal")).toBe(true);
    const page = { id: "p1", url: PRODUCT_LINES_PAGE_URL, state: "present", kind: "page", sourceId: "s-own", sourceType: OWN_MATERIAL_SOURCE_TYPE, hasText: true, chars: 120, title: "Product lines of Aha" };
    const sections = buildSections([page], { homeHost: "aha.io" });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ sourceType: OWN_MATERIAL_SOURCE_TYPE, pages: 1, home: false });
    // Labeled "product" in code (plan.ts): the page is in the broad read, and evidence from it is strong.
    const plan = new ReadingPlan([{ sourceId: "s-own", prefix: sections[0].prefix, label: "product" }]);
    expect(plan.read(page)).toEqual({ label: "product", kind: "product", tier: "strong", role: "broad" });
    // Without a label it is not read: nothing is read without a plan.
    expect(new ReadingPlan([]).read(page).role).toBe("skip");
  });
});

describe("the own cell after a run of the own source", () => {
  it("evidence of ours → found; none → not found", () => {
    expect(ownStatusAfterRun({ ourStatus: "not_found", setByPm: false }, { count: 2 })).toEqual({ ourStatus: "found", changed: true });
    expect(ownStatusAfterRun({ ourStatus: "found", setByPm: false }, { count: 0 })).toEqual({ ourStatus: "not_found", changed: true });
    expect(ownStatusAfterRun({ ourStatus: "found", setByPm: false }, { count: 1 })).toEqual({ ourStatus: "found", changed: false });
    expect(ownStatusAfterRun({ ourStatus: "not_found", setByPm: false }, { count: 0 })).toEqual({ ourStatus: "not_found", changed: false });
  });
  it("a value a PM set by hand is never changed, whatever the run found", () => {
    expect(ownStatusAfterRun({ ourStatus: "not_found", setByPm: true }, { count: 5 })).toEqual({ ourStatus: "not_found", changed: false });
    expect(ownStatusAfterRun({ ourStatus: "found", setByPm: true }, { count: 0 })).toEqual({ ourStatus: "found", changed: false });
  });
  it("the PM's value survives every later run", () => {
    let row = { ourStatus: "found", setByPm: true };
    for (const count of [0, 3, 0, 0, 1]) row = { ...row, ourStatus: ownStatusAfterRun(row, { count }).ourStatus };
    expect(row.ourStatus).toBe("found");
  });
  it("has no confidence: there is no third value", () => {
    for (const count of [0, 1, 7]) expect(["found", "not_found"]).toContain(ownStatusAfterRun({ ourStatus: "not_found", setByPm: false }, { count }).ourStatus);
    // A stored value that is not one of the two reads as not found for a PM-set row (it is never written).
    expect(ownStatusAfterRun({ ourStatus: "low", setByPm: true }, { count: 1 }).ourStatus).toBe("not_found");
  });
  it("the evidence kept on the row is the best-ranked finding: quote, page, reasoning, our wording, description, pages", () => {
    const best = { quote: "Collect ideas from customers", pageUrl: "https://aha.io/ideas", reasoning: "The page offers it.", wording: "Idea portal" };
    expect(ownEvidenceOf({ best, count: 3, description: "Collects feedback in one place." })).toEqual({
      quote: "Collect ideas from customers", sourceUrl: "https://aha.io/ideas", reasoning: "The page offers it.", wording: "Idea portal", description: "Collects feedback in one place.", count: 3,
    });
    expect(ownEvidenceOf({ best: null, count: 0, description: null })).toBeNull();
  });
  it("stored evidence is read field by field; anything else is no evidence", () => {
    const stored = { quote: "q", sourceUrl: "https://aha.io/x", reasoning: "r", wording: "w", description: "d", count: 2 };
    expect(readOwnEvidence(stored)).toEqual(stored);
    expect(readOwnEvidence({ quote: "q", sourceUrl: "https://aha.io/x" })).toEqual({ quote: "q", sourceUrl: "https://aha.io/x", reasoning: "", wording: "", description: null, count: 1 });
    expect(readOwnEvidence(null)).toBeNull();
    expect(readOwnEvidence([])).toBeNull();
    expect(readOwnEvidence({ quote: "", sourceUrl: "https://aha.io/x" })).toBeNull();
    expect(readOwnEvidence({ quote: "q" })).toBeNull();
  });
});
