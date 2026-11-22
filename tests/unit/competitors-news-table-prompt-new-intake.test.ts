/** News Feed & Notifications — the prompt that adds a newly found ability to the table: its shared rule text, its answer form and its parser. */
import { describe, expect, it } from "vitest";
import { DOMAINS_SYSTEM_PROMPT } from "@/lib/competitors/analysis/domains";
import { MATCH_SYSTEM_PROMPT } from "@/lib/competitors/analysis/prompts";
import { AREA_SPLIT_RULE, READ_SYSTEM_PROMPT } from "@/lib/competitors/analysis/reading";
import {
  BROADER_NARROWER_RULE,
  FEATURE_NAME_RULE,
  FEATURE_PLACE_RULE,
  FEATURE_ROW_IS,
  NO_DUPLICATE_ROW_RULE,
  NO_WIDE_ROW_RULE,
  ROW_GROUPING_RULE,
  ROW_NAME_RULE,
  ROW_SIZE,
  SAME_FEATURE_RULE,
  SAME_ROW_RULE,
  TABLE_FRAME,
  UNIFY_CAPABILITIES_PROMPT,
  UNIFY_FEATURES_PROMPT,
  UNIFY_REVIEW_PROMPT,
} from "@/lib/competitors/analysis/unify";
import {
  CONFIDENT_RULE,
  DOMAIN_AREA_RULE,
  DOMAIN_DEFINITIONS_RULE,
  DOMAIN_NAME_RULE,
  MATCH_BY_WHAT_RULE,
  NO_OTHER_DOMAIN_RULE,
  parseTableAdd,
  renderTableAdd,
  TABLE_ADD_SYSTEM_PROMPT,
  tableAddTool,
  type TableAddAbility,
  type TableAddTable,
} from "@/lib/competitors/news/table-prompt-new-intake";

const table: TableAddTable = {
  domains: [
    { code: "D1", name: "Feedback Management", definition: "Collecting and making sense of what customers ask for." },
    { code: "D2", name: "Roadmapping", definition: "Planning and showing what is built when." },
  ],
  rows: [
    { code: "R1", domainCode: "D1", name: "Feedback Repository", description: "One place for customer feedback.", features: [{ code: "R1.1", name: "Feedback forms" }] },
    { code: "R2", domainCode: "D2", name: "Roadmap Views", description: "Timeline and board views of the plan.", features: [{ code: "R2.1", name: "Timeline layout" }] },
  ],
};
const ability = (code: string, size: "capability" | "feature" = "capability"): TableAddAbility => ({
  code, size, name: `Ability ${code}`, what: "Does a thing.", problem: "A problem.", workflows: "A workflow.", who: "Product managers", quote: "It does a thing.", sourceUrl: "https://example.test/page", parentName: size === "feature" ? "Customer insights" : null,
});
const abilities = [ability("A1"), ability("A2", "feature"), ability("A3"), ability("A4"), ability("A5", "feature")];
const base = { in_table: true, as: "capability", row: "none", feature: "none", domain: "none", new_name: "", new_description: "", change: "none", change_detail: "", reason: "Because it is the same thing." };

describe("the rule text is the setup run's own", () => {
  it("every shared sentence is part of the table-add prompt AND of the setup prompt it comes from", () => {
    const shared: Array<[string, string]> = [
      [TABLE_FRAME, UNIFY_CAPABILITIES_PROMPT],
      [ROW_SIZE, UNIFY_CAPABILITIES_PROMPT],
      [SAME_ROW_RULE, UNIFY_CAPABILITIES_PROMPT],
      [ROW_GROUPING_RULE, UNIFY_CAPABILITIES_PROMPT],
      [NO_WIDE_ROW_RULE, UNIFY_CAPABILITIES_PROMPT],
      [ROW_NAME_RULE, UNIFY_CAPABILITIES_PROMPT],
      [NO_DUPLICATE_ROW_RULE, UNIFY_CAPABILITIES_PROMPT],
      [BROADER_NARROWER_RULE, UNIFY_REVIEW_PROMPT],
      [FEATURE_ROW_IS, UNIFY_FEATURES_PROMPT],
      [SAME_FEATURE_RULE, UNIFY_FEATURES_PROMPT],
      [FEATURE_NAME_RULE, UNIFY_FEATURES_PROMPT],
      [FEATURE_PLACE_RULE, UNIFY_FEATURES_PROMPT],
      [AREA_SPLIT_RULE, READ_SYSTEM_PROMPT],
      [DOMAIN_AREA_RULE, DOMAINS_SYSTEM_PROMPT],
      [DOMAIN_NAME_RULE, DOMAINS_SYSTEM_PROMPT],
      [NO_OTHER_DOMAIN_RULE, DOMAINS_SYSTEM_PROMPT],
      [DOMAIN_DEFINITIONS_RULE, MATCH_SYSTEM_PROMPT],
      [MATCH_BY_WHAT_RULE, MATCH_SYSTEM_PROMPT],
      [CONFIDENT_RULE, MATCH_SYSTEM_PROMPT],
    ];
    for (const [sentence, source] of shared) {
      expect(TABLE_ADD_SYSTEM_PROMPT).toContain(sentence);
      expect(source).toContain(sentence);
    }
  });
});

describe("tableAddTool", () => {
  it("every field of a decision is required, and the codes are closed sets", () => {
    const tool = tableAddTool(["A1", "A2"], table) as { input_schema: { required: string[]; properties: { decisions: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } } };
    const item = tool.input_schema.properties.decisions.items;
    expect(tool.input_schema.required).toEqual(["decisions"]);
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    expect(item.properties.ability.enum).toEqual(["A1", "A2"]);
    expect(item.properties.row.enum).toEqual(["none", "new", "R1", "R2"]);
    expect(item.properties.feature.enum).toEqual(["none", "new", "R1.1", "R2.1"]);
    expect(item.properties.domain.enum).toEqual(["none", "new", "D1", "D2"]);
  });
});

describe("renderTableAdd", () => {
  it("shows the table by domain with every code, then each ability with what is known of it", () => {
    const text = renderTableAdd("Acme", [ability("A1"), ability("A2", "feature")], table);
    expect(text).toContain("COMPANY: Acme");
    expect(text).toContain("D1 | DOMAIN: Feedback Management — Collecting and making sense of what customers ask for.");
    expect(text).toContain("  R1 | Feedback Repository — One place for customer feedback.");
    expect(text).toContain("    R1.1 | Feedback forms");
    expect(text).toContain("A1 | capability | Ability A1 — Does a thing.");
    expect(text).toContain('A2 | feature, listed by the company under "Customer insights" | Ability A2');
    expect(text).toContain("  problem it solves: A problem.");
    expect(text).toContain("  quote: \"It does a thing.\" (https://example.test/page)");
  });
});

describe("parseTableAdd", () => {
  it("accepts a valid answer: an existing row, a new feature row, a new row in a new domain, left out, an existing feature row", () => {
    const { decisions, dropped, unanswered } = parseTableAdd(
      {
        decisions: [
          { ...base, ability: "A1", row: "R1", domain: "D2", new_name: "ignored" },
          { ...base, ability: "A2", as: "feature", row: "R1", feature: "new", new_name: "Feedback Voting", new_description: "Customers vote on feedback." },
          { ...base, ability: "A3", row: "new", domain: "new", new_name: "Agent Workspace", new_description: "A place where agents work.", change: "new_domain", change_detail: "AI Agents — Software agents that do product work." },
          { ...base, ability: "A4", in_table: false, as: "capability", row: "R2", reason: "A new look for the timeline, nothing new to ask for." },
          { ...base, ability: "A5", as: "feature", row: "R2", feature: "R2.1" },
        ],
      },
      abilities,
      table,
    );
    expect(dropped).toBe(0);
    expect(unanswered).toEqual([]);
    expect(decisions.map((d) => d.code)).toEqual(["A1", "A2", "A3", "A4", "A5"]);
    // An existing row: what does not apply is "none" / "" whatever the answer wrote.
    expect(decisions[0]).toMatchObject({ inTable: true, as: "capability", row: "R1", feature: "none", domain: "none", newName: "", change: "none", changeDetail: "" });
    expect(decisions[1]).toMatchObject({ as: "feature", row: "R1", feature: "new", domain: "none", newName: "Feedback Voting", newDescription: "Customers vote on feedback." });
    expect(decisions[2]).toMatchObject({ as: "capability", row: "new", domain: "new", newName: "Agent Workspace", change: "new_domain" });
    expect(decisions[2].changeDetail).toContain("AI Agents");
    expect(decisions[3]).toMatchObject({ inTable: false, as: "none", row: "none", feature: "none", domain: "none", change: "none" });
    expect(decisions[4]).toMatchObject({ as: "feature", row: "R2", feature: "R2.1", newName: "" });
  });

  it("accepts the changes to the table itself: a reworded row, a split row, a reworded domain", () => {
    const { decisions, dropped } = parseTableAdd(
      {
        decisions: [
          { ...base, ability: "A1", row: "R1", change: "reword_row", change_detail: "Feedback Hub — One place for feedback from customers and from agents." },
          { ...base, ability: "A3", row: "R2", change: "split_row", change_detail: "Roadmap Views — …; Public Roadmap Sharing — …; the ability goes on the second." },
          { ...base, ability: "A4", row: "R2", domain: "D2", change: "reword_domain", change_detail: "Planning & Roadmapping — Planning, and showing what is built when." },
        ],
      },
      abilities,
      table,
    );
    expect(dropped).toBe(0);
    expect(decisions.map((d) => [d.code, d.change, d.domain])).toEqual([["A1", "reword_row", "none"], ["A3", "split_row", "none"], ["A4", "reword_domain", "D2"]]);
  });

  it("rejects codes outside the closed sets, and says which abilities are left unanswered", () => {
    const { decisions, dropped, unanswered } = parseTableAdd(
      {
        decisions: [
          { ...base, ability: "A9", row: "R1" }, // an ability that was not asked
          { ...base, ability: "A1", row: "R7" }, // a row that is none of ours
          { ...base, ability: "A2", as: "feature", row: "R1", feature: "R2.1" }, // a feature row of another row
          { ...base, ability: "A3", row: "new", domain: "D9", new_name: "Agent Workspace" }, // a domain that is none of ours
          { ...base, ability: "A4", as: "row", row: "R1" }, // a size that does not exist
          { ...base, ability: "A5", as: "feature", row: "R1", feature: "R1.1", change: "merge_rows", change_detail: "x" }, // a change that does not exist
        ],
      },
      abilities,
      table,
    );
    expect(decisions).toEqual([]);
    expect(dropped).toBe(6);
    expect(unanswered).toEqual(["A1", "A2", "A3", "A4", "A5"]);
  });

  it("rejects a decision that does not hold together, keeps the first answer of an ability, and survives a broken answer", () => {
    const { decisions, dropped, unanswered } = parseTableAdd(
      {
        decisions: [
          { ...base, ability: "A1", row: "R1" },
          { ...base, ability: "A1", row: "R2" }, // a second answer for A1
          { ...base, ability: "A2", as: "feature", row: "new", feature: "new", new_name: "X" }, // a feature needs a row that exists
          { ...base, ability: "A3", row: "new", domain: "D1" }, // a new row without a name
          { ...base, ability: "A4", row: "new", domain: "new", new_name: "X" }, // a new domain that is not declared as the change
          { ...base, ability: "A5", as: "feature", row: "R1", feature: "R1.1", reason: "" }, // no reason
        ],
      },
      abilities,
      table,
    );
    expect(decisions.map((d) => [d.code, d.row])).toEqual([["A1", "R1"]]);
    expect(dropped).toBe(5);
    expect(unanswered).toEqual(["A2", "A3", "A4", "A5"]);

    for (const broken of [null, {}, { decisions: "none" }, { decisions: [null, 3, "A1"] }]) {
      const r = parseTableAdd(broken, abilities, table);
      expect(r.decisions).toEqual([]);
      expect(r.unanswered).toHaveLength(5);
    }
    // A reworded domain must be the row's own; a row change cannot be asked of a new row.
    const wrong = parseTableAdd(
      {
        decisions: [
          { ...base, ability: "A1", row: "R1", domain: "D2", change: "reword_domain", change_detail: "x — y" },
          { ...base, ability: "A3", row: "new", domain: "D1", new_name: "X", change: "split_row", change_detail: "x" },
          { ...base, ability: "A4", row: "R1", change: "reword_row", change_detail: "" },
        ],
      },
      abilities,
      table,
    );
    expect(wrong.decisions).toEqual([]);
    expect(wrong.dropped).toBe(3);
  });
});
