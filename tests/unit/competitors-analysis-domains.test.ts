/** Capability Analysis — the setup run's domains step (analysis/domains.ts): the input, the answer's closed sets, every row exactly one domain, the stable order. Pure module. */
import { describe, expect, it } from "vitest";
import { DOMAINS_SYSTEM_PROMPT, domainKey, domainsTool, knownDomains, parseDomains, planCatalog, renderDomains, rowsWithoutDomain, type DomainsRow } from "@/lib/competitors/analysis/domains";
import { rowKey } from "@/lib/competitors/analysis/unify";

const AHA = { name: "Aha", isOwn: true };
const row = (code: string, name: string, companies: Array<{ name: string; isOwn: boolean }>, ownNames: string[] = [], features: string[] = []): DomainsRow => ({ code, key: rowKey(name), name, description: `${name} description.`, companies, ownNames, features, ours: companies.some((c) => c.isOwn) });
const rows: DomainsRow[] = [
  row("R1", "Feedback Collection", [AHA, { name: "Enterpret", isOwn: false }], ["Idea portal"], ["Feedback forms", "Email intake"]),
  row("R2", "Product Roadmaps", [AHA, { name: "Bagel AI", isOwn: false }], ["Roadmaps"]),
  row("R3", "Feedback Theme Detection", [{ name: "Enterpret", isOwn: false }]),
  row("R4", "Single Sign-On", [{ name: "Bagel AI", isOwn: false }]),
];
// R1 Feedback Collection, R2 Product Roadmaps, R3 Feedback Theme Detection, R4 Single Sign-On
const key = (code: string) => rows.find((r) => r.code === code)!.key;

describe("the input of the domains call", () => {
  const text = renderDomains("Aha", [{ name: "Ideas", description: "Collect and rank feedback." }, { name: "Roadmaps", description: "" }], [], rows);
  it("carries the client's own language: its product lines and what it calls its capabilities", () => {
    expect(text).toContain("ITS PRODUCT LINES:\n- Ideas — Collect and rank feedback.\n- Roadmaps");
    expect(text).toContain('R1 | Feedback Collection | Feedback Collection description. | offered by: Aha (the organization itself), Enterpret | the organization calls it: "Idea portal" | features: Feedback forms; Email intake');
  });
  it("lists every row with its code, name, description and the companies that have it", () => {
    expect(text).toContain("R3 | Feedback Theme Detection | Feedback Theme Detection description. | offered by: Enterpret");
    expect(text).toContain("R4 | Single Sign-On | Single Sign-On description. | offered by: Bagel AI");
    expect(text).not.toContain("DOMAINS SO FAR");
  });
  it("an organization with no product line says so", () => {
    expect(renderDomains("Aha", [], [], rows)).toContain("ITS PRODUCT LINES:\nnone given");
  });
  it("a follow-up call lists the domains made so far with their codes", () => {
    const known = knownDomains([{ key: domainKey("Customer Feedback"), name: "Customer Feedback", definition: "Collecting and understanding feedback." }]);
    expect(known[0].code).toBe("D1");
    expect(renderDomains("Aha", [], known, rows.slice(3))).toContain("DOMAINS SO FAR:\nD1 | Customer Feedback | Collecting and understanding feedback.");
  });
  it("the prompt: no limit, no target, no other bucket, the client's language weighs heavily but is not the truth", () => {
    expect(DOMAINS_SYSTEM_PROMPT).toContain("no limit on the number of domains");
    expect(DOMAINS_SYSTEM_PROMPT).toContain('no "other" or "miscellaneous" domain');
    expect(DOMAINS_SYSTEM_PROMPT).toContain("weighs heavily");
    expect(DOMAINS_SYSTEM_PROMPT).toContain("It is not the truth");
    expect(DOMAINS_SYSTEM_PROMPT).toContain("Every row gets exactly one domain");
    expect(DOMAINS_SYSTEM_PROMPT).toContain("where are we ahead and where are we behind");
  });
  it("the row codes ride in the schema as a closed set", () => {
    const tool = domainsTool(rows.map((r) => r.code)) as { input_schema: { properties: { rows: { items: { properties: { row: { enum?: string[] } } } } } } };
    expect(tool.input_schema.properties.rows.items.properties.row.enum).toEqual(["R1", "R2", "R3", "R4"]);
  });
});

describe("the answer of a domains call", () => {
  const good = {
    domains: [
      { code: "D1", name: "Customer Feedback", definition: "Collecting and understanding feedback." },
      { code: "D2", name: "Roadmapping", definition: "Planning what is built." },
      { code: "D3", name: "Security and Access", definition: "Who gets in." },
    ],
    rows: [{ row: "R1", domain: "D1" }, { row: "R2", domain: "D2" }, { row: "R3", domain: "D1" }, { row: "R4", domain: "D3" }],
  };
  it("every row gets exactly one domain", () => {
    const r = parseDomains(good, rows, []);
    expect(r.problems).toEqual([]);
    expect(r.missing).toEqual([]);
    expect([...r.assigned.entries()]).toEqual([[key("R1"), domainKey("Customer Feedback")], [key("R2"), domainKey("Roadmapping")], [key("R3"), domainKey("Customer Feedback")], [key("R4"), domainKey("Security and Access")]]);
    expect(r.created.map((d) => d.name)).toEqual(["Customer Feedback", "Roadmapping", "Security and Access"]);
  });
  it("a row code that was not given makes the answer unusable", () => {
    expect(parseDomains({ ...good, rows: [...good.rows, { row: "R9", domain: "D1" }] }, rows, []).problems[0]).toContain("R9");
  });
  it("a domain code that is neither given nor created in the answer makes the answer unusable", () => {
    expect(parseDomains({ domains: good.domains, rows: [{ row: "R1", domain: "D7" }] }, rows, []).problems[0]).toContain("D7");
    expect(parseDomains({ domains: [], rows: [{ row: "R1", domain: "Customer Feedback" }] }, rows, []).problems).toHaveLength(1);
    expect(parseDomains({ domains: [], rows: [{ row: "R1", domain: "none" }] }, rows, []).problems).toHaveLength(1);
  });
  it("a row put in two domains makes the answer unusable; the same answer twice is one answer", () => {
    expect(parseDomains({ domains: good.domains, rows: [{ row: "R1", domain: "D1" }, { row: "R1", domain: "D2" }] }, rows, []).problems[0]).toContain("two domains");
    const twice = parseDomains({ domains: good.domains, rows: [{ row: "R1", domain: "D1" }, { row: "R1", domain: "D1" }] }, rows, []);
    expect(twice.problems).toEqual([]);
    expect(twice.assigned.size).toBe(1);
  });
  it("a new domain needs a code that is not in use and a name", () => {
    expect(parseDomains({ domains: [{ code: "", name: "A", definition: "" }], rows: [] }, rows, []).problems[0]).toContain("no code");
    // Any code the answer declares that is not in use is its own.
    expect(parseDomains({ domains: [{ code: "X1", name: "A", definition: "" }], rows: [{ row: "R1", domain: "X1" }] }, rows, []).problems).toEqual([]);
    expect(parseDomains({ domains: [{ code: "D1", name: " ", definition: "d" }], rows: [] }, rows, []).problems[0]).toContain("no name");
    expect(parseDomains({ domains: [{ code: "D1", name: "A", definition: "" }, { code: "D1", name: "B", definition: "" }], rows: [] }, rows, []).problems[0]).toContain("already in use");
    const known = knownDomains([{ key: domainKey("Customer Feedback"), name: "Customer Feedback", definition: "x" }]);
    expect(parseDomains({ domains: [{ code: "D1", name: "Roadmapping", definition: "" }], rows: [] }, rows, known).problems[0]).toContain("already in use");
  });
  it("rows the answer leaves out are reported as missing, not guessed", () => {
    const r = parseDomains({ domains: good.domains, rows: good.rows.slice(0, 2) }, rows, []);
    expect(r.problems).toEqual([]);
    expect(r.missing).toEqual([key("R3"), key("R4")]);
  });
  it("a domain no row was put in is dropped", () => {
    const r = parseDomains({ domains: [...good.domains, { code: "D4", name: "Empty Area", definition: "" }], rows: good.rows }, rows, []);
    expect(r.created.map((d) => d.name)).not.toContain("Empty Area");
  });
  it("a new domain with the normalized name of one that exists IS that domain", () => {
    const known = knownDomains([{ key: domainKey("Customer Feedback"), name: "Customer Feedback", definition: "The first definition." }]);
    const r = parseDomains({ domains: [{ code: "D2", name: "customer  feedback", definition: "Other." }], rows: [{ row: "R3", domain: "D2" }, { row: "R1", domain: "D1" }] }, rows, known);
    expect(r.problems).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.assigned.get(key("R3"))).toBe(domainKey("Customer Feedback"));
    expect(r.assigned.get(key("R1"))).toBe(domainKey("Customer Feedback"));
  });
  it("there is no limit on the number of domains: a domain per row is a usable answer", () => {
    const r = parseDomains({ domains: rows.map((x, n) => ({ code: `D${n + 1}`, name: `Area ${n + 1}`, definition: "" })), rows: rows.map((x, n) => ({ row: x.code, domain: `D${n + 1}` })) }, rows, []);
    expect(r.problems).toEqual([]);
    expect(r.created).toHaveLength(rows.length);
  });
});

describe("the catalog the step creates", () => {
  const drafts = [
    { key: domainKey("Security and Access"), name: "Security and Access", definition: "Who gets in." },
    { key: domainKey("Customer Feedback"), name: "Customer Feedback", definition: "Feedback." },
    { key: domainKey("Roadmapping"), name: "Roadmapping", definition: "Plans." },
  ];
  const assigned = new Map([[key("R1"), drafts[1].key], [key("R2"), drafts[2].key], [key("R3"), drafts[1].key], [key("R4"), drafts[0].key]]);
  const catalog = planCatalog(rows, assigned, drafts);
  it("has a stable order: domains by their first row, rows in the fixed order of the items — whatever order the answer listed them in", () => {
    expect(catalog.map((d) => [d.name, d.position])).toEqual([["Customer Feedback", 0], ["Roadmapping", 1], ["Security and Access", 2]]);
    expect(catalog.map((d) => d.rows.map((r) => r.row.name))).toEqual([["Feedback Collection", "Feedback Theme Detection"], ["Product Roadmaps"], ["Single Sign-On"]]);
    expect(planCatalog(rows, assigned, [...drafts].reverse()).map((d) => d.name)).toEqual(catalog.map((d) => d.name));
  });
  it("capability positions count through the whole table in that order", () => {
    expect(catalog.flatMap((d) => d.rows.map((r) => [r.row.name, r.position]))).toEqual([["Feedback Collection", 0], ["Feedback Theme Detection", 1], ["Product Roadmaps", 2], ["Single Sign-On", 3]]);
  });
  it("a row the organization has — its own capability on it, or any feature of its own under it — starts as ours", () => {
    expect(catalog.flatMap((d) => d.rows.map((r) => [r.row.name, r.row.ours]))).toEqual([["Feedback Collection", true], ["Feedback Theme Detection", false], ["Product Roadmaps", true], ["Single Sign-On", false]]);
  });
  it("every row is in exactly one domain", () => {
    const all = catalog.flatMap((d) => d.rows.map((r) => r.row.key));
    expect(all.sort()).toEqual(rows.map((r) => r.key).sort());
    expect(new Set(all).size).toBe(all.length);
  });
  it("a row with no domain is never left out silently: no catalog is planned", () => {
    const partial = new Map(assigned);
    partial.delete(key("R3"));
    expect(() => planCatalog(rows, partial, drafts)).toThrow(/Feedback Theme Detection/);
    expect(() => planCatalog(rows, new Map([...assigned, [key("R4"), "no such domain"]]), drafts)).toThrow(/Single Sign-On/);
  });
});

describe("every row in exactly one domain — checked before the catalog is created", () => {
  it("a row with no domain is named; a full assignment has none", () => {
    expect(rowsWithoutDomain(rows, new Map([[rows[0].key, "d"], [rows[1].key, "d"]]))).toEqual([rows[2].key, rows[3].key]);
    expect(rowsWithoutDomain(rows, new Map(rows.map((r) => [r.key, "d"])))).toEqual([]);
  });
  it("an answer that puts one row in two domains is unusable — nothing of it is used", () => {
    const parsed = parseDomains({ domains: [{ code: "D1", name: "Feedback", definition: "" }, { code: "D2", name: "Planning", definition: "" }], rows: [{ row: "R1", domain: "D1" }, { row: "R1", domain: "D2" }] }, rows, []);
    expect(parsed.problems).toEqual(["row R1 was put in two domains — every row has exactly one"]);
  });
  it("no catch-all: the prompt forbids one domain for what is left", () => {
    expect(DOMAINS_SYSTEM_PROMPT).toContain("do not make one catch-all domain for what is left");
  });
});
