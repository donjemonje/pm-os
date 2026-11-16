/**
 * Capability Analysis — the setup run composed, as analysis/setup.ts drives it: every company's list → unify
 * (capabilities in batches against the rows so far, the review, the features with a move) → domains → the catalog →
 * the cells by the cell rule. And the two paths: the setup run, and a run of one company after setup.
 * Pure modules only: what a call "saves" here is what the step saves on the items — an item's row.
 */
import { describe, expect, it } from "vitest";
import { cellFromEvidence, evidenceByRow, type Evidence, type RowFinding } from "@/lib/competitors/analysis/cells";
import { knownDomains, parseDomains, planCatalog, rowsWithoutDomain, type DomainDraft, type DomainsRow } from "@/lib/competitors/analysis/domains";
import { analysisPath, SETUP_PATH } from "@/lib/competitors/analysis/setup-rules";
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
  rowKey,
  rowsOf,
  type UnifyCapability,
  type UnifyFeature,
  type UnifyFeatureGroup,
  type UnifyRow,
} from "@/lib/competitors/analysis/unify";

const COMPANIES = ["Aha", "Productboard", "Bagel AI"];
/** Each company's list, as its reading made it: capabilities, and the features under each. */
const LISTS: Array<Array<[string, string[]]>> = [
  [["Idea portal", ["Voting"]], ["Roadmaps", ["Gantt view"]]],
  [["Insights", ["Feedback forms", "Votes"]], ["Integrations", ["Jira sync", "MCP server"]]],
  [["Feedback hub", []], ["Bagel MCP", ["MCP for coding agents"]]],
];
const capabilities: UnifyCapability[] = [];
const features: UnifyFeature[] = [];
LISTS.forEach((list, c) => list.forEach(([name, feats], k) => {
  const cap: UnifyCapability = { id: `${companyLetter(c)}${k + 1}`.toLowerCase(), competitorId: `c${c}`, company: COMPANIES[c], isOwn: c === 0, code: capabilityCode(c, k), name, description: `${name}.`, features: feats, row: null };
  capabilities.push(cap);
  feats.forEach((f, j) => features.push({ id: `${cap.id}.${j + 1}`, competitorId: cap.competitorId, company: cap.company, isOwn: cap.isOwn, code: featureCode(cap.code, j), name: f, description: `${f}.`, capabilityItemId: cap.id, placed: null, movedTo: null }));
}));
const place = (itemId: string, row: { name: string; description: string }) => { capabilities.find((c) => c.id === itemId)!.row = row; };

describe("unify → review → features → domains → catalog → cells", () => {
  it("A. capabilities, in batches of the fixed order, each against the rows the calls before it made", () => {
    const batches = capabilityBatches(capabilities, 4);
    expect(batches.map((b) => b.map((c) => c.code))).toEqual([["A1", "A2", "B1", "B2"], ["C1", "C2"]]);
    const answers = [
      { rows: [{ row: "new", name: "Feedback Collection", description: "Collects feedback in one place.", capabilities: ["A1", "B1"] }, { row: "new", name: "Product Roadmaps", description: "Shows what is built next.", capabilities: ["A2"] }, { row: "new", name: "Integrations", description: "Connects other tools.", capabilities: ["B2"] }] },
      { rows: [{ row: "new", name: "Feedback Intake", description: "Takes feedback in.", capabilities: ["C1"] }, { row: "new", name: "MCP Server", description: "Serves product context to AI agents.", capabilities: ["C2"] }] },
    ];
    batches.forEach((batch, n) => {
      const parsed = parseUnifyCapabilities(answers[n], batch.filter((c) => !c.row), rowsOf(capabilities));
      expect(parsed).toMatchObject({ problems: [], twice: [], missing: [] });
      for (const a of parsed.assignments) place(a.itemId, a.row);
    });
    expect(rowsOf(capabilities).map((r) => [r.code, r.name, r.members.map((m) => m.code)])).toEqual([["R1", "Feedback Collection", ["A1", "B1"]], ["R2", "Product Roadmaps", ["A2"]], ["R3", "Integrations", ["B2"]], ["R4", "Feedback Intake", ["C1"]], ["R5", "MCP Server", ["C2"]]]);
  });
  it("B. the review (the capabilities took two calls): the same capability made in two calls becomes one row", () => {
    const rows = rowsOf(capabilities);
    const parsed = parseUnifyReview({ merge: [{ rows: ["R1", "R4"], name: "Customer Feedback Collection" }] }, rows);
    expect(parsed.problems).toEqual([]);
    for (const [key, after] of planUnifyReview(parsed.merges, rows)) for (const m of rows.find((r) => r.key === key)!.members) place(m.id, after);
    expect(rowsOf(capabilities).map((r) => [r.code, r.name, r.members.map((m) => m.code)])).toEqual([["R1", "Customer Feedback Collection", ["A1", "B1", "C1"]], ["R2", "Product Roadmaps", ["A2"]], ["R3", "Integrations", ["B2"]], ["R4", "MCP Server", ["C2"]]]);
  });
  it("C. the features: per batch of rows; a feature that belongs to another row is moved there and placed in the second round", () => {
    const rows = rowsOf(capabilities);
    const rowOf = (f: UnifyFeature): UnifyRow => (f.movedTo ? rows.find((r) => r.key === rowKey(f.movedTo!))! : rows.find((r) => r.members.some((m) => m.id === f.capabilityItemId))!);
    const groupsOf = (keys: string[], moved: boolean): UnifyFeatureGroup[] => keys.map((k) => rows.find((r) => r.key === k)!).map((row) => ({ row, featureRows: featureRowsOf(row, features), entries: features.filter((f) => !f.placed && (moved ? f.movedTo != null : f.movedTo == null) && rowOf(f).key === row.key) })).filter((g) => g.entries.length);
    const save = (parsed: ReturnType<typeof parseUnifyFeatures>) => {
      expect(parsed).toMatchObject({ problems: [], twice: [], missing: [] });
      for (const p of parsed.placements) Object.assign(features.find((f) => f.id === p.itemId)!, { placed: { row: p.row.name, name: p.feature.name, description: p.feature.description }, movedTo: null });
      for (const m of parsed.moves) features.find((f) => f.id === m.itemId)!.movedTo = m.row.name;
    };
    // Round 1: whole rows, 4 features per call.
    const batches = featureBatches(rows.map((r) => ({ key: r.key, features: features.filter((f) => rows.find((x) => x.members.some((m) => m.id === f.capabilityItemId))!.key === r.key).length })), 4);
    expect(batches).toEqual([[rows[0].key, rows[1].key], [rows[2].key, rows[3].key]]);
    save(parseUnifyFeatures({ feature_rows: [
      { row: "R1", feature_row: "new", name: "Feedback Voting", description: "Lets customers vote on ideas.", features: ["A1.1", "B1.2"] },
      { row: "R1", feature_row: "new", name: "Feedback Forms", description: "Forms that take feedback in.", features: ["B1.1"] },
      { row: "R2", feature_row: "new", name: "Gantt Roadmap View", description: "Shows the roadmap on a timeline.", features: ["A2.1"] },
    ], moved: [] }, groupsOf(batches[0], false), rows, true));
    // Productboard lists its MCP server under Integrations; the MCP row is in the same call, so it is put straight under it.
    save(parseUnifyFeatures({ feature_rows: [
      { row: "R3", feature_row: "new", name: "Jira Issue Sync", description: "Keeps Jira issues in step.", features: ["B2.1"] },
      { row: "R4", feature_row: "new", name: "MCP Server For AI Agents", description: "Lets AI agents read product context.", features: ["B2.2", "C2.1"] },
    ], moved: [] }, groupsOf(batches[1], false), rows, true));
    expect(checkUnified(capabilities, features)).toEqual({ capabilitiesUnplaced: [], featuresUnplaced: [], featuresOnNoRow: [] });
    expect(featureRowsOf(rows[3], features).map((f) => f.name)).toEqual(["MCP Server For AI Agents"]);
    expect(features.find((f) => f.code === "B2.2")?.placed?.row).toBe("MCP Server");
  });
  it("D. the domains: every row in exactly one, then the catalog in its stable order", () => {
    const rows: DomainsRow[] = rowsOf(capabilities).map((r) => {
      const under = features.filter((f) => f.placed && rowKey(f.placed.row) === r.key);
      const companies = [...r.members, ...under].map((m) => ({ name: m.company, isOwn: m.isOwn })).filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i);
      return { code: r.code, key: r.key, name: r.name, description: r.description, companies, ownNames: r.members.filter((m) => m.isOwn).map((m) => m.name), features: featureRowsOf(r, features).map((f) => f.name), ours: companies.some((c) => c.isOwn) };
    });
    const drafts: DomainDraft[] = [];
    const parsed = parseDomains({ domains: [{ code: "D1", name: "Customer Feedback", definition: "Collecting what customers ask for." }, { code: "D2", name: "Planning", definition: "Deciding and showing what is built." }, { code: "D3", name: "Integrations & Extensibility", definition: "Connecting other tools and agents." }], rows: [{ row: "R1", domain: "D1" }, { row: "R2", domain: "D2" }, { row: "R3", domain: "D3" }, { row: "R4", domain: "D3" }] }, rows, knownDomains(drafts));
    expect(parsed.problems).toEqual([]);
    expect(rowsWithoutDomain(rows, parsed.assigned)).toEqual([]);
    const catalog = planCatalog(rows, parsed.assigned, parsed.created);
    expect(catalog.map((d) => [d.name, d.position, d.rows.map((r) => `${r.position}:${r.row.name}`)])).toEqual([
      ["Customer Feedback", 0, ["0:Customer Feedback Collection"]],
      ["Planning", 1, ["1:Product Roadmaps"]],
      ["Integrations & Extensibility", 2, ["2:Integrations", "3:MCP Server"]],
    ]);
    // The organization has a row when its own capability is on it or any feature of its own is under it.
    expect(rows.map((r) => [r.name, r.ours])).toEqual([["Customer Feedback Collection", true], ["Product Roadmaps", true], ["Integrations", false], ["MCP Server", false]]);
    // Productboard has the MCP row through its feature alone — its own capability is on the Integrations row.
    expect(rows[3].companies.map((c) => c.name)).toEqual(["Bagel AI", "Productboard"]);
  });
  it("E. the cells: a company has a row when its own capability is on it OR any feature under it; features get a mark per company", () => {
    const e = (id: string): Evidence => ({ findingId: id, pageUrl: `https://x.example/${id}`, tier: "strong", pageKind: "docs", origin: "reading", quote: `quote of ${id}`, reasoning: "", wording: id, description: null });
    // Productboard's items after the catalog: Insights → Feedback row; Integrations → Integrations row; its MCP server → the feature row under MCP Server.
    const productboard: RowFinding[] = [
      { evidence: e("b1"), item: { capabilityId: "row-feedback", featureId: null }, lookCapabilityId: null },
      { evidence: e("b2"), item: { capabilityId: "row-integrations", featureId: null }, lookCapabilityId: null },
      { evidence: e("b2.2"), item: { capabilityId: null, featureId: "fr-mcp-agents" }, lookCapabilityId: null },
    ];
    const cells = evidenceByRow(productboard, new Map([["fr-mcp-agents", "row-mcp"], ["fr-gantt", "row-roadmaps"]]));
    expect(cellFromEvidence(cells.byCapability.get("row-feedback") ?? []).value).toBe("found");
    expect(cellFromEvidence(cells.byCapability.get("row-mcp") ?? [])).toMatchObject({ value: "found", best: { findingId: "b2.2" } });
    expect(cellFromEvidence(cells.byCapability.get("row-roadmaps") ?? []).value).toBe("not_found");
    expect(cellFromEvidence(cells.byFeature.get("fr-mcp-agents") ?? []).value).toBe("found");
    expect(cellFromEvidence(cells.byFeature.get("fr-gantt") ?? []).value).toBe("not_found");
  });
});

describe("the two paths", () => {
  it("the setup run: every company is mapped and read, then ONE unify and ONE domains step for all, then the table is filled — the own site first", () => {
    expect([...SETUP_PATH]).toEqual(["map", "reading", "unify", "domains", "apply (the own site: OUR column)", "second_look", "apply"]);
    expect(SETUP_PATH).not.toContain("match");
    for (const gone of ["research", "merge", "go_back", "facts"]) expect(SETUP_PATH).not.toContain(gone);
  });
  it("after setup, a run of one company: map → reading of what is new or changed → match to the rows that exist → second look → fill. No profile-facts step: the run is about the table", () => {
    expect([...analysisPath("done", false)]).toEqual(["map", "reading", "match", "second_look", "apply"]);
    for (const state of ["required", "in_setup", "done"] as const) for (const own of [true, false]) expect(analysisPath(state, own)).not.toContain("facts");
    expect(analysisPath("done", false)).not.toContain("unify");
    expect(analysisPath("done", false)).not.toContain("domains");
  });
  it("after setup, the organization's own site: no second look — what its items say is ours", () => {
    expect([...analysisPath("done", true)]).toEqual(["map", "reading", "match", "apply"]);
  });
  it("before setup is done a run of one company stops after the reading: its list is ready, no row is created", () => {
    for (const state of ["required", "in_setup"] as const) {
      expect([...analysisPath(state, false)]).toEqual(["map", "reading"]);
      expect([...analysisPath(state, true)]).toEqual(["map", "reading"]);
    }
  });
});
