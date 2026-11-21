import { describe, expect, it } from "vitest";
import { aliasList, aliasesAfterRename, aliasesWithout, judgeCapabilitySuggestion, judgeDomainSuggestion, judgeNewRow, nameKey, NameIndex, placeInDomain } from "@/lib/competitors/decisions";

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

describe("the analysis run creates rows without reopening a PM decision", () => {
  const capabilities = new NameIndex([row("a", "Single sign-on", "active", ["SSO"]), row("b", "Password vault", "removed"), row("c", "Kiosk mode", "dismissed")]);

  it("judgeNewRow: a market name that is a row's replaced name is that row — nothing is created", () => {
    expect(judgeNewRow(capabilities, ["SSO", "Acme Login"])).toMatchObject({ action: "match", via: "alias", row: { id: "a" } });
    expect(judgeNewRow(capabilities, ["single  sign-on"])).toMatchObject({ action: "match", via: "name", row: { id: "a" } });
  });
  it("judgeNewRow: their wording is a row a PM removed or declined → remembered, never shown", () => {
    expect(judgeNewRow(capabilities, ["Credential storage", "Password Vault"])).toMatchObject({ action: "silent", reason: "removed", row: { id: "b" } });
    expect(judgeNewRow(capabilities, ["Kiosk mode"])).toMatchObject({ action: "silent", reason: "dismissed", row: { id: "c" } });
  });
  it("judgeNewRow: a name the catalog does not know becomes a row under the market name", () => {
    expect(judgeNewRow(capabilities, ["Passwordless login", "Acme Passkeys"])).toEqual({ action: "create", name: "Passwordless login" });
    expect(judgeNewRow(capabilities, ["", "  Acme   Passkeys "])).toEqual({ action: "create", name: "Acme Passkeys" });
  });

  const domains = new NameIndex([row("d1", "Identity"), row("d2", "Access control", "active", ["Access management"]), row("d3", "Legacy", "removed"), row("d4", "AI Security", "suggested"), row("d5", "Blockchain", "dismissed")]);
  const answer = (extra: Partial<{ domainId: string | null; newDomainName: string; closestDomainId: string | null }> = {}) => ({ domainId: null, newDomainName: "", closestDomainId: null, ...extra });

  it("placeInDomain: a domain of ours is used as given", () => {
    expect(placeInDomain(domains, answer({ domainId: "d1", newDomainName: "Ignored" }), "d1")).toEqual({ action: "use", domainId: "d1" });
  });
  it("placeInDomain: a new name equal to a domain a PM removed or declined → the closest existing domain, and the decision is respected", () => {
    expect(placeInDomain(domains, answer({ newDomainName: "legacy", closestDomainId: "d2" }), "d1")).toMatchObject({ action: "closest", domainId: "d2", respected: { id: "d3", state: "removed" } });
    expect(placeInDomain(domains, answer({ newDomainName: "Blockchain" }), "d1")).toMatchObject({ action: "closest", domainId: "d1", respected: { id: "d5" } });
  });
  it("placeInDomain: a new name equal to a renamed domain's old name, or to a suggested domain → that domain", () => {
    expect(placeInDomain(domains, answer({ newDomainName: "Access Management" }), "d1")).toEqual({ action: "use", domainId: "d2" });
    expect(placeInDomain(domains, answer({ newDomainName: "AI security" }), "d1")).toEqual({ action: "use", domainId: "d4" });
  });
  it("placeInDomain: a name nobody knows → a suggested domain, with the closest existing one kept for a decline", () => {
    expect(placeInDomain(domains, answer({ newDomainName: "Quantum Safety", closestDomainId: "d2" }), "d1")).toEqual({ action: "suggest", name: "Quantum Safety", closestDomainId: "d2" });
    expect(placeInDomain(domains, answer({ newDomainName: "Quantum Safety" }), "d1")).toEqual({ action: "suggest", name: "Quantum Safety", closestDomainId: "d1" });
  });
  it("placeInDomain: no name at all → the closest domain, else the fallback", () => {
    expect(placeInDomain(domains, answer({ closestDomainId: "d2" }), "d1")).toEqual({ action: "use", domainId: "d2" });
    expect(placeInDomain(domains, answer(), "d1")).toEqual({ action: "use", domainId: "d1" });
  });
});
