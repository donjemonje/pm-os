/** Competitors — a domain's texts in Settings: never the same words twice on the card; "Same as what it covers" keeps the two texts in step. Pure module. */
import { describe, expect, it } from "vitest";
import { aiTextSameAsCovers, aiTextToSave, capabilityChanges, capabilityTextForAI, definitionSameAsCovers, domainTextsToSave, type CapabilityDraft } from "@/lib/competitors/domain-texts";

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

describe("a capability's PMOS AI text", () => {
  it("is the same as what it covers when it is empty or the same words", () => {
    expect(aiTextSameAsCovers("Sending invoices.", "")).toBe(true);
    expect(aiTextSameAsCovers("Sending invoices.", null)).toBe(true);
    expect(aiTextSameAsCovers("Sending invoices.", " Sending invoices. ")).toBe(true);
    expect(aiTextSameAsCovers("Sending invoices.", "Sending and tracking invoices.")).toBe(false);
  });
  it("is stored only when it differs", () => {
    expect(aiTextToSave({ covers: "Sending invoices.", aiText: "Old text.", same: true })).toBe("");
    expect(aiTextToSave({ covers: "Sending invoices.", aiText: "Sending invoices.", same: false })).toBe("");
    expect(aiTextToSave({ covers: "Sending invoices.", aiText: " For PMOS AI. ", same: false })).toBe("For PMOS AI.");
  });
  it("PMOS AI gets its own text when one is set, else what it covers", () => {
    expect(capabilityTextForAI("Sending invoices.", "For PMOS AI.")).toBe("For PMOS AI.");
    expect(capabilityTextForAI("Sending invoices.", "")).toBe("Sending invoices.");
    expect(capabilityTextForAI("Sending invoices.", null)).toBe("Sending invoices.");
  });
});

describe("capabilityChanges — a save sends only what changed", () => {
  const row = { name: "Invoice delivery", domainId: "d1", description: "Getting the invoice to the customer.", aiDefinition: "", productLines: ["Billing"] };
  const draft = (over: Partial<CapabilityDraft> = {}): CapabilityDraft => ({ name: row.name, domainId: row.domainId, description: row.description, aiDefinition: "", same: true, productLines: [...row.productLines], ...over });
  it("nothing when nothing was touched", () => {
    expect(capabilityChanges(row, draft())).toEqual({});
  });
  it("each of the five things on its own", () => {
    expect(capabilityChanges(row, draft({ name: " Invoice sending " }))).toEqual({ name: "Invoice sending" });
    expect(capabilityChanges(row, draft({ domainId: "d2" }))).toEqual({ domainId: "d2" });
    expect(capabilityChanges(row, draft({ description: "New words." }))).toEqual({ description: "New words." });
    expect(capabilityChanges(row, draft({ same: false, aiDefinition: "For PMOS AI." }))).toEqual({ aiDefinition: "For PMOS AI." });
    expect(capabilityChanges(row, draft({ productLines: ["Billing", "Payments"] }))).toEqual({ productLines: ["Billing", "Payments"] });
  });
  it("ticking \"Same as what it covers\" clears a text PMOS AI had of its own", () => {
    expect(capabilityChanges({ ...row, aiDefinition: "For PMOS AI." }, draft({ same: true, aiDefinition: "For PMOS AI." }))).toEqual({ aiDefinition: "" });
    expect(capabilityChanges({ ...row, aiDefinition: "For PMOS AI." }, draft({ same: false, aiDefinition: "For PMOS AI." }))).toEqual({});
    // A stored copy of the covers text is cleared, so it cannot fall behind a later change of that text.
    expect(capabilityChanges({ ...row, aiDefinition: row.description }, draft({ same: true, aiDefinition: row.description }))).toEqual({ aiDefinition: "" });
  });
});

