/**
 * Capability Analysis — the setup run's two own steps composed, as analysis/setup.ts drives them: unify in batches
 * (each against the rows made so far), the review, the domains, the catalog. Pure modules only: what a call
 * "saves" here is what the step saves on the items — the row's name and description.
 */
import { describe, expect, it } from "vitest";
import { knownDomains, parseDomains, planCatalog, type DomainDraft } from "@/lib/competitors/analysis/domains";
import { nextUnifyBatch, orderUnifyItems, parseUnify, parseUnifyReview, planUnifyReview, rowsOf, unifyEntries, type UnifyItem } from "@/lib/competitors/analysis/unify";

const ORDER = ["us", "en", "bg"];
const NAMES: Record<string, string> = { us: "Aha", en: "Enterpret", bg: "Bagel AI" };
const I = (id: string, competitorId: string, name: string): UnifyItem => ({ id, competitorId, company: NAMES[competitorId], isOwn: competitorId === "us", name, description: null, row: null });

/** The stored state of the items: which are placed, and on which row. */
function store(items: UnifyItem[]) {
  const placed = new Set<string>();
  const state = orderUnifyItems(items, ORDER);
  return {
    items: () => state,
    todo: () => state.filter((i) => !placed.has(i.id)),
    save: (assignments: Array<{ itemId: string; row: { name: string; description: string } | null }>) => {
      for (const a of assignments) {
        placed.add(a.itemId);
        state.find((i) => i.id === a.itemId)!.row = a.row;
      }
    },
    review: (plan: Map<string, { name: string; description: string } | null>, rows: ReturnType<typeof rowsOf>) => {
      for (const [key, after] of plan) for (const m of rows.find((r) => r.key === key)!.members) state.find((i) => i.id === m.id)!.row = after;
    },
  };
}

describe("unify → review → domains → catalog", () => {
  const db = store([
    I("u1", "us", "Idea portal"), I("u2", "us", "Roadmaps"), I("u3", "us", "Unlimited seats"),
    I("e1", "en", "Feedback inbox"), I("e2", "en", "Theme detection"),
    I("b1", "bg", "Feedback hub"), I("b2", "bg", "Roadmap views"), I("b3", "bg", "The AI product brain"),
  ]);
  /** The answers of the unify calls, in order. Batches of 3 → three calls. */
  const answers = [
    { rows: [{ code: "N1", name: "Feedback Collection", description: "Collects feedback in one place." }, { code: "N2", name: "Product Roadmaps", description: "Shows what is built next." }], entries: [{ entry: "I1", row: "N1" }, { entry: "I2", row: "N2" }, { entry: "I3", row: "none" }] },
    { rows: [{ code: "N1", name: "Feedback Theme Detection", description: "Finds themes in feedback." }, { code: "N2", name: "Feedback Intake", description: "Takes feedback in." }], entries: [{ entry: "I1", row: "R1" }, { entry: "I2", row: "N1" }, { entry: "I3", row: "N2" }] },
    { rows: [{ code: "N1", name: "AI Product Brain", description: "Everything, with AI." }], entries: [{ entry: "I1", row: "R2" }, { entry: "I2", row: "N1" }] },
  ];

  it("places every item in the fixed order, each call against the rows the calls before it made", () => {
    const seen: string[][] = [];
    for (const answer of answers) {
      const rows = rowsOf(db.items());
      const batch = nextUnifyBatch(db.todo(), 3);
      seen.push(batch.map((i) => i.id));
      const parsed = parseUnify(answer, unifyEntries(batch), rows);
      expect(parsed.problems).toEqual([]);
      db.save(parsed.assignments);
    }
    // The fixed order: the own source first, then Enterpret, then Bagel AI; inside a company by name.
    expect(seen).toEqual([["u1", "u2", "u3"], ["e1", "e2", "b1"], ["b2", "b3"]]);
    expect(db.todo()).toEqual([]);
    expect(rowsOf(db.items()).map((r) => [r.code, r.name, r.members.map((m) => m.id)])).toEqual([
      ["R1", "Feedback Collection", ["u1", "e1"]],
      ["R2", "Product Roadmaps", ["u2", "b2"]],
      ["R3", "Feedback Theme Detection", ["e2"]],
      ["R4", "Feedback Intake", ["b1"]],
      ["R5", "AI Product Brain", ["b3"]],
    ]);
    // The commercial term got no row.
    expect(db.items().find((i) => i.id === "u3")!.row).toBeNull();
  });

  it("the review merges the near-duplicate and drops the umbrella row", () => {
    const rows = rowsOf(db.items());
    const parsed = parseUnifyReview({ merge: [{ rows: ["R1", "R4"], name: "" }], drop: ["R5"], rename: [] }, rows);
    expect(parsed.problems).toEqual([]);
    db.review(planUnifyReview(parsed, rows), rows);
    expect(rowsOf(db.items()).map((r) => [r.code, r.name, r.members.map((m) => m.id)])).toEqual([
      ["R1", "Feedback Collection", ["u1", "e1", "b1"]],
      ["R2", "Product Roadmaps", ["u2", "b2"]],
      ["R3", "Feedback Theme Detection", ["e2"]],
    ]);
  });

  it("the domains step gives every row one domain — asked again for a row the first answer left out — and the catalog comes out in a stable order", () => {
    const rows = rowsOf(db.items());
    const drafts: DomainDraft[] = [];
    const assigned = new Map<string, string>();
    const first = parseDomains({ domains: [{ code: "D1", name: "Roadmapping", definition: "Planning what is built." }, { code: "D2", name: "Customer Feedback", definition: "Collecting and understanding feedback." }], rows: [{ row: "R2", domain: "D1" }, { row: "R1", domain: "D2" }] }, rows, knownDomains(drafts));
    expect(first.problems).toEqual([]);
    drafts.push(...first.created);
    for (const [k, v] of first.assigned) assigned.set(k, v);
    const left = rows.filter((r) => !assigned.has(r.key));
    expect(left.map((r) => r.code)).toEqual(["R3"]);
    // The follow-up call: the domains made so far are D1 (Roadmapping) and D2 (Customer Feedback).
    const second = parseDomains({ domains: [], rows: [{ row: "R3", domain: "D2" }] }, left, knownDomains(drafts));
    expect(second.problems).toEqual([]);
    for (const [k, v] of second.assigned) assigned.set(k, v);
    const catalog = planCatalog(rows, assigned, drafts);
    expect(catalog.map((d) => ({ domain: d.name, position: d.position, rows: d.rows.map((r) => `${r.position} ${r.row.name}${r.ours ? " (ours)" : ""}`) }))).toEqual([
      { domain: "Customer Feedback", position: 0, rows: ["0 Feedback Collection (ours)", "1 Feedback Theme Detection"] },
      { domain: "Roadmapping", position: 1, rows: ["2 Product Roadmaps (ours)"] },
    ]);
    // Every item that has a row is on exactly one row of the catalog.
    const onRows = catalog.flatMap((d) => d.rows.flatMap((r) => r.row.members.map((m) => m.id)));
    expect(onRows.sort()).toEqual(["b1", "b2", "e1", "e2", "u1", "u2"]);
  });
});
