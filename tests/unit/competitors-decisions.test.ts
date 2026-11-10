import { describe, expect, it } from "vitest";
import { aliasList, aliasesAfterRename, aliasesWithout, judgeCapabilitySuggestion, judgeDomainSuggestion, nameKey, NameIndex } from "@/lib/competitors/decisions";

const row = (id: string, name: string, state = "active", aliases: unknown = []) => ({ id, name, state, aliases });

describe("competitors decisions — names a scan must recognise", () => {
  it("compares names without case and extra spaces", () => {
    expect(nameKey("  Product   Roadmap ")).toBe("product roadmap");
  });

  it("reads aliases from a Json column, dropping junk and duplicates", () => {
    expect(aliasList(["Roadmap", "roadmap ", 3, null, ""])).toEqual(["Roadmap"]);
    expect(aliasList("Roadmap")).toEqual([]);
    expect(aliasList(null)).toEqual([]);
  });

  it("keeps the old name behind a renamed row", () => {
    expect(aliasesAfterRename([], "Roadmap", "Product roadmap")).toEqual(["Roadmap"]);
    expect(aliasesAfterRename(["Roadmap"], "Product roadmap", "Plans")).toEqual(["Roadmap", "Product roadmap"]);
  });

  it("does not keep an alias for a change of case only, and drops the new name from the aliases", () => {
    expect(aliasesAfterRename([], "Roadmap", "roadmap")).toEqual([]);
    expect(aliasesAfterRename(["Roadmap"], "Product roadmap", "Roadmap")).toEqual(["Product roadmap"]);
  });

  it("drops an alias when another row takes the name", () => {
    expect(aliasesWithout(["Roadmap", "Plans"], "roadmap")).toEqual(["Plans"]);
  });

  it("resolves a row by its name and by a replaced name", () => {
    const index = new NameIndex([row("a", "Product roadmap", "active", ["Roadmap"]), row("b", "Dashboards")]);
    expect(index.resolve("PRODUCT ROADMAP")).toMatchObject({ id: "a", via: "name" });
    expect(index.resolve("roadmap")).toMatchObject({ id: "a", via: "alias", name: "Product roadmap" });
    expect(index.resolve("Reports")).toBeNull();
    expect(index.resolve("  ")).toBeNull();
  });

  it("lets a current name win over another row's alias", () => {
    const index = new NameIndex([row("a", "Product roadmap", "active", ["Roadmap"]), row("b", "Roadmap")]);
    expect(index.resolve("roadmap")).toMatchObject({ id: "b", via: "name" });
  });

  it("never adds back what a PM removed or dismissed", () => {
    const index = new NameIndex([row("a", "Dashboards", "removed"), row("b", "Idea voting", "dismissed"), row("c", "Analytics", "removed", ["Reporting"])]);
    expect(judgeCapabilitySuggestion(index, "dashboards")).toMatchObject({ action: "skip", reason: "removed" });
    expect(judgeCapabilitySuggestion(index, "Idea Voting")).toMatchObject({ action: "skip", reason: "dismissed" });
    expect(judgeCapabilitySuggestion(index, "reporting")).toMatchObject({ action: "skip", reason: "removed" });
  });

  it("recognises an existing row under its old name instead of creating a second one", () => {
    const index = new NameIndex([row("a", "Product roadmap", "active", ["Roadmap"])]);
    expect(judgeCapabilitySuggestion(index, "Roadmap")).toMatchObject({ action: "skip", reason: "renamed", row: { id: "a" } });
    expect(judgeCapabilitySuggestion(index, "product roadmap")).toMatchObject({ action: "skip", reason: "exists" });
    expect(judgeCapabilitySuggestion(index, "Timeline view")).toEqual({ action: "create" });
  });

  it("places a suggestion in a renamed domain, and never proposes a removed or dismissed one", () => {
    const index = new NameIndex([row("d1", "Analytics", "active", ["Reporting"]), row("d2", "Feedback", "removed"), row("d3", "Pricing", "dismissed"), row("d4", "Integrations", "suggested")]);
    expect(judgeDomainSuggestion(index, "reporting")).toMatchObject({ action: "use", row: { id: "d1" } });
    expect(judgeDomainSuggestion(index, "Integrations")).toMatchObject({ action: "use", row: { id: "d4" } });
    expect(judgeDomainSuggestion(index, "feedback")).toMatchObject({ action: "skip", reason: "removed" });
    expect(judgeDomainSuggestion(index, "PRICING")).toMatchObject({ action: "skip", reason: "dismissed" });
    expect(judgeDomainSuggestion(index, "Security")).toEqual({ action: "create" });
  });

  it("sees rows added while a scan is applied", () => {
    const index = new NameIndex([]);
    expect(judgeDomainSuggestion(index, "Security")).toEqual({ action: "create" });
    index.add(row("d9", "Security", "suggested"));
    expect(judgeDomainSuggestion(index, "security")).toMatchObject({ action: "use", row: { id: "d9" } });
  });
});
