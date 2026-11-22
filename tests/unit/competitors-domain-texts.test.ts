/** Competitors — a domain's texts in Settings: never the same words twice on the card; "Same as what it covers" keeps the two texts in step. Pure module. */
import { describe, expect, it } from "vitest";
import { definitionSameAsCovers, domainTextsToSave } from "@/lib/competitors/domain-texts";

describe("definitionSameAsCovers", () => {
  it("true when the two texts are the same words, whatever the space around them", () => {
    expect(definitionSameAsCovers("Charging customers.", "  Charging customers.\n")).toBe(true);
  });
  it("false when they differ, and false when there is no text", () => {
    expect(definitionSameAsCovers("Charging customers.", "Charging customers and refunds.")).toBe(false);
    expect(definitionSameAsCovers("", "")).toBe(false);
    expect(definitionSameAsCovers("  ", "x")).toBe(false);
  });
});

describe("domainTextsToSave", () => {
  it("with \"Same as what it covers\" the definition is the covers text", () => {
    expect(domainTextsToSave({ covers: "New text.", definition: "Old text.", same: true })).toEqual({ summary: "New text.", description: "New text." });
  });
  it("otherwise each text is what the user wrote", () => {
    expect(domainTextsToSave({ covers: "For people.", definition: "For PMOS AI.", same: false })).toEqual({ summary: "For people.", description: "For PMOS AI." });
  });
});
