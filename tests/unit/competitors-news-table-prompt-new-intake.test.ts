/** News Feed & Notifications — the prompt that places a newly found feature in the table: its shared rule text, its request, its answer form and its parser. */
import { describe, expect, it } from "vitest";
import {
  blocksOf,
  BUILD_DOMAIN_PROMPT,
  CAPABILITY_BORDERS,
  CAPABILITY_FIELDS,
  COVERAGE_SCORE,
  DOMAIN_HOW_TO_DECIDE,
  FEATURE_ROW_IS,
  NOT_A_ROW,
  promptText,
  SORT_FEATURES_PROMPT,
} from "@/lib/competitors/prompts/blocks";
import {
  parseTableNewIntake,
  renderTableNewIntake,
  TABLE_CHANGES,
  TABLE_NEW_INTAKE_PROMPT,
  TABLE_NEW_INTAKE_SYSTEM_PROMPT,
  tableNewIntakeTool,
  type TableForCompany,
  type TableNewFeature,
} from "@/lib/competitors/news/table-prompt-new-intake";

const table: TableForCompany = {
  market: "Product management software",
  company: "Acme",
  domains: [
    {
      name: "Discovery & Ideation",
      covers: "Interviews, requests and ideas.",
      who: "Product managers and researchers.",
      capabilities: [
        {
          code: "C1", name: "Feedback collection", covers: "Bringing requests in from every channel.", score: 3, reasoning: "Covers forms and email, no in-app surveys.",
          others: [{ company: "Own", score: 4 }, { company: "Beta", score: null }],
          rows: [
            { code: "C1.1", name: "Collect requests through a public form", problem: "Without it, requests arrive by email.", has: true },
            { code: "C1.2", name: "Ask users a question inside the product", problem: "Without it, feedback comes long after use.", has: false },
          ],
        },
        {
          code: "C2", name: "Interview research", covers: "Running and mining customer interviews.", score: 0, reasoning: "",
          others: [{ company: "Own", score: 2 }],
          rows: ["a", "b", "c", "d", "e"].map((x, i) => ({ code: `C2.${i + 1}`, name: `Row ${x}`, problem: "Without it, nothing.", has: false })),
        },
      ],
    },
    { name: "Strategy & Prioritization", covers: "Deciding what to do next.", who: "Product leaders.", capabilities: [{ code: "C3", name: "Scoring", covers: "Ranking work by value.", score: 5, reasoning: "Full.", others: [], rows: [] }] },
  ],
};
const feature = (code: string): TableNewFeature => ({ code, name: `Feature ${code}`, problem: "Without it, a problem.", howItWorks: "It does a thing.", users: "Product manager (person)", workflows: "1. plan the quarter — rank the requests" });
const features = ["N1", "N2", "N3", "N4", "N5", "N6", "N7"].map(feature);
const answer = (over: Record<string, unknown>) => ({
  feature: "N1", domain: "Discovery & Ideation", reason: "Collecting feedback.", capability: "C1", change: "none", change_detail: "none", capability_name: "none", capability_covers: "none",
  row: "none", row_replaces: "none", row_name: "none", row_problem: "none", score: 3, reasoning: "Still mid.", why: "It is feedback collection, not interviews.", ...over,
});

describe("the table prompt for a new feature is built from the blocks that build the table", () => {
  it("uses the build-the-domain and the sort blocks — the same objects, never a copy", () => {
    const mine = blocksOf(TABLE_NEW_INTAKE_PROMPT).map((b) => b.name);
    const build = new Set(blocksOf(BUILD_DOMAIN_PROMPT).map((b) => b.name));
    const sort = new Set(blocksOf(SORT_FEATURES_PROMPT).map((b) => b.name));
    for (const name of mine) expect(build.has(name) || sort.has(name), name).toBe(true);
    for (const b of [DOMAIN_HOW_TO_DECIDE, CAPABILITY_BORDERS, CAPABILITY_FIELDS, FEATURE_ROW_IS, NOT_A_ROW, COVERAGE_SCORE]) {
      expect(mine).toContain(b.name);
      expect(TABLE_NEW_INTAKE_SYSTEM_PROMPT).toContain(b.text);
    }
  });
  it("most of its text is shared: its own lines are the smaller part", () => {
    const shared = blocksOf(TABLE_NEW_INTAKE_PROMPT).reduce((n, b) => n + b.text.length, 0);
    expect(shared).toBeGreaterThan(promptText(TABLE_NEW_INTAKE_PROMPT).length / 2);
  });
  it("names every change the answer may ask for", () => {
    for (const c of TABLE_CHANGES.filter((x) => x !== "none")) expect(TABLE_NEW_INTAKE_SYSTEM_PROMPT).toContain(`"${c}"`);
  });
});

describe("the request shows the table as this company stands on it", () => {
  const text = renderTableNewIntake(features.slice(0, 1), table);
  it("the market, the domains with who does the work, the company", () => {
    expect(text).toContain("THE MARKET\nProduct management software");
    expect(text).toContain("Discovery & Ideation — Interviews, requests and ideas.\nWho does the work: Product managers and researchers.");
    expect(text).toContain("THE COMPANY\nAcme");
  });
  it("each capability with this company's score and the others', each row with has it / not found", () => {
    expect(text).toContain("C1 | Feedback collection");
    expect(text).toContain("Acme: 3/5 — Covers forms and email, no in-app surveys.");
    expect(text).toContain("The other companies: Own 4/5 · Beta no score");
    expect(text).toContain("C1.1 | Collect requests through a public form — Problem: Without it, requests arrive by email. — Acme: has it");
    expect(text).toContain("C1.2 | Ask users a question inside the product — Problem: Without it, feedback comes long after use. — Acme: not found");
  });
  it("a new feature in the form of a feature of a company's list", () => {
    expect(text).toContain("THE NEW FEATURES OF ACME (1)\nN1 | Feature N1\n   Problem: Without it, a problem.\n   How it works: It does a thing.\n   Users: Product manager (person)\n   Workflows: 1. plan the quarter — rank the requests");
  });
  it("says when the market is not recorded", () => {
    expect(renderTableNewIntake(features.slice(0, 1), { ...table, market: "" })).toContain("THE MARKET\n(not recorded)");
  });
});

describe("the answer form is strict", () => {
  const item = (tableNewIntakeTool(features.map((f) => f.code), table).input_schema as { properties: { features: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } }).properties.features.items;
  it("every field is required", () => {
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });
  it("codes and names are closed sets, with none and new", () => {
    expect(item.properties.feature.enum).toEqual(features.map((f) => f.code));
    expect(item.properties.domain.enum).toEqual(["Discovery & Ideation", "Strategy & Prioritization", "none"]);
    expect(item.properties.capability.enum).toEqual(["C1", "C2", "C3", "new", "none"]);
    expect(item.properties.row.enum).toEqual(["C1.1", "C1.2", "C2.1", "C2.2", "C2.3", "C2.4", "C2.5", "new", "none"]);
    expect(item.properties.row_replaces.enum).not.toContain("new");
    expect(item.properties.change.enum).toEqual([...TABLE_CHANGES]);
  });
});

describe("the answer is checked against the closed sets and against itself", () => {
  const parse = (...list: Array<Record<string, unknown>>) => parseTableNewIntake({ features: list }, features, table);
  it("an existing row the company lacked: it fills the not found", () => {
    const { decisions } = parse(answer({ row: "C1.2", score: 4, reasoning: "Now also asks inside the product." }));
    expect(decisions[0]).toMatchObject({ feature: "N1", capability: "C1", row: "C1.2", place: "row", fillsNotFound: true, score: 4, change: "none", changeDetail: "", warnings: [] });
  });
  it("an existing row the company already has fills nothing", () => {
    expect(parse(answer({ row: "C1.1" })).decisions[0]).toMatchObject({ place: "row", fillsNotFound: false });
  });
  it("no row: it only counts in the coverage", () => {
    expect(parse(answer({})).decisions[0]).toMatchObject({ place: "coverage", row: "none", rowName: "" });
  });
  it("a new row needs its name and problem; in a full capability it says which row it replaces", () => {
    const ok = parse(answer({ feature: "N2", capability: "C2", row: "new", row_name: "Record customer calls", row_problem: "Without it, notes are copied by hand.", row_replaces: "C2.5", score: 2, reasoning: "One of five." }));
    expect(ok.decisions[0]).toMatchObject({ place: "new_row", rowReplaces: "C2.5", rowName: "Record customer calls", warnings: [] });
    const noReplace = parse(answer({ feature: "N2", capability: "C2", row: "new", row_name: "Record customer calls", row_problem: "Notes are copied by hand.", score: 2, reasoning: "One." }));
    expect(noReplace.decisions[0].warnings.join(" | ")).toMatch(/already has 5 rows/);
    expect(noReplace.decisions[0].warnings.join(" | ")).toMatch(/Without it,/);
    expect(parse(answer({ row: "new" })).decisions).toHaveLength(0);
  });
  it("a new capability goes with the change of that name, and brings its name and what it covers", () => {
    const ok = parse(answer({ capability: "new", change: "new capability", change_detail: "Surveys inside the product are a part of the work no capability covers.", capability_name: "In-product surveys", capability_covers: "Asking users at the moment of use.", score: 5, reasoning: "Alone in it." }));
    expect(ok.decisions[0]).toMatchObject({ capability: "new", change: "new capability", capabilityName: "In-product surveys", place: "coverage" });
    expect(parse(answer({ capability: "new" })).dropped).toBe(1);
    expect(parse(answer({ change: "new capability", change_detail: "x", capability_name: "A", capability_covers: "B" })).dropped).toBe(1);
  });
  it("a wording change keeps the capability and brings the new wording; a split brings its detail", () => {
    const reword = parse(answer({ change: "capability wording", change_detail: "Add surveys to what it covers.", capability_name: "Feedback collection", capability_covers: "Requests and survey answers from every channel." }));
    expect(reword.decisions[0]).toMatchObject({ capability: "C1", change: "capability wording", capabilityCovers: "Requests and survey answers from every channel." });
    const split = parse(answer({ change: "split capability", change_detail: "Split into asking users and receiving requests." }));
    expect(split.decisions[0]).toMatchObject({ change: "split capability", capabilityName: "" });
    expect(parse(answer({ change: "split capability" })).dropped).toBe(1);
  });
  it("not in the table: no domain — or a domain and no capability", () => {
    const none = parse(answer({ domain: "none", capability: "none", score: 0, reasoning: "none" }));
    expect(none.decisions[0]).toMatchObject({ place: "out", domain: "none", capability: "none", score: 0 });
    const newDomain = parse(answer({ domain: "none", capability: "none", change: "new domain", change_detail: "Billing is an area no domain covers.", score: 0 }));
    expect(newDomain.decisions[0]).toMatchObject({ place: "out", change: "new domain" });
    const small = parse(answer({ capability: "none", score: 0 }));
    expect(small.decisions[0]).toMatchObject({ place: "out", domain: "Discovery & Ideation" });
  });
  it("drops what contradicts itself or names something that was not given", () => {
    const { decisions, dropped, unanswered } = parse(
      answer({ feature: "N9" }), // not a feature given
      answer({ feature: "N1", domain: "Delivery" }), // not a domain given
      answer({ feature: "N2", capability: "C3" }), // a capability of another domain
      answer({ feature: "N3", row: "C2.1" }), // a row of another capability
      answer({ feature: "N4", domain: "none" }), // no domain, yet a capability
      answer({ feature: "N5", change: "new domain", change_detail: "x" }), // a new domain, yet a domain
      answer({ feature: "N6", score: 7 }),
      answer({ feature: "N7", why: "" }),
    );
    expect(decisions).toHaveLength(0);
    expect(dropped).toBe(8);
    expect(unanswered).toEqual(features.map((f) => f.code));
  });
  it("a feature answered twice counts once; one never answered is listed", () => {
    const { decisions, dropped, unanswered } = parse(answer({}), answer({ row: "C1.1" }));
    expect(decisions).toHaveLength(1);
    expect(dropped).toBe(1);
    expect(unanswered).toEqual(["N2", "N3", "N4", "N5", "N6", "N7"]);
  });
  it("keeps a doubtful score with a warning", () => {
    const d = parse(answer({ score: 2, reasoning: "x".repeat(400) })).decisions[0];
    expect(d.warnings.join(" | ")).toMatch(/goes down \(3 → 2\)/);
    expect(d.warnings.join(" | ")).toMatch(/400 characters/);
    expect(parse(answer({ score: 0 })).decisions[0].warnings.join(" | ")).toMatch(/score 0/);
  });
});
