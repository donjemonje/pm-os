/** Capability Analysis — the cell rules (analysis/cells.ts): the table is filled in code from the evidence. Pure module. */
import { describe, expect, it } from "vitest";
import { bestDescription, cellFromEvidence, rankEvidence, type Evidence } from "@/lib/competitors/analysis/cells";

const e = (findingId: string, extra: Partial<Evidence> = {}): Evidence => ({ findingId, pageUrl: `https://acme.example/${findingId}`, tier: "strong", pageKind: "product", origin: "research", quote: `quote ${findingId}`, reasoning: "why", wording: "their name", description: null, ...extra });

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
