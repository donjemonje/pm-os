/** Capability Analysis — the setup run's unify step (analysis/unify.ts): the fixed order, batches, rows, the answer's closed sets, the review. Pure module. */
import { describe, expect, it } from "vitest";
import { EXCLUDED, isSettled, matchTodo, needsRepair, type MatchItem } from "@/lib/competitors/analysis/match";
import {
  nextUnifyBatch,
  orderUnifyItems,
  parseUnify,
  parseUnifyReview,
  planUnifyReview,
  renderUnify,
  renderUnifyReview,
  rowKey,
  rowsOf,
  UNIFY_BATCH,
  UNIFY_REVIEW_SYSTEM_PROMPT,
  UNIFY_SYSTEM_PROMPT,
  unifyCalls,
  unifyEntries,
  unifyReviewTool,
  unifyTool,
  type UnifyItem,
} from "@/lib/competitors/analysis/unify";

const ORDER = ["us", "en", "bg"];
const NAMES: Record<string, string> = { us: "Aha", en: "Enterpret", bg: "Bagel AI" };
const I = (id: string, competitorId: string, name: string, row: { name: string; description: string } | null = null, description: string | null = null): UnifyItem => ({
  id, competitorId, company: NAMES[competitorId], isOwn: competitorId === "us", name, description, row,
});
const ROW = (name: string, description = `${name} description.`) => ({ name, description });

describe("the fixed order of the items", () => {
  const items = [I("5", "bg", "Zapier integration"), I("2", "us", "Roadmaps"), I("4", "en", "Feedback inbox"), I("1", "us", "Idea portal"), I("3", "en", "AI summaries"), I("6", "bg", "analytics")];
  it("the own source first, then the competitors in their order; inside a company by name", () => {
    expect(orderUnifyItems(items, ORDER).map((i) => i.id)).toEqual(["1", "2", "3", "4", "6", "5"]);
  });
  it("does not depend on the order the items are loaded in", () => {
    const shuffled = [items[3], items[0], items[5], items[2], items[4], items[1]];
    expect(orderUnifyItems(shuffled, ORDER).map((i) => i.id)).toEqual(orderUnifyItems(items, ORDER).map((i) => i.id));
  });
  it("two items of one company with the same name are ordered by id", () => {
    expect(orderUnifyItems([I("b", "us", "SSO"), I("a", "us", "SSO")], ORDER).map((i) => i.id)).toEqual(["a", "b"]);
  });
  it("an item of a company that is not in the order comes last", () => {
    expect(orderUnifyItems([{ ...I("x", "zz", "Alpha"), company: "Other" }, I("1", "us", "Zeta")], ORDER).map((i) => i.id)).toEqual(["1", "x"]);
  });
});

describe("batches", () => {
  const todo = Array.from({ length: 1500 }, (_, n) => `i${n}`);
  it("a batch is the first items that are not placed, in order", () => {
    expect(nextUnifyBatch(todo)).toEqual(todo.slice(0, UNIFY_BATCH));
    expect(nextUnifyBatch(todo.slice(0, 7))).toEqual(todo.slice(0, 7));
    expect(nextUnifyBatch(todo, 3)).toEqual(["i0", "i1", "i2"]);
  });
  it("1,500 items of six companies are 25 calls of 60", () => {
    expect(UNIFY_BATCH).toBe(60);
    expect(unifyCalls(1500)).toBe(25);
    expect(unifyCalls(61)).toBe(2);
    expect(unifyCalls(0)).toBe(0);
  });
  it("entries are coded I1 … in the order of the batch", () => {
    expect(unifyEntries([I("a", "us", "A"), I("b", "en", "B")]).map((e) => [e.code, e.item.id])).toEqual([["I1", "a"], ["I2", "b"]]);
  });
});

describe("rows made so far", () => {
  const items = orderUnifyItems([
    I("1", "us", "Idea portal", ROW("Feedback Collection")),
    I("2", "us", "Roadmaps", ROW("Product Roadmaps")),
    I("3", "en", "Feedback inbox", ROW("feedback collection", "Another description.")),
    I("4", "en", "Unlimited seats"),
    I("5", "bg", "Roadmap views", ROW("Product Roadmaps")),
  ], ORDER);
  const rows = rowsOf(items);
  it("a row is identified by its normalized name; its code and its text follow from its first item in the fixed order", () => {
    expect(rows.map((r) => [r.code, r.name, r.description])).toEqual([
      ["R1", "Feedback Collection", "Feedback Collection description."],
      ["R2", "Product Roadmaps", "Product Roadmaps description."],
    ]);
    expect(rowKey("Feedback  Collection™")).toBe(rowKey("feedback collection"));
  });
  it("every company's own wording stays behind the row", () => {
    expect(rows[0].members.map((m) => [m.company, m.name, m.isOwn])).toEqual([["Aha", "Idea portal", true], ["Enterpret", "Feedback inbox", false]]);
    expect(rows[1].members.map((m) => m.id)).toEqual(["2", "5"]);
  });
  it("an item with no row is on no row", () => {
    expect(rows.flatMap((r) => r.members.map((m) => m.id))).not.toContain("4");
  });
});

describe("the row naming input", () => {
  const placed = orderUnifyItems([I("1", "us", "Idea portal", ROW("Feedback Collection", "Collects customer feedback in one place.")), I("2", "en", "Feedback inbox", ROW("Feedback Collection"))], ORDER);
  const rows = rowsOf(placed);
  const entries = unifyEntries([I("3", "bg", "Idea | intake", null, "Captures requests from Slack and email."), I("4", "us", "Roadmaps")]);
  const text = renderUnify("Aha", rows, entries);
  it("shows every row with its code, name, description and how many companies are on it", () => {
    expect(text).toContain("R1 | Feedback Collection | Collects customer feedback in one place. | 2 companies");
  });
  it("shows every entry with its code, the company, the company's own name and what it does — the organization's own entries marked", () => {
    expect(text).toContain("I1 | Bagel AI | Idea / intake | Captures requests from Slack and email.");
    expect(text).toContain("I2 | Aha (the organization itself) | Roadmaps | (the page does not say what it does)");
    expect(text).toContain("THE ORGANIZATION: Aha");
  });
  it("with no row yet it says so", () => {
    expect(renderUnify("Aha", [], entries)).toContain("ROWS SO FAR:\nnone yet");
  });
  it("the prompt asks for the market's most common term, never a brand, and names what is not a capability", () => {
    expect(UNIFY_SYSTEM_PROMPT).toContain("market's most common term");
    expect(UNIFY_SYSTEM_PROMPT).toContain("never a product, brand or marketing name");
    expect(UNIFY_SYSTEM_PROMPT).toContain("not necessarily the wording of any one company");
    expect(UNIFY_SYSTEM_PROMPT).toContain("unlimited seats");
    expect(UNIFY_SYSTEM_PROMPT).toContain("End-to-End AI Product Management Assistant");
    expect(UNIFY_SYSTEM_PROMPT).toContain("GDPR compliance");
    expect(UNIFY_REVIEW_SYSTEM_PROMPT).toContain("a buyer would list as a requirement");
  });
  it("the entry codes ride in the schema as a closed set", () => {
    const tool = unifyTool(["I1", "I2"], ["R1"]) as { input_schema: { properties: { entries: { items: { properties: { entry: { enum?: string[] } } } } } } };
    expect(tool.input_schema.properties.entries.items.properties.entry.enum).toEqual(["I1", "I2"]);
  });
});

describe("the answer of a unify call", () => {
  const rows = rowsOf(orderUnifyItems([I("1", "us", "Idea portal", ROW("Feedback Collection")), I("2", "us", "Roadmaps", ROW("Product Roadmaps"))], ORDER));
  const entries = unifyEntries([I("10", "en", "Feedback inbox"), I("11", "en", "AI summaries"), I("12", "en", "Unlimited seats"), I("13", "en", "Theme detection")]);
  const parse = (v: unknown) => parseUnify(v, entries, rows);

  it("an entry goes on a row that was given, on a row the answer creates, or on none", () => {
    const r = parse({
      rows: [{ code: "N1", name: "AI Feedback Summaries", description: "Summarizes feedback with AI." }],
      entries: [{ entry: "I1", row: "R1" }, { entry: "I2", row: "N1" }, { entry: "I3", row: "none" }, { entry: "I4", row: "N1" }],
    });
    expect(r.problems).toEqual([]);
    expect(r.assignments).toEqual([
      { itemId: "10", row: { name: "Feedback Collection", description: "Feedback Collection description." } },
      { itemId: "11", row: { name: "AI Feedback Summaries", description: "Summarizes feedback with AI." } },
      { itemId: "12", row: null },
      { itemId: "13", row: { name: "AI Feedback Summaries", description: "Summarizes feedback with AI." } },
    ]);
  });
  it("an entry code that was not asked makes the answer unusable", () => {
    const r = parse({ rows: [], entries: [{ entry: "I1", row: "R1" }, { entry: "I9", row: "R1" }] });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("I9");
  });
  it("a row code that was neither given nor created in the answer makes the answer unusable", () => {
    expect(parse({ rows: [], entries: [{ entry: "I1", row: "R7" }] }).problems[0]).toContain("R7");
    expect(parse({ rows: [], entries: [{ entry: "I1", row: "N1" }] }).problems[0]).toContain("N1");
    expect(parse({ rows: [], entries: [{ entry: "I1", row: "Feedback Collection" }] }).problems).toHaveLength(1);
  });
  it("a new row needs a code of its own kind and a name", () => {
    expect(parse({ rows: [{ code: "R9", name: "X", description: "" }], entries: [] }).problems[0]).toContain("R9");
    expect(parse({ rows: [{ code: "N1", name: "  ", description: "d" }], entries: [] }).problems[0]).toContain("no name");
    expect(parse({ rows: [{ code: "N1", name: "A", description: "" }, { code: "N1", name: "B", description: "" }], entries: [] }).problems[0]).toContain("twice");
  });
  it("a new row with the normalized name of a row that exists IS that row", () => {
    const r = parse({ rows: [{ code: "N1", name: "feedback   collection", description: "Other words." }], entries: [{ entry: "I1", row: "N1" }] });
    expect(r.problems).toEqual([]);
    expect(r.assignments[0].row).toEqual({ name: "Feedback Collection", description: "Feedback Collection description." });
  });
  it("two new rows with the same normalized name are one row: the first", () => {
    const r = parse({
      rows: [{ code: "N1", name: "Theme Detection", description: "First." }, { code: "N2", name: "theme detection", description: "Second." }],
      entries: [{ entry: "I2", row: "N1" }, { entry: "I4", row: "N2" }],
    });
    expect(r.assignments.map((a) => a.row)).toEqual([{ name: "Theme Detection", description: "First." }, { name: "Theme Detection", description: "First." }]);
  });
  it("an entry answered twice keeps its first answer; an entry left out is not in the result", () => {
    const r = parse({ rows: [], entries: [{ entry: "I1", row: "R1" }, { entry: "I1", row: "R2" }] });
    expect(r.problems).toEqual([]);
    expect(r.assignments).toEqual([{ itemId: "10", row: { name: "Feedback Collection", description: "Feedback Collection description." } }]);
  });
  it("a new row no entry was put on is dropped and counted", () => {
    const r = parse({ rows: [{ code: "N1", name: "Orphan", description: "" }], entries: [{ entry: "I1", row: "R1" }] });
    expect(r.unusedRows).toBe(1);
    expect(r.assignments).toHaveLength(1);
  });
  it("an empty row is none; an empty answer places nothing", () => {
    expect(parse({ rows: [], entries: [{ entry: "I3", row: "" }] }).assignments).toEqual([{ itemId: "12", row: null }]);
    expect(parse({}).assignments).toEqual([]);
    expect(parse(null).problems).toEqual([]);
  });
});

describe("an item that is no capability", () => {
  const item = (over: Partial<MatchItem>): MatchItem => ({ id: "i", kind: "capability", key: "c:x", parentItemId: null, capabilityId: null, featureId: null, placement: null, matchedBy: null, matchedAt: null, ...over });
  it("is a saved decision: settled, never repaired, never asked again", () => {
    const excluded = item({ matchedBy: EXCLUDED, matchedAt: new Date() });
    expect(isSettled(excluded)).toBe(true);
    expect(needsRepair(excluded)).toBe(false);
    expect(matchTodo([excluded])).toEqual([]);
  });
  it("an item whose row was erased is still repaired", () => {
    expect(needsRepair(item({ matchedBy: "ai", matchedAt: new Date() }))).toBe(true);
  });
});

describe("the review of all rows", () => {
  const rows = rowsOf(orderUnifyItems([
    I("1", "us", "Enterprise security", ROW("Enterprise Security and Compliance", "Keeps data safe.")),
    I("2", "us", "GDPR", ROW("GDPR Compliance", "Meets GDPR.")),
    I("3", "en", "Security controls", ROW("Operational Security and Compliance Controls", "Controls.")),
    I("4", "en", "CCPA", ROW("CCPA Compliance", "Meets CCPA.")),
    I("5", "en", "The AI assistant", ROW("End-to-End AI Product Management Assistant", "Everything.")),
    I("6", "bg", "Idea Box", ROW("Idea Box", "Collects ideas.")),
    I("7", "bg", "GDPR + CCPA", ROW("GDPR and CCPA Compliance", "Both.")),
  ], ORDER));
  // In the fixed order (the own source first; inside a company by name):
  // R1 Enterprise…, R2 GDPR, R3 CCPA, R4 Operational…, R5 End-to-End…, R6 GDPR and CCPA, R7 Idea Box
  const key = (code: string) => rows.find((r) => r.code === code)!.key;

  it("the rows are coded in the fixed order of their first item", () => {
    expect(rows.map((r) => `${r.code} ${r.name}`)).toEqual([
      "R1 Enterprise Security and Compliance", "R2 GDPR Compliance", "R3 CCPA Compliance", "R4 Operational Security and Compliance Controls",
      "R5 End-to-End AI Product Management Assistant", "R6 GDPR and CCPA Compliance", "R7 Idea Box",
    ]);
  });
  it("renders every row with what each company calls it", () => {
    const text = renderUnifyReview("Aha", rows);
    expect(text).toContain('R1 | Enterprise Security and Compliance | Keeps data safe. | Aha (the organization itself): "Enterprise security"');
    expect(text).toContain('R4 | Operational Security and Compliance Controls | Controls. | Enterpret: "Security controls"');
    const tool = unifyReviewTool(rows.map((r) => r.code)) as { input_schema: { properties: { drop: { items: { enum?: string[] } } } } };
    expect(tool.input_schema.properties.drop.items.enum).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  });
  it("near-duplicate rows are merged into the first of them, an umbrella row is dropped, a brand name is renamed", () => {
    const parsed = parseUnifyReview({
      merge: [{ rows: ["R4", "R1"], name: "Security and Compliance" }, { rows: ["R2", "R3", "R6"], name: "Privacy Regulation Compliance" }],
      drop: ["R5"],
      rename: [{ row: "R7", name: "Idea Management" }],
    }, rows);
    expect(parsed.problems).toEqual([]);
    expect(parsed.merges).toEqual([
      { keys: [key("R1"), key("R4")], name: "Security and Compliance" },
      { keys: [key("R2"), key("R3"), key("R6")], name: "Privacy Regulation Compliance" },
    ]);
    const plan = planUnifyReview(parsed, rows);
    expect(plan.get(key("R1"))).toEqual({ name: "Security and Compliance", description: "Keeps data safe." });
    expect(plan.get(key("R4"))).toEqual({ name: "Security and Compliance", description: "Keeps data safe." });
    expect(plan.get(key("R2"))).toEqual({ name: "Privacy Regulation Compliance", description: "Meets GDPR." });
    expect(plan.get(key("R3"))).toEqual({ name: "Privacy Regulation Compliance", description: "Meets GDPR." });
    expect(plan.get(key("R6"))).toEqual({ name: "Privacy Regulation Compliance", description: "Meets GDPR." });
    expect(plan.get(key("R5"))).toBeNull();
    expect(plan.get(key("R7"))).toEqual({ name: "Idea Management", description: "Collects ideas." });
  });
  it("a row code that was not given makes the answer unusable", () => {
    expect(parseUnifyReview({ merge: [{ rows: ["R1", "R99"], name: "" }], drop: [], rename: [] }, rows).problems[0]).toContain("R99");
    expect(parseUnifyReview({ merge: [], drop: ["X"], rename: [] }, rows).problems).toHaveLength(1);
    expect(parseUnifyReview({ merge: [], drop: [], rename: [{ row: "R0", name: "A" }] }, rows).problems).toHaveLength(1);
  });
  it("rows the review does not name stay as they are; an empty answer changes nothing", () => {
    expect(planUnifyReview(parseUnifyReview({ merge: [], drop: [], rename: [] }, rows), rows).size).toBe(0);
    expect(planUnifyReview(parseUnifyReview({ merge: [{ rows: ["R1", "R4"], name: "" }], drop: [], rename: [] }, rows), rows).has(key("R7"))).toBe(false);
  });
  it("a merge with no name keeps the first row's name", () => {
    const plan = planUnifyReview(parseUnifyReview({ merge: [{ rows: ["R4", "R1"], name: "" }], drop: [], rename: [] }, rows), rows);
    expect(plan.has(key("R1"))).toBe(false);
    expect(plan.get(key("R4"))).toEqual({ name: "Enterprise Security and Compliance", description: "Keeps data safe." });
  });
  it("a dropped row leaves every other list; a row stays in its first merge group; a group of one is no merge", () => {
    const parsed = parseUnifyReview({ merge: [{ rows: ["R1", "R5"], name: "A" }, { rows: ["R2", "R3"], name: "B" }, { rows: ["R3", "R6"], name: "C" }], drop: ["R5"], rename: [{ row: "R5", name: "Z" }, { row: "R2", name: "Y" }] }, rows);
    expect(parsed.merges).toEqual([{ keys: [key("R2"), key("R3")], name: "B" }]);
    expect(parsed.drops).toEqual([key("R5")]);
    expect(parsed.renames).toEqual([]);
  });
  it("a new name that is another row's name joins the two rows: the earlier row stays", () => {
    // The later row takes the earlier row's name: it joins it, and the earlier row is unchanged.
    const plan = planUnifyReview(parseUnifyReview({ merge: [], drop: [], rename: [{ row: "R6", name: "gdpr compliance" }] }, rows), rows);
    expect(plan.get(key("R6"))).toEqual({ name: "GDPR Compliance", description: "Meets GDPR." });
    expect(plan.has(key("R2"))).toBe(false);
    // The earlier row takes the later row's name: the later row joins it under that name.
    const up = planUnifyReview(parseUnifyReview({ merge: [], drop: [], rename: [{ row: "R2", name: "CCPA Compliance" }] }, rows), rows);
    expect(up.get(key("R2"))).toEqual({ name: "CCPA Compliance", description: "Meets GDPR." });
    expect(up.get(key("R3"))).toEqual({ name: "CCPA Compliance", description: "Meets GDPR." });
  });
  it("the result never holds two rows with one name", () => {
    const parsed = parseUnifyReview({ merge: [{ rows: ["R1", "R4"], name: "Compliance" }, { rows: ["R2", "R3"], name: "compliance" }], drop: [], rename: [{ row: "R6", name: "COMPLIANCE" }] }, rows);
    const plan = planUnifyReview(parsed, rows);
    const after = rows.map((r) => (plan.has(r.key) ? plan.get(r.key) : { name: r.name, description: r.description })).filter((r): r is { name: string; description: string } => r != null);
    const names = new Map<string, Set<string>>();
    for (const r of after) names.set(rowKey(r.name), (names.get(rowKey(r.name)) ?? new Set()).add(r.name));
    for (const spellings of names.values()) expect(spellings.size).toBe(1);
    expect(plan.get(key("R6"))).toEqual({ name: "Compliance", description: "Keeps data safe." });
  });
});
