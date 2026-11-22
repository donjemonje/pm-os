/** Capability Analysis — the setup run's unify step (analysis/unify.ts): capabilities → rows, the review, features → feature rows; batches that never move; every code used exactly once. Pure module. */
import { describe, expect, it } from "vitest";
import {
  capabilityBatches,
  capabilityCode,
  checkUnified,
  companyLetter,
  featureBatches,
  featureCode,
  featureRowsOf,
  parseUnifyCapabilities,
  parseUnifyFeatures,
  parseUnifyReview,
  planUnifyReview,
  renderUnifyCapabilities,
  renderUnifyFeatures,
  renderUnifyReview,
  rowsOf,
  UNIFY_CAPABILITIES_PROMPT,
  UNIFY_CAPABILITY_BATCH,
  UNIFY_FEATURE_BATCH,
  UNIFY_FEATURES_PROMPT,
  UNIFY_MOVED_FEATURES_PROMPT,
  UNIFY_REVIEW_PROMPT,
  unifyCapabilitiesTool,
  unifyFeaturesTool,
  type UnifyCapability,
  type UnifyFeature,
  type UnifyFeatureGroup,
} from "@/lib/competitors/analysis/unify";

const COMPANIES = ["Aha", "Bagel AI", "Productboard"];
const cap = (company: number, n: number, name: string, row: { name: string; description: string } | null = null, features: string[] = []): UnifyCapability => ({
  id: `${companyLetter(company).toLowerCase()}${n}`, competitorId: `c${company}`, company: COMPANIES[company], isOwn: company === 0, code: capabilityCode(company, n - 1), name, description: `${name} does its thing.`, features, row,
});
const feat = (c: UnifyCapability, n: number, name: string, extra: Partial<UnifyFeature> = {}): UnifyFeature => ({
  id: `${c.id}.${n}`, competitorId: c.competitorId, company: c.company, isOwn: c.isOwn, code: featureCode(c.code, n - 1), name, description: `${name} in detail.`, capabilityItemId: c.id, placed: null, movedTo: null, ...extra,
});
const R = (name: string) => ({ name, description: `${name}.` });

describe("codes: short, closed, the same for the same lists", () => {
  it("a company's letter, a capability's place in its list, a feature's place under it", () => {
    expect([0, 1, 25, 26, 27].map(companyLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
    expect(capabilityCode(0, 0)).toBe("A1");
    expect(capabilityCode(2, 11)).toBe("C12");
    expect(featureCode("C12", 0)).toBe("C12.1");
  });
});

describe("A. capabilities → rows", () => {
  const caps = [cap(0, 1, "Idea portal"), cap(0, 2, "Roadmaps"), cap(1, 1, "Feedback hub"), cap(2, 1, "Insights"), cap(2, 2, "Timeline roadmap")];
  it("the batches are slices of ALL capabilities in the fixed order — placed or not — so a run that continues makes the same calls", () => {
    expect(UNIFY_CAPABILITY_BATCH).toBe(80);
    expect(capabilityBatches(caps, 2).map((b) => b.map((c) => c.code))).toEqual([["A1", "A2"], ["B1", "C1"], ["C2"]]);
    const placed = caps.map((c, i) => (i < 3 ? { ...c, row: R("Feedback Collection") } : c));
    expect(capabilityBatches(placed, 2).map((b) => b.map((c) => c.code))).toEqual([["A1", "A2"], ["B1", "C1"], ["C2"]]);
    // Companies whose capabilities fit one call are unified in ONE call.
    expect(capabilityBatches(caps)).toHaveLength(1);
  });
  it("the same capability under different names is ONE row; a capability only one company has is a row of its own", () => {
    const parsed = parseUnifyCapabilities({ rows: [
      { row: "new", name: "Customer Feedback Collection", description: "Collects feedback in one place.", capabilities: ["A1", "B1", "C1"] },
      { row: "new", name: "Product Roadmaps", description: "Shows what is built next.", capabilities: ["A2", "C2"] },
    ] }, caps, []);
    expect(parsed).toMatchObject({ problems: [], twice: [], missing: [] });
    const rows = rowsOf(caps.map((c) => ({ ...c, row: parsed.assignments.find((a) => a.itemId === c.id)!.row })));
    expect(rows.map((r) => [r.code, r.name, r.members.map((m) => m.code)])).toEqual([["R1", "Customer Feedback Collection", ["A1", "B1", "C1"]], ["R2", "Product Roadmaps", ["A2", "C2"]]]);
  });
  it("a later call puts a capability on a row that exists (its code) or makes a new one", () => {
    const soFar = rowsOf([{ ...caps[0], row: R("Feedback Collection") }, { ...caps[1], row: R("Product Roadmaps") }]);
    const parsed = parseUnifyCapabilities({ rows: [{ row: "R1", name: "", description: "", capabilities: ["B1", "C1"] }, { row: "R2", name: "", description: "", capabilities: ["C2"] }] }, caps.slice(2), soFar);
    expect(parsed.problems).toEqual([]);
    expect(parsed.assignments.map((a) => [a.itemId, a.row.name])).toEqual([["b1", "Feedback Collection"], ["c1", "Feedback Collection"], ["c2", "Product Roadmaps"]]);
  });
  it("a new row with the normalized name of a row that exists — or of an earlier new row of the answer — IS that row", () => {
    const soFar = rowsOf([{ ...caps[0], row: R("Feedback Collection") }]);
    const parsed = parseUnifyCapabilities({ rows: [{ row: "new", name: "feedback  COLLECTION", description: "again", capabilities: ["B1"] }, { row: "new", name: "Roadmaps", description: "one", capabilities: ["A2"] }, { row: "", name: "ROADMAPS", description: "two", capabilities: ["C2"] }] }, caps.slice(1), soFar);
    expect(parsed.assignments.map((a) => [a.itemId, a.row.name, a.row.description])).toEqual([["b1", "Feedback Collection", "Feedback Collection."], ["a2", "Roadmaps", "one"], ["c2", "Roadmaps", "one"]]);
  });
  it("EXACTLY ONCE — a code that was not given makes the answer unusable; a code used twice keeps its first row; a code left out is asked again", () => {
    const unknown = parseUnifyCapabilities({ rows: [{ row: "new", name: "X", description: "", capabilities: ["A1", "Z9"] }, { row: "R7", name: "", description: "", capabilities: ["A2"] }, { row: "new", name: "", description: "", capabilities: ["B1"] }] }, caps, []);
    expect(unknown.problems).toEqual(['the capability code "Z9" was not given', 'the row "R7" is neither a row that was given nor "new"', "a new row has no name"]);
    const twice = parseUnifyCapabilities({ rows: [{ row: "new", name: "X", description: "", capabilities: ["A1", "A2"] }, { row: "new", name: "Y", description: "", capabilities: ["A1", "B1"] }] }, caps, []);
    expect(twice.problems).toEqual([]);
    expect(twice.twice).toEqual(["A1"]);
    expect(twice.assignments.map((a) => [a.itemId, a.row.name])).toEqual([["a1", "X"], ["a2", "X"], ["b1", "Y"]]);
    expect(twice.missing).toEqual(["C1", "C2"]);
  });
  it("never throws on a malformed answer: everything is left out and asked again", () => {
    for (const bad of [null, "x", {}, { rows: "no" }, { rows: [null, 7, { capabilities: "A1" }] }]) expect(parseUnifyCapabilities(bad, caps, []).assignments).toEqual([]);
  });
  it("the call shows the rows so far, then the capabilities company by company — the organization marked — each with what it does and some of its features", () => {
    const text = renderUnifyCapabilities("Aha", rowsOf([{ ...caps[0], row: R("Feedback Collection") }]), [cap(1, 1, "Feedback hub", null, ["Slack intake", "Email intake"]), caps[3]]);
    expect(text).toBe([
      "THE ORGANIZATION: Aha", "",
      "ROWS SO FAR:", "R1 | Feedback Collection — Feedback Collection. | on it: Aha", "",
      "CAPABILITIES TO PLACE:",
      "COMPANY Bagel AI", "B1 | Feedback hub — Feedback hub does its thing. | features: Slack intake · Email intake", "",
      "COMPANY Productboard", "C1 | Insights — Insights does its thing.",
    ].join("\n"));
    expect(renderUnifyCapabilities("Aha", [], [caps[0]])).toContain("COMPANY Aha (the organization itself)");
    expect(renderUnifyCapabilities("Aha", [], [caps[0]])).not.toContain("ROWS SO FAR");
  });
  it("the prompt: one row per capability of the market, the market's term, every code exactly once — and the size of a row", () => {
    for (const line of ["it is ONE row", "the term the market uses for it", "Use every capability code exactly once", '"Bluetooth connection" is a capability (a row)', "Never build a wide row to hold capabilities that are different things"]) expect(UNIFY_CAPABILITIES_PROMPT).toContain(line);
    expect(JSON.stringify(unifyCapabilitiesTool(["A1", "B1"], ["R1"]))).toContain('"enum":["A1","B1"]');
  });
});

describe("B. the review — only when the rows were made in more than one call", () => {
  const rows = rowsOf([cap(0, 1, "Idea portal", R("Feedback Collection")), cap(1, 1, "Feedback hub", R("Feedback Intake")), cap(2, 1, "Roadmap", R("Product Roadmaps")), cap(2, 2, "Timeline", R("Roadmap Planning"))]);
  it("rows that are the same capability are merged into the first of them, under the name the group keeps", () => {
    const parsed = parseUnifyReview({ merge: [{ rows: ["R2", "R1"], name: "Customer Feedback Collection" }] }, rows);
    expect(parsed).toEqual({ merges: [{ keys: ["feedback collection", "feedback intake"], name: "Customer Feedback Collection" }], problems: [] });
    expect([...planUnifyReview(parsed.merges, rows)]).toEqual([["feedback collection", { name: "Customer Feedback Collection", description: "Feedback Collection." }], ["feedback intake", { name: "Customer Feedback Collection", description: "Feedback Collection." }]]);
  });
  it("a code that was not given makes the answer unusable; a row in two groups stays in the first; a group of one is no merge", () => {
    expect(parseUnifyReview({ merge: [{ rows: ["R1", "R9"], name: "X" }] }, rows).problems).toEqual(['the row code "R9" was not given']);
    expect(parseUnifyReview({ merge: [{ rows: ["R1", "R2"], name: "A" }, { rows: ["R2", "R3"], name: "B" }, { rows: ["R4"], name: "C" }] }, rows).merges).toEqual([{ keys: ["feedback collection", "feedback intake"], name: "A" }]);
  });
  it("a group that takes the name of another row joins that row too: never two rows with one name", () => {
    const plan = planUnifyReview([{ keys: ["product roadmaps", "roadmap planning"], name: "Feedback Collection" }], rows);
    expect(plan.get("product roadmaps")).toEqual({ name: "Feedback Collection", description: "Feedback Collection." });
    expect(plan.get("roadmap planning")).toEqual({ name: "Feedback Collection", description: "Feedback Collection." });
    expect(plan.has("feedback collection")).toBe(false);
  });
  it("an empty answer changes nothing", () => {
    expect(planUnifyReview(parseUnifyReview({ merge: [] }, rows).merges, rows).size).toBe(0);
    expect(UNIFY_REVIEW_PROMPT).toContain("an empty list is a correct answer");
    expect(renderUnifyReview("Aha", rows).split("\n")[3]).toBe('R1 | Feedback Collection — Feedback Collection. | Aha (the organization itself): "Idea portal"');
  });
});

describe("C. features → feature rows", () => {
  const a1 = cap(0, 1, "Integrations", R("Integrations"));
  const a2 = cap(0, 2, "AI assistant", R("AI Assistant"));
  const b1 = cap(1, 1, "Connectors", R("Integrations"));
  const b2 = cap(1, 2, "Bagel MCP", R("MCP Server"));
  const caps = [a1, a2, b1, b2];
  const rows = rowsOf(caps);
  const [integrations, assistant, mcp] = rows;
  const jira = feat(a1, 1, "Jira sync");
  const mcpServer = feat(a1, 2, "MCP server");
  const jiraB = feat(b1, 1, "Jira two-way sync");
  const chat = feat(a2, 1, "Chat with your data");
  const groups: UnifyFeatureGroup[] = [{ row: integrations, featureRows: [], entries: [jira, mcpServer, jiraB] }, { row: assistant, featureRows: [], entries: [chat] }];

  it("the batches are whole rows in table order, cut over ALL features — a run that continues makes the same calls; a row with none is in no call", () => {
    expect(UNIFY_FEATURE_BATCH).toBe(120);
    const sizes = [{ key: "r1", features: 50 }, { key: "r2", features: 60 }, { key: "r3", features: 0 }, { key: "r4", features: 30 }, { key: "r5", features: 200 }, { key: "r6", features: 5 }];
    expect(featureBatches(sizes, 120)).toEqual([["r1", "r2"], ["r4"], ["r5"], ["r6"]]);
    expect(featureBatches(sizes, 120)).toEqual(featureBatches([...sizes], 120));
    expect(featureBatches([], 120)).toEqual([]);
  });
  it("the same feature at two companies is ONE feature row with both codes", () => {
    const parsed = parseUnifyFeatures({ feature_rows: [
      { row: "R1", feature_row: "new", name: "Jira Issue Sync", description: "Keeps Jira issues and ideas in step.", features: ["A1.1", "B1.1"] },
      { row: "R2", feature_row: "new", name: "Conversational Q&A", description: "Answers questions in a chat.", features: ["A2.1"] },
    ], moved: [{ feature: "A1.2", row: "R3" }] }, groups, rows, true);
    expect(parsed).toMatchObject({ problems: [], twice: [], missing: [] });
    expect(parsed.placements.map((p) => [p.itemId, p.rowKey, p.feature.name])).toEqual([["a1.1", "integrations", "Jira Issue Sync"], ["b1.1", "integrations", "Jira Issue Sync"], ["a2.1", "ai assistant", "Conversational Q&A"]]);
  });
  it("a feature that clearly belongs to another row is handed to it — the MCP server listed under Integrations goes to the MCP row", () => {
    const parsed = parseUnifyFeatures({ feature_rows: [{ row: "R1", feature_row: "new", name: "Jira Issue Sync", description: "", features: ["A1.1", "B1.1"] }, { row: "R2", feature_row: "new", name: "Chat", description: "", features: ["A2.1"] }], moved: [{ feature: "A1.2", row: "R3" }] }, groups, rows, true);
    expect(parsed.moves).toEqual([{ itemId: "a1.2", row: { name: "MCP Server", description: "MCP Server." } }]);
    expect(mcp.code).toBe("R3");
  });
  it("inside one call a feature may be put straight under another row of the call", () => {
    const parsed = parseUnifyFeatures({ feature_rows: [{ row: "R2", feature_row: "new", name: "Assistant For Jira", description: "", features: ["A1.1"] }, { row: "R1", feature_row: "new", name: "Other", description: "", features: ["A1.2", "B1.1", "A2.1"] }], moved: [] }, groups, rows, true);
    expect(parsed.placements.find((p) => p.itemId === "a1.1")?.rowKey).toBe("ai assistant");
    expect(parsed.missing).toEqual([]);
  });
  it("a feature joins a feature row the row already has (its code), or a new one; a new one with an existing name IS that one", () => {
    const placedJira = { ...jira, placed: { row: "Integrations", name: "Jira Issue Sync", description: "Keeps Jira in step." } };
    const has = featureRowsOf(integrations, [placedJira]);
    expect(has).toEqual([{ code: "R1.F1", key: "jira issue sync", name: "Jira Issue Sync", description: "Keeps Jira in step." }]);
    const group: UnifyFeatureGroup[] = [{ row: integrations, featureRows: has, entries: [jiraB, mcpServer] }];
    const byCode = parseUnifyFeatures({ feature_rows: [{ row: "R1", feature_row: "R1.F1", name: "", description: "", features: ["B1.1"] }, { row: "R1", feature_row: "new", name: "JIRA issue  sync", description: "dup", features: ["A1.2"] }] }, group, rows, false);
    expect(byCode.problems).toEqual([]);
    expect(byCode.placements.map((p) => [p.itemId, p.feature.name, p.feature.description])).toEqual([["b1.1", "Jira Issue Sync", "Keeps Jira in step."], ["a1.2", "Jira Issue Sync", "Keeps Jira in step."]]);
  });
  it("EXACTLY ONCE — unknown codes make the answer unusable; a code used twice keeps its first place; a code left out is asked again", () => {
    const bad = parseUnifyFeatures({ feature_rows: [{ row: "R9", feature_row: "new", name: "X", description: "", features: ["A1.1"] }, { row: "R1", feature_row: "R2.F1", name: "", description: "", features: ["A1.1"] }, { row: "R1", feature_row: "new", name: "", description: "", features: ["A1.1"] }, { row: "R1", feature_row: "new", name: "Y", description: "", features: ["Q7"] }], moved: [{ feature: "A1.2", row: "R77" }] }, groups, rows, true);
    expect(bad.problems).toEqual(['the row "R9" is not one of the rows to fill', 'the feature row "R2.F1" is neither a feature row of R1 nor "new"', "a new feature row under R1 has no name", 'the feature code "Q7" was not given', 'feature A1.2 was moved to "R77", which is no row of the table']);
    const twice = parseUnifyFeatures({ feature_rows: [{ row: "R1", feature_row: "new", name: "X", description: "", features: ["A1.1", "A1.1"] }], moved: [{ feature: "A1.1", row: "R3" }] }, groups, rows, true);
    expect(twice.twice).toEqual(["A1.1"]);
    expect(twice.placements).toHaveLength(1);
    expect(twice.moves).toEqual([]);
    expect(twice.missing).toEqual(["A1.2", "B1.1", "A2.1"]);
  });
  it("the second round: a moved feature stays — an answer that moves it again places nothing, and it is asked again", () => {
    const moved = { ...mcpServer, movedTo: "MCP Server" };
    const group: UnifyFeatureGroup[] = [{ row: mcp, featureRows: [], entries: [moved] }];
    const again = parseUnifyFeatures({ feature_rows: [], moved: [{ feature: "A1.2", row: "R1" }] }, group, rows, false);
    expect(again).toMatchObject({ placements: [], moves: [], problems: [], missing: ["A1.2"] });
    expect(parseUnifyFeatures({ feature_rows: [{ row: "R3", feature_row: "new", name: "MCP Server Access", description: "", features: ["A1.2"] }] }, group, rows, false).placements).toHaveLength(1);
    // A move to a row of the very call places nothing either: it should have been put there.
    expect(parseUnifyFeatures({ feature_rows: [], moved: [{ feature: "A1.1", row: "R2" }] }, groups, rows, true)).toMatchObject({ moves: [], problems: [], missing: ["A1.1", "A1.2", "B1.1", "A2.1"] });
    expect(JSON.stringify(unifyFeaturesTool(["A1.2"], ["R3"], [], false))).not.toContain('"moved"');
    expect(JSON.stringify(unifyFeaturesTool(["A1.2"], ["R1"], ["R2", "R3"], true))).toContain('"moved"');
    expect(UNIFY_MOVED_FEATURES_PROMPT).toContain("Every feature stays under the row it is shown with");
  });
  it("the call shows all rows, then per row to fill the feature rows it has and the features to place", () => {
    const text = renderUnifyFeatures("Aha", rows, [{ row: integrations, featureRows: [{ code: "R1.F1", key: "k", name: "Jira Issue Sync", description: "Keeps Jira in step." }], entries: [jiraB] }], { allRowsShown: true });
    expect(text).toBe([
      "THE ORGANIZATION: Aha", "",
      "ALL ROWS:", "R1 | Integrations — Integrations.", "R2 | AI Assistant — AI Assistant.", "R3 | MCP Server — MCP Server.", "",
      "ROWS TO FILL:", "",
      "ROW R1 | Integrations — Integrations.", " FEATURE ROWS IT HAS:", "  R1.F1 | Jira Issue Sync — Keeps Jira in step.", " FEATURES TO PLACE:", "  B1.1 | Bagel AI | Jira two-way sync — Jira two-way sync in detail.",
    ].join("\n"));
    expect(renderUnifyFeatures("Aha", rows, [{ row: mcp, featureRows: [], entries: [mcpServer] }], { allRowsShown: false })).not.toContain("ALL ROWS");
  });
  it("the prompt: one feature row per feature, every code exactly once, and a feature may sit under another row than its own capability", () => {
    for (const line of ["is ONE feature row, with both codes", "unless it clearly belongs to another row", 'list the feature under "moved" with that row\'s code', "Use every feature code exactly once"]) expect(UNIFY_FEATURES_PROMPT).toContain(line);
  });
  it("the check before the table is built: every capability on one row, every feature on one feature row of a row that exists", () => {
    const placed = [{ ...jira, placed: { row: "Integrations", name: "Jira Issue Sync", description: "" } }, { ...mcpServer, placed: { row: "MCP Server", name: "MCP Server Access", description: "" } }];
    expect(checkUnified(caps, placed)).toEqual({ capabilitiesUnplaced: [], featuresUnplaced: [], featuresOnNoRow: [] });
    expect(checkUnified([...caps, cap(2, 1, "Loose")], [...placed, chat, { ...jiraB, placed: { row: "A Row That Is Gone", name: "X", description: "" } }])).toEqual({ capabilitiesUnplaced: ["C1"], featuresUnplaced: ["A2.1"], featuresOnNoRow: ["B1.1"] });
  });
});
