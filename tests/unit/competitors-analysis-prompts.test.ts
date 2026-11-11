/** Capability Analysis — the parsers of the four prompts (analysis/prompts.ts): bad fields are dropped and counted, never thrown. Pure module. */
import { describe, expect, it } from "vitest";
import {
  lookTool,
  MAX_CAPABILITIES_PER_PAGE,
  MAX_ENUM,
  matchTool,
  MERGE_TOOL,
  parseMatch,
  parseMerge,
  parseResearch,
  parseSecondLook,
  renderMatchTail,
  renderMergeCapabilities,
  renderResearch,
  RESEARCH_TOOL,
  type MatchCatalog,
  type MergeEntry,
} from "@/lib/competitors/analysis/prompts";
import { FACTS_TOOL } from "@/lib/competitors/ai";

const PAGE = `Acme Core
Detect threats across your whole stack in real time.
Single sign-on (SSO) is included in every plan.
Role-based access control lets admins scope every role.
Audit log export sends every admin action to your SIEM.
Contact Jane Doe, CEO of Acme, for a demo.`;

const cap = (name: string, quote: string, features: unknown[] = [], reasoning = "The page says so.") => ({ name, quote, reasoning, features });
const feat = (name: string, quote: string, reasoning = "The page says so.") => ({ name, quote, reasoning });

describe("parseResearch", () => {
  it("keeps a capability and its features, each with the verified quote", () => {
    const r = parseResearch({ capabilities: [cap("Access management", "Single sign-on (SSO) is included in every plan", [feat("RBAC", "Role-based access control lets admins scope every role")])] }, PAGE);
    expect(r.findings).toEqual([
      { kind: "capability", wording: "Access management", parentWording: null, quote: "Single sign-on (SSO) is included in every plan", reasoning: "The page says so." },
      { kind: "feature", wording: "RBAC", parentWording: "Access management", quote: "Role-based access control lets admins scope every role", reasoning: "The page says so." },
    ]);
    expect(r.dropped).toEqual({ noQuote: 0, pii: 0, over: 0 });
  });
  it("a capability whose quote is not on the page is dropped, and its features with it", () => {
    const r = parseResearch({ capabilities: [cap("Threat hunting", "Hunt threats with our autonomous agents", [feat("RBAC", "Role-based access control lets admins scope every role")]), cap("Threat detection", "Detect threats across your whole stack in real time")] }, PAGE);
    expect(r.findings.map((f) => f.wording)).toEqual(["Threat detection"]);
    expect(r.dropped.noQuote).toBe(1);
  });
  it("a feature whose quote fails is dropped alone", () => {
    const r = parseResearch({ capabilities: [cap("Access management", "Single sign-on (SSO) is included in every plan", [feat("SCIM", "SCIM provisioning for every directory"), feat("RBAC", "Role-based access control lets admins scope every role")])] }, PAGE);
    expect(r.findings.map((f) => f.wording)).toEqual(["Access management", "RBAC"]);
    expect(r.dropped.noQuote).toBe(1);
  });
  it("nothing about people: a finding that names a person is dropped", () => {
    const r = parseResearch({ capabilities: [cap("Executive demos", "Contact Jane Doe, CEO of Acme, for a demo")] }, PAGE);
    expect(r.findings).toEqual([]);
    expect(r.dropped.pii).toBe(1);
  });
  it("the same wording twice on one page: the first wins, and its features hang under the first", () => {
    const r = parseResearch({ capabilities: [
      cap("Access Management", "Single sign-on (SSO) is included in every plan", [feat("RBAC", "Role-based access control lets admins scope every role")]),
      cap("access-management™", "Role-based access control lets admins scope every role", [feat("rbac", "Role-based access control lets admins scope every role"), feat("Audit log export", "Audit log export sends every admin action to your SIEM")]),
    ] }, PAGE);
    expect(r.findings.map((f) => `${f.kind}:${f.wording}:${f.parentWording ?? ""}`)).toEqual(["capability:Access Management:", "feature:RBAC:Access Management", "feature:Audit log export:Access Management"]);
  });
  it("caps the list at 40 capabilities per page and counts the rest", () => {
    const many = Array.from({ length: MAX_CAPABILITIES_PER_PAGE + 3 }, (_, i) => cap(`Capability ${i}`, "Detect threats across your whole stack in real time"));
    const r = parseResearch({ capabilities: many }, PAGE);
    expect(r.findings).toHaveLength(MAX_CAPABILITIES_PER_PAGE);
    expect(r.dropped.over).toBe(3);
  });
  it("never throws on a malformed answer", () => {
    expect(parseResearch(null, PAGE).findings).toEqual([]);
    expect(parseResearch({ capabilities: "x" }, PAGE).findings).toEqual([]);
    expect(parseResearch({ capabilities: [null, 3, { name: 7 }, { name: "", quote: "Detect threats across your whole stack" }] }, PAGE).findings).toEqual([]);
  });
  it("renders one page, whole", () => {
    const text = "x".repeat(50_000);
    const out = renderResearch({ url: "https://acme.example/pricing", title: "Pricing", text, kind: "document", sourceLabel: "Website" });
    expect(out.startsWith("PAGE https://acme.example/pricing\nTitle: Pricing\nSource: document · Website\n\n")).toBe(true);
    expect(out.endsWith(text)).toBe(true);
  });
});

describe("parseMerge", () => {
  const e = (code: string, extra: Partial<MergeEntry> = {}): MergeEntry => ({ code, kind: "capability", parentId: null, name: code, pages: 1, quote: "q", known: false, ...extra });
  const entries = [e("M1"), e("M2"), e("M3", { known: true }), e("M4", { known: true }), e("M5", { kind: "feature", parentId: "p1" }), e("M6", { kind: "feature", parentId: "p1" }), e("M7", { kind: "feature", parentId: "p2" })];
  it("drops unknown codes and groups left with one member", () => {
    expect(parseMerge({ groups: [{ members: ["M1", "M2", "M99"] }, { members: ["M3", "nope"] }] }, entries)).toEqual([["M1", "M2"]]);
  });
  it("a code in two groups stays in the first", () => {
    expect(parseMerge({ groups: [{ members: ["M1", "M2"] }, { members: ["M2", "M3", "M1"] }] }, entries)).toEqual([["M1", "M2"]]);
  });
  it("a group that mixes kinds or capabilities is split", () => {
    expect(parseMerge({ groups: [{ members: ["M1", "M5", "M2", "M6", "M7"] }] }, entries)).toEqual([["M1", "M2"], ["M5", "M6"]]);
  });
  it("two KNOWN entries are never merged: only the first stays in the group", () => {
    expect(parseMerge({ groups: [{ members: ["M3", "M4", "M1"] }] }, entries)).toEqual([["M3", "M1"]]);
  });
  it("never throws on a malformed answer", () => {
    expect(parseMerge(null, entries)).toEqual([]);
    expect(parseMerge({ groups: [null, { members: "M1" }, { members: [1, null] }] }, entries)).toEqual([]);
  });
  it("renders the list with KNOWN marks", () => {
    const out = renderMergeCapabilities("Acme", [e("M1", { name: "SSO", pages: 3, quote: 'Single "sign-on"' }), e("M2", { name: "Single sign-on", known: true })]);
    expect(out).toContain("COMPANY: Acme");
    expect(out).toContain(`M1 | SSO | 3 pages | "Single 'sign-on'"`);
    expect(out).toContain(`M2 | Single sign-on | 1 page | "q" | KNOWN`);
  });
});

describe("parseMatch", () => {
  const catalog: MatchCatalog = {
    ours: new Map([["K-aaaaaaaa", { kind: "capability" as const, id: "cap-1" }], ["F-bbbbbbbb", { kind: "feature" as const, id: "feat-1" }]]),
    domains: new Map([["D-11111111", { id: "dom-active", state: "active" }], ["D-22222222", { id: "dom-suggested", state: "suggested" }]]),
  };
  const batch = [{ code: "T1", kind: "capability" as const }, { code: "T2", kind: "feature" as const }, { code: "T3", kind: "capability" as const }];
  const row = (entry: string, extra: Record<string, string> = {}) => ({ entry, ours: "none", domain: "", newDomainName: "", newDomainDefinition: "", closestDomain: "", marketName: "", description: "", ...extra });
  it("a code of ours is a match, to a capability or a feature, whatever the entry's kind", () => {
    const r = parseMatch({ matches: [row("T1", { ours: "F-bbbbbbbb" }), row("T2", { ours: "K-aaaaaaaa", marketName: "ignored" })] }, batch, catalog);
    expect(r.answers).toEqual([
      { entry: "T1", ours: { kind: "feature", id: "feat-1" }, placement: null },
      { entry: "T2", ours: { kind: "capability", id: "cap-1" }, placement: null },
    ]);
  });
  it("an unknown code of ours counts as none, and is reported", () => {
    const r = parseMatch({ matches: [row("T1", { ours: "K-zzzzzzzz", marketName: "Single Sign-On", domain: "D-11111111", closestDomain: "D-11111111" })] }, batch, catalog);
    expect(r.unknownOurs).toEqual(["K-zzzzzzzz"]);
    expect(r.answers[0]).toEqual({ entry: "T1", ours: null, placement: { domainId: "dom-active", newDomainName: "", newDomainDefinition: "", closestDomainId: "dom-active", marketName: "Single Sign-On", description: "" } });
  });
  it("an entry outside the batch is dropped; a duplicate entry keeps the first", () => {
    const r = parseMatch({ matches: [row("T9", { ours: "K-aaaaaaaa" }), row("T1", { ours: "K-aaaaaaaa" }), row("T1")] }, batch, catalog);
    expect(r.answers).toEqual([{ entry: "T1", ours: { kind: "capability", id: "cap-1" }, placement: null }]);
  });
  it("domain: a code of ours, or new with a name; anything else leaves it to the closest domain", () => {
    const r = parseMatch({ matches: [
      row("T1", { domain: "new", newDomainName: "Identity Security", newDomainDefinition: "Controls who gets in.", closestDomain: "D-11111111" }),
      row("T3", { domain: "Identity", newDomainName: "Should be ignored", closestDomain: "D-22222222" }),
    ] }, batch, catalog);
    expect(r.answers[0].placement).toMatchObject({ domainId: null, newDomainName: "Identity Security", newDomainDefinition: "Controls who gets in.", closestDomainId: "dom-active" });
    // Neither a code nor "new": no domain, no new name. And the closest domain must be an ACTIVE one.
    expect(r.answers[1].placement).toMatchObject({ domainId: null, newDomainName: "", closestDomainId: null });
  });
  it("a suggested domain of ours can be the domain", () => {
    const r = parseMatch({ matches: [row("T1", { domain: "D-22222222" })] }, batch, catalog);
    expect(r.answers[0].placement?.domainId).toBe("dom-suggested");
  });
  it("a feature that is none of ours carries no domain: it follows its capability", () => {
    const r = parseMatch({ matches: [row("T2", { domain: "D-11111111", closestDomain: "D-11111111", marketName: "SCIM provisioning" })] }, batch, catalog);
    expect(r.answers[0].placement).toEqual({ domainId: null, newDomainName: "", newDomainDefinition: "", closestDomainId: null, marketName: "SCIM provisioning", description: "" });
  });
  it("a market name or description that names a person is emptied", () => {
    const r = parseMatch({ matches: [row("T1", { marketName: "Founder John Smith", description: "Write to sales@acme.example" })] }, batch, catalog);
    expect(r.answers[0].placement).toMatchObject({ marketName: "", description: "" });
  });
  it("our codes ride in the schema as an enum only while the set is small", () => {
    const small = matchTool(["T1"], catalog) as { input_schema: { properties: { matches: { items: { properties: Record<string, { enum?: string[] }> } } } } };
    expect(small.input_schema.properties.matches.items.properties.entry.enum).toEqual(["T1"]);
    expect(small.input_schema.properties.matches.items.properties.ours.enum).toEqual(["none", "K-aaaaaaaa", "F-bbbbbbbb"]);
    const big: MatchCatalog = { ours: new Map(Array.from({ length: MAX_ENUM + 1 }, (_, i) => [`K-${i}`, { kind: "capability" as const, id: `c${i}` }])), domains: catalog.domains };
    const large = matchTool(["T1"], big) as typeof small;
    expect(large.input_schema.properties.matches.items.properties.ours.enum).toBeUndefined();
    expect(large.input_schema.properties.matches.items.properties.domain.enum).toEqual(["none", "new", "D-11111111", "D-22222222"]);
    expect(large.input_schema.properties.matches.items.properties.closestDomain.enum).toEqual(["none", "D-11111111", "D-22222222"]);
  });
  it('"none" for a domain is no domain: the parser reads it like an empty answer', () => {
    const r = parseMatch({ matches: [row("T1", { domain: "none", closestDomain: "none", marketName: "SCIM provisioning" }), row("T2", { domain: "none", closestDomain: "none" })] }, batch, catalog);
    expect(r.answers[0].placement).toEqual({ domainId: null, newDomainName: "", newDomainDefinition: "", closestDomainId: null, marketName: "SCIM provisioning", description: "" });
    expect(r.answers[1].placement).toMatchObject({ domainId: null, closestDomainId: null });
    expect(r.unknownOurs).toEqual([]);
  });
  it("renders their list: a capability, then its features", () => {
    const out = renderMatchTail("Acme", ["Identity Security"], [
      { code: "T1", kind: "capability", parent: null, name: "Access management", quote: "Single sign-on" },
      { code: "T2", kind: "feature", parent: { code: "T1" }, name: "RBAC", quote: "Role-based access" },
    ]);
    expect(out).toContain("DOMAINS PROPOSED EARLIER IN THIS RUN: Identity Security");
    expect(out).toContain(`T1 | capability | Access management | "Single sign-on"\n  T2 | feature of T1 | RBAC | "Role-based access"`);
  });
});

describe("parseSecondLook", () => {
  const pages = [{ id: "p1", url: "https://acme.example/features", text: PAGE }, { id: "p2", url: "https://acme.example/pricing", text: "Plans start at ten seats. Enterprise adds audit log export." }];
  const answer = (extra: Record<string, unknown> = {}) => ({ found: true, quote: "Single sign-on (SSO) is included in every plan", url: "https://acme.example/features", theirName: "SSO", reasoning: "Every plan includes it.", ...extra });
  it("found: the page, the verified quote, their name, the reasoning", () => {
    expect(parseSecondLook(answer(), pages)).toEqual({ found: true, pageId: "p1", quote: "Single sign-on (SSO) is included in every plan", wording: "SSO", reasoning: "Every plan includes it." });
  });
  it("not found when the model says so", () => {
    expect(parseSecondLook({ found: false, quote: "", url: "", theirName: "", reasoning: "" }, pages)).toEqual({ found: false, quoteDropped: false });
  });
  it('not found with url "none" (what the schema offers for "no page")', () => {
    expect(parseSecondLook({ found: false, quote: "", url: "none", theirName: "", reasoning: "" }, pages)).toEqual({ found: false, quoteDropped: false });
    expect(parseSecondLook(answer({ url: "none" }), pages)).toEqual({ found: false, quoteDropped: false });
  });
  it("a page that was not offered does not count", () => {
    expect(parseSecondLook(answer({ url: "https://acme.example/other" }), pages)).toEqual({ found: false, quoteDropped: false });
  });
  it("a quote that is not on THAT page does not count, and is counted as dropped", () => {
    expect(parseSecondLook(answer({ url: "https://acme.example/pricing" }), pages)).toEqual({ found: false, quoteDropped: true });
  });
  it("nothing about people", () => {
    expect(parseSecondLook(answer({ quote: "Contact Jane Doe, CEO of Acme, for a demo" }), pages)).toEqual({ found: false, quoteDropped: false });
  });
});

describe("the response schemas a model is sent", () => {
  /** Every enum in a schema, wherever it sits. */
  const enums = (node: unknown, path = "$"): Array<{ path: string; values: unknown[] }> => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((n, i) => enums(n, `${path}[${i}]`));
    const o = node as Record<string, unknown>;
    return [...(Array.isArray(o.enum) ? [{ path, values: o.enum }] : []), ...Object.entries(o).filter(([k]) => k !== "enum").flatMap(([k, v]) => enums(v, `${path}.${k}`))];
  };
  const catalog: MatchCatalog = {
    ours: new Map([["K-aaaaaaaa", { kind: "capability" as const, id: "cap-1" }]]),
    domains: new Map([["D-11111111", { id: "dom-active", state: "active" }]]),
  };
  const tools: Array<[string, Record<string, unknown>]> = [
    ["research", RESEARCH_TOOL],
    ["merge", MERGE_TOOL],
    ["match", matchTool(["T1", "T2"], catalog)],
    ["second look", lookTool(["https://acme.example/features", "https://acme.example/pricing"])],
    ["facts", FACTS_TOOL],
  ];
  it("no enum holds an empty string: Gemini refuses the whole request (HTTP 400 — the first real run failed on it)", () => {
    for (const [name, tool] of tools) {
      for (const e of enums(tool)) {
        expect(e.values.length, `${name} ${e.path}`).toBeGreaterThan(0);
        for (const v of e.values) expect(typeof v === "string" && v.trim().length > 0, `${name} ${e.path}: ${JSON.stringify(v)}`).toBe(true);
      }
    }
  });
  it('a field that may stay without a value offers "none" in its closed set', () => {
    const match = matchTool(["T1"], catalog) as { input_schema: { properties: { matches: { items: { properties: Record<string, { enum?: string[] }> } } } } };
    expect(match.input_schema.properties.matches.items.properties.domain.enum?.[0]).toBe("none");
    expect(match.input_schema.properties.matches.items.properties.closestDomain.enum?.[0]).toBe("none");
    const look = lookTool(["https://acme.example/features"]) as { input_schema: { properties: Record<string, { enum?: string[] }> } };
    expect(look.input_schema.properties.url.enum).toEqual(["none", "https://acme.example/features"]);
  });
});
