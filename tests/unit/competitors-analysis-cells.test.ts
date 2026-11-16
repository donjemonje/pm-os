/** Capability Analysis — the cell rules (analysis/cells.ts): the table is filled in code from the evidence. Pure module. */
import { describe, expect, it } from "vitest";
import { bestDescription, cellFromEvidence, evidenceByRow, rankEvidence, type Evidence, type RowFinding } from "@/lib/competitors/analysis/cells";

const e = (findingId: string, extra: Partial<Evidence> = {}): Evidence => ({ findingId, pageUrl: `https://acme.example/${findingId}`, tier: "strong", pageKind: "product", origin: "reading", quote: `quote ${findingId}`, reasoning: "why", wording: "their name", description: null, ...extra });

describe("cellFromEvidence — the three rules", () => {
  it("at least one finding from a strong page → found", () => {
    expect(cellFromEvidence([e("a")]).value).toBe("found");
  });
  it("findings, all from weak pages → low confidence", () => {
    expect(cellFromEvidence([e("a", { tier: "weak", pageKind: "news" }), e("b", { tier: "weak", pageKind: "content" })]).value).toBe("low");
  });
  it("none → not found, with no evidence", () => {
    expect(cellFromEvidence([])).toEqual({ value: "not_found", best: null, count: 0, description: null });
  });
  it("one strong finding beats any number of weak ones, and is the evidence shown", () => {
    const weak = Array.from({ length: 20 }, (_, i) => e(`w${i}`, { tier: "weak", pageKind: "news" }));
    const cell = cellFromEvidence([...weak, e("s", { pageKind: "docs" })]);
    expect(cell.value).toBe("found");
    expect(cell.best?.findingId).toBe("s");
  });
  it("count is distinct pages, not findings", () => {
    const cell = cellFromEvidence([e("a", { pageUrl: "https://acme.example/p1" }), e("b", { pageUrl: "https://acme.example/p1" }), e("c", { pageUrl: "https://acme.example/p2" })]);
    expect(cell.count).toBe(2);
  });
  it("a feature's evidence counts for its capability: the caller hands both in, and the rule is the same", () => {
    const capabilityEvidence: Evidence[] = [];
    const featureEvidence = [e("f", { wording: "SAML" })];
    expect(cellFromEvidence([...capabilityEvidence, ...featureEvidence]).value).toBe("found");
  });
});

describe("the description shown on a cell", () => {
  it("is the description of the best-ranked finding that has one — not always the finding whose quote is shown", () => {
    const cell = cellFromEvidence([
      e("pricing", { pageKind: "pricing", description: null }),
      e("product", { pageKind: "product", description: "Signs users in once for every app." }),
      e("docs", { pageKind: "docs", description: "Lets admins connect an identity provider over SAML." }),
      e("news", { tier: "weak", pageKind: "news", description: "A weak page's sentence." }),
    ]);
    expect(cell.best?.findingId).toBe("pricing");
    expect(cell.description).toBe("Lets admins connect an identity provider over SAML.");
  });
  it("null when no finding has one; blank counts as none", () => {
    expect(cellFromEvidence([e("a"), e("b", { description: "   " })]).description).toBeNull();
    expect(bestDescription([])).toBeNull();
    expect(bestDescription([{ description: null }, { description: " Trimmed. " }])).toBe("Trimmed.");
  });
});

describe("rankEvidence", () => {
  it("tier, then page kind (pricing, docs, product, other, content, news), then research before second look, then address, then finding", () => {
    const list = [
      e("news", { tier: "weak", pageKind: "news" }),
      e("content", { tier: "weak", pageKind: "content" }),
      e("look", { pageKind: "pricing", origin: "second_look", pageUrl: "https://acme.example/pricing" }),
      e("product-b", { pageKind: "product", pageUrl: "https://acme.example/b" }),
      e("product-a2", { pageKind: "product", pageUrl: "https://acme.example/a" }),
      e("product-a1", { pageKind: "product", pageUrl: "https://acme.example/a" }),
      e("docs", { pageKind: "docs" }),
      e("pricing", { pageKind: "pricing", pageUrl: "https://acme.example/pricing" }),
      e("unknown-kind", { pageKind: "something" }),
    ];
    expect(rankEvidence(list).map((x) => x.findingId)).toEqual(["pricing", "look", "docs", "product-a1", "product-a2", "product-b", "unknown-kind", "content", "news"]);
  });
  it("does not change the list it was given", () => {
    const list = [e("b"), e("a")];
    rankEvidence(list);
    expect(list.map((x) => x.findingId)).toEqual(["b", "a"]);
  });
});

describe("the cell rule: a company has a row when it has its OWN capability on it OR ANY FEATURE under it", () => {
  const finding = (id: string, item: RowFinding["item"], extra: Partial<RowFinding> = {}): RowFinding => ({ evidence: e(id), item, lookCapabilityId: null, ...extra });
  const capabilityOfFeature = new Map([["f-sso", "k-security"], ["f-audit", "k-security"], ["f-gantt", "k-roadmaps"]]);
  it("its own capability on the row: the cell's proof is that capability's quote", () => {
    const rows = evidenceByRow([finding("a", { capabilityId: "k-roadmaps", featureId: null })], capabilityOfFeature);
    expect(cellFromEvidence(rows.byCapability.get("k-roadmaps") ?? [])).toMatchObject({ value: "found", best: { findingId: "a" } });
    expect(rows.byFeature.size).toBe(0);
  });
  it("no capability of its own on the row, but a feature under it: the company HAS the row — the proof is the feature's quote", () => {
    const rows = evidenceByRow([finding("sso", { capabilityId: null, featureId: "f-sso" })], capabilityOfFeature);
    expect(cellFromEvidence(rows.byCapability.get("k-security") ?? [])).toMatchObject({ value: "found", best: { findingId: "sso" } });
    // … and the feature row gets its own mark for the company.
    expect(cellFromEvidence(rows.byFeature.get("f-sso") ?? []).value).toBe("found");
    expect(cellFromEvidence(rows.byFeature.get("f-audit") ?? []).value).toBe("not_found");
  });
  it("neither: the company does not have the row", () => {
    const rows = evidenceByRow([finding("g", { capabilityId: null, featureId: "f-gantt" })], capabilityOfFeature);
    expect(cellFromEvidence(rows.byCapability.get("k-security") ?? []).value).toBe("not_found");
  });
  it("both: every proof counts for the row, each feature only for itself", () => {
    const rows = evidenceByRow([finding("k", { capabilityId: "k-security", featureId: null }), finding("sso", { capabilityId: null, featureId: "f-sso" }), finding("audit", { capabilityId: null, featureId: "f-audit" })], capabilityOfFeature);
    expect(rows.byCapability.get("k-security")?.map((x) => x.findingId)).toEqual(["k", "sso", "audit"]);
    expect(rows.byFeature.get("f-sso")?.map((x) => x.findingId)).toEqual(["sso"]);
  });
  it("a feature that is not active any more (it is not in the map) proves nothing for its capability", () => {
    const rows = evidenceByRow([finding("x", { capabilityId: null, featureId: "f-removed" })], capabilityOfFeature);
    expect(rows.byCapability.size).toBe(0);
    expect(rows.byFeature.get("f-removed")).toHaveLength(1);
  });
  it("a second look's finding answers the row it was asked about; an item with no saved match proves nothing yet", () => {
    const rows = evidenceByRow([
      { evidence: e("look", { origin: "second_look" }), item: null, lookCapabilityId: "k-roadmaps" },
      finding("unmatched", { capabilityId: null, featureId: null }),
    ], capabilityOfFeature);
    expect(rows.byCapability.get("k-roadmaps")?.map((x) => x.findingId)).toEqual(["look"]);
    expect(rows.byCapability.size).toBe(1);
  });
  it("the reading's proof is shown before a second look's on the same kind of page", () => {
    expect(rankEvidence([e("look", { origin: "second_look" }), e("read")]).map((x) => x.findingId)).toEqual(["read", "look"]);
  });
});
