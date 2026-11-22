import { describe, expect, it } from "vitest";
import { codeItems, newsTool, parseNews, renderNews, NONE, NOT_STATED, type NewsPage } from "@/lib/competitors/news/intake";
import { renderNewsEmail, type NewsEmailRow } from "@/lib/competitors/news/email";

const items = codeItems([
  { id: "k1", name: "Roadmaps", description: "Plans on a timeline.", features: [{ id: "f1", name: "Export to PNG", description: "Save a roadmap as an image." }] },
  { id: "k2", name: "Integrations", description: "Push work to issue trackers.", features: [] },
]);
const page: NewsPage = { url: "https://example.test/notes", title: "Notes", kind: "release_notes", publishedAt: "2026-11-20", text: "You can now compare two snapshots of a roadmap. We also hired a new sales lead. Roadmaps still export to PNG." };
const piece = (over: Record<string, unknown>) => ({ type: "ability", other_type: NONE, name: "Snapshot compare", what: "Compares two snapshots of a roadmap.", problem: "Seeing what changed.", workflows: NOT_STATED, who: "Product managers", quote: "compare two snapshots of a roadmap", covered_by: NONE, size: "feature", parent: "K1", reason: "Nothing on the list compares snapshots.", ...over });

describe("news intake: the list and the request", () => {
  it("codes capabilities K1… and their features K1.1…", () => {
    expect(items.map((i) => i.code)).toEqual(["K1", "K1.1", "K2"]);
    expect(items[1].parentCode).toBe("K1");
  });
  it("shows the list and the page in the request", () => {
    const text = renderNews("Acme", items, page);
    expect(text).toContain("K1 | Roadmaps — Plans on a timeline.");
    expect(text).toContain("  K1.1 | Export to PNG");
    expect(text).toContain("kind: release_notes");
    expect(text).toContain("date: 2026-11-20");
  });
  it("requires every field of a piece (an optional field lets the model stop early)", () => {
    const schema = (newsTool(items).input_schema as { properties: { pieces: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.pieces.items;
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe("news intake: the verdict is decided in code", () => {
  it("new feature: not covered, with a capability of the list as its parent", () => {
    const { pieces } = parseNews({ page_is_about: "notes", pieces: [piece({})] }, items, page);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ verdict: "new", size: "feature", quoteOk: true, workflows: null, audience: "Product managers" });
    expect(pieces[0].parent?.id).toBe("k1");
  });
  it("new capability: not covered and no parent, whatever size the answer claimed", () => {
    const { pieces } = parseNews({ pieces: [piece({ parent: NONE, size: "feature" })] }, items, page);
    expect(pieces[0]).toMatchObject({ verdict: "new", size: "capability", parent: null });
  });
  it("covered: the answer names an item of the list", () => {
    const { pieces } = parseNews({ pieces: [piece({ name: "PNG export", quote: "Roadmaps still export to PNG", covered_by: "K1.1", size: NONE, parent: NONE })] }, items, page);
    expect(pieces[0].verdict).toBe("covered");
    expect(pieces[0].covered?.id).toBe("f1");
  });
  it("other: not an ability — no understanding fields, an unknown type reads as other", () => {
    const { pieces } = parseNews({ pieces: [piece({ type: "other", other_type: "hr", name: "New sales lead", what: "A sales lead was hired.", quote: "We also hired a new sales lead" }), piece({ type: "other", other_type: "gossip", quote: "" })] }, items, page);
    expect(pieces[0]).toMatchObject({ verdict: "other", otherType: "hr", problem: null, size: null });
    expect(pieces[1].otherType).toBe("other");
  });
  it("a quote that is not on the page keeps the piece but marks it unproven", () => {
    const { pieces } = parseNews({ pieces: [piece({ quote: "this sentence is nowhere on the page" })] }, items, page);
    expect(pieces[0]).toMatchObject({ verdict: "new", quote: null, quoteOk: false });
  });
  it("drops a piece that names a code outside the list, a feature as a parent, or has no name", () => {
    const { pieces, dropped } = parseNews({ pieces: [piece({ covered_by: "K9" }), piece({ parent: "K1.1" }), piece({ name: "" })] }, items, page);
    expect(pieces).toHaveLength(0);
    expect(dropped).toBe(3);
  });
});

describe("news notification", () => {
  const row = (over: Partial<NewsEmailRow>): NewsEmailRow => ({ verdict: "new", otherType: null, size: "capability", name: "Interviews", what: "Records customer calls.", problem: "No separate recorder.", workflows: null, audience: "Product managers", quote: "record the conversation", quoteOk: true, reason: "", coveredName: null, parentName: null, sourceUrl: "https://example.test/a", sourceTitle: "A", ...over });
  const base = { orgName: "Org", competitorName: "Acme", simulated: false, pages: 3, failedPages: 0, appUrl: "https://app.test" };
  it("reports all three verdicts and counts only proven new abilities in the subject", () => {
    const mail = renderNewsEmail({ ...base, rows: [row({}), row({ name: "Unproven", quoteOk: false, quote: null }), row({ verdict: "covered", name: "Copilot", coveredName: "Spark", reason: "Same chat agent." }), row({ verdict: "other", otherType: "hr", name: "New CRO", what: "A CRO was hired." })] });
    expect(mail.subject).toBe("Acme: 1 new ability");
    expect(mail.text).toContain("NEW ABILITIES (1)");
    expect(mail.text).toContain("Already on the list as: Spark");
    expect(mail.text).toContain("People: New CRO");
    expect(mail.html).toContain("Interviews");
  });
  it("says nothing new when no new ability was found, and marks a simulation", () => {
    const mail = renderNewsEmail({ ...base, simulated: true, rows: [row({ verdict: "other", otherType: "pricing", name: "Prices", what: "Prices changed." })] });
    expect(mail.subject).toBe("[Simulation] Acme: nothing new");
  });
  it("escapes page text in the HTML", () => {
    const mail = renderNewsEmail({ ...base, rows: [row({ name: "<script>x</script>" })] });
    expect(mail.html).not.toContain("<script>x</script>");
  });
});
