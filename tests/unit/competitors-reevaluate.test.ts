/** Competitors — re-evaluating one capability's row (the coverage model): the text sent and the reading of the answer. Pure module. */
import { describe, expect, it } from "vitest";
import { readRowAnswer, renderRow, REEVALUATE_SYSTEM_PROMPT, REEVALUATE_TOOL, type RowInput } from "@/lib/competitors/reevaluate-prompt";

const row = (over: Partial<RowInput> = {}): RowInput => ({
  domain: { name: "Billing", covers: "Charging customers and collecting what they owe." },
  capability: { name: "Invoice delivery", covers: "Getting the invoice to the customer and knowing it arrived." },
  features: [
    { name: "Scheduled sending", has: { own: { how: "Sends on the date the plan sets." }, c1: { how: null } } },
    { name: "Delivery tracking", has: { c1: { how: "Shows when the customer opened it." } } },
    { name: "Reminder sequences", has: { c1: { how: null } } },
    { name: "Customer portal", has: {} },
  ],
  companies: [
    { key: "own", name: "Acme", score: 2, reasoning: "Sends on a schedule only.", locked: false, note: null },
    { key: "c1", name: "Globex (Europe)", score: 4, reasoning: "Covers sending, tracking and reminders.", locked: false, note: null },
    { key: "c2", name: "Initech", score: 0, reasoning: "", locked: false, note: null },
  ],
  ...over,
});
const answer = (list: Array<[string, number, string]>) => ({ companies: list.map(([company, score, reasoning]) => ({ company, score, reasoning })) });

describe("the prompt and its answer form", () => {
  it("names the rules and requires every field", () => {
    expect(REEVALUATE_SYSTEM_PROMPT).toContain("At most 350 characters");
    expect(REEVALUATE_SYSTEM_PROMPT).toContain("fixed by a person");
    expect(REEVALUATE_TOOL.input_schema.properties.companies.items.required).toEqual(["company", "score", "reasoning"]);
  });
});

describe("renderRow — what is sent", () => {
  it("lists the features with who has them, the scores so far, notes and fixed scores", () => {
    const text = renderRow(row({ companies: [{ key: "own", name: "Acme", score: 3, reasoning: "x", locked: true, note: null }, { key: "c1", name: "Globex (Europe)", score: 4, reasoning: "y", locked: false, note: "They sunset reminders last month." }] }));
    expect(text).toContain("THE CAPABILITY\nInvoice delivery — Getting the invoice");
    expect(text).toContain("1. Scheduled sending\n   Acme: has it — Sends on the date the plan sets.\n   Globex (Europe): has it");
    expect(text).toContain("4. Customer portal\n   Acme: not found");
    expect(text).toContain("Acme (the table is made for this company)\n   Score so far: 3 — fixed by a person");
    expect(text).toContain("A person's note: They sunset reminders last month.");
  });
  it("is the same text for the same row", () => {
    expect(renderRow(row())).toBe(renderRow(row()));
  });
});

describe("readRowAnswer", () => {
  it("takes a full answer; names are compared by letters and digits", () => {
    const r = readRowAnswer(answer([["Acme", 2, "Sends on a schedule."], ["Globex (Europe) —", 5, "Covers nearly all of it."], ["Initech ", 0, "Nothing here."]]), row());
    expect(r.problems).toEqual([]);
    expect(r.scores).toEqual([{ key: "own", score: 2, reasoning: "Sends on a schedule." }, { key: "c1", score: 5, reasoning: "Covers nearly all of it." }, { key: "c2", score: 0, reasoning: "Nothing here." }]);
  });
  it("a score a person fixed stays as it is, whatever the answer says", () => {
    const locked = row({ companies: [{ key: "own", name: "Acme", score: 5, reasoning: "Set by us.", locked: true, note: null }, { key: "c1", name: "Globex (Europe)", score: 4, reasoning: "y", locked: false, note: null }] });
    const r = readRowAnswer(answer([["Acme", 1, "changed"], ["Globex (Europe)", 3, "Less than Acme."]]), locked);
    expect(r.scores).toEqual([{ key: "own", score: 5, reasoning: "Set by us." }, { key: "c1", score: 3, reasoning: "Less than Acme." }]);
  });
  it("any problem makes the whole answer unusable", () => {
    expect(readRowAnswer({}, row()).problems).toEqual(["the answer has no list of companies"]);
    const missing = readRowAnswer(answer([["Acme", 2, "a"], ["Globex (Europe)", 4, "b"]]), row());
    expect(missing.scores).toEqual([]);
    expect(missing.problems).toEqual(["Initech: not returned"]);
    expect(readRowAnswer(answer([["Acme", 2, "a"], ["Globex (Europe)", 7, "b"], ["Initech", 0, "c"]]), row()).problems[0]).toContain("whole number 0-5");
    expect(readRowAnswer(answer([["Acme", 2, "a"], ["Globex (Europe)", 4, "x".repeat(351)], ["Initech", 0, "c"]]), row()).problems[0]).toContain("351 characters");
    expect(readRowAnswer(answer([["Acme", 2, "a"], ["Globex (Europe)", 4, "  "], ["Initech", 0, "c"]]), row()).problems[0]).toContain("no reasoning");
  });
  it("the score must agree with the main features", () => {
    // Acme has 1 of 4 main features: it cannot get 5. Globex has 3 of 4: it cannot get 0.
    expect(readRowAnswer(answer([["Acme", 5, "a"], ["Globex (Europe)", 4, "b"], ["Initech", 0, "c"]]), row()).problems).toEqual(["Acme: score 5 with 1 of 4 main features"]);
    expect(readRowAnswer(answer([["Acme", 2, "a"], ["Globex (Europe)", 0, "b"], ["Initech", 0, "c"]]), row()).problems).toEqual(["Globex (Europe): score 0 with 3 of 4 main features"]);
  });
});
