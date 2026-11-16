/** Capability Analysis — the table as text (analysis/table.ts): what `--table <workspaceId>` prints. Pure module. */
import { describe, expect, it } from "vitest";
import { markOf, MARKS_LEGEND, renderTable, type TableText } from "@/lib/competitors/analysis/table";

const table: TableText = {
  organization: "Aha",
  companies: [{ name: "Aha", own: true }, { name: "Productboard", own: false }, { name: "Bagel AI", own: false }],
  domains: [
    {
      name: "Customer Feedback", definition: "Collecting what customers ask for and making sense of it.",
      capabilities: [
        { name: "Feedback Collection", description: "Collects feedback from every channel in one place.", marks: ["found", "found", "low"], features: [
          { name: "Feedback Forms", description: "Forms customers fill in to send feedback.", marks: ["found", "not_found", "none"] },
        ] },
        { name: "Feedback Theme Detection", description: "", marks: ["not_found", "found", "found"], features: [] },
      ],
    },
    { name: "Security", definition: "", capabilities: [{ name: "Single Sign-On", description: "Signs users in through\n the company's identity provider.", marks: ["found", "none", "not_found"], features: [] }] },
  ],
};

describe("the table as text", () => {
  const text = renderTable(table);
  it("domains with their definitions → capabilities with their descriptions and a mark per company → features with a mark per company", () => {
    expect(text).toBe([
      "TABLE of Aha — 2 domains, 3 capabilities, 1 feature",
      "Companies: Aha (the organization itself) 2 capabilities / 1 features · Productboard 2 capabilities / 0 features · Bagel AI 2 capabilities / 0 features",
      MARKS_LEGEND,
      "",
      "## Customer Feedback — Collecting what customers ask for and making sense of it.",
      "",
      "Feedback Collection — Collects feedback from every channel in one place.",
      "    Aha: yes | Productboard: yes | Bagel AI: low",
      "    - Feedback Forms — Forms customers fill in to send feedback.",
      "        Aha: yes | Productboard: no | Bagel AI: ?",
      "",
      "Feedback Theme Detection — (no description)",
      "    Aha: no | Productboard: yes | Bagel AI: yes",
      "",
      "## Security — (no definition)",
      "",
      "Single Sign-On — Signs users in through the company's identity provider.",
      "    Aha: yes | Productboard: ? | Bagel AI: no",
    ].join("\n"));
  });
  it("the legend says what every mark means", () => {
    expect(MARKS_LEGEND).toBe("Marks: yes = found · low = found on weak pages only (low confidence) · no = not found · ? = no cell yet (not checked)");
  });
  it("a stored value is a mark; anything else is no cell", () => {
    expect(["found", "low", "not_found", "partial", null, undefined].map(markOf)).toEqual(["found", "low", "not_found", "none", "none", "none"]);
  });
  it("an organization with no catalog says so", () => {
    expect(renderTable({ organization: "New Org", companies: [{ name: "New Org", own: true }], domains: [] })).toBe([
      "TABLE of New Org — 0 domains, 0 capabilities, 0 features",
      "Companies: New Org (the organization itself) 0 capabilities / 0 features",
      MARKS_LEGEND,
      "",
      "The table is empty: this organization has no domain and no capability yet.",
    ].join("\n"));
  });
  it("plain text only: it can be pasted into a chat", () => {
    expect(/[\u2500-\u257F\u25A0-\u25FF\u2713\u2717]/.test(text)).toBe(false);
  });
});
