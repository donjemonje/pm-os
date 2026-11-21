/** Capability Analysis — the map, the match and the second look (analysis/prompts.ts): what is rendered, and what each parser keeps. Pure module. The reading's prompts are tested in competitors-analysis-reading.test.ts, unify's and the domains' next to their rules. */
import { describe, expect, it } from "vitest";
import {
  injectedMapAnswer,
  injectedMapPagesAnswer,
  LLMS_TXT_MAX_CHARS,
  LOOK_SYSTEM_PROMPT,
  lookTool,
  MAP_MAX_SECTIONS,
  MAP_PAGES_BATCH,
  MAP_PAGES_SYSTEM_PROMPT,
  MAP_SYSTEM_PROMPT,
  MAP_VERSION,
  mapPagesTool,
  mapTool,
  MATCH_SYSTEM_PROMPT,
  MAX_ENUM,
  matchTool,
  parseLook,
  parseMap,
  parseMapPages,
  parseMatch,
  renderLook,
  renderMap,
  renderMapPages,
  renderMatchTail,
  type LookRow,
  type MapEntry,
  type MapPageEntry,
  type MatchCatalog,
} from "@/lib/competitors/analysis/prompts";
import { READ_TOOL, readChangesTool, WHERE_A_PM_LOOKS, type RequestPage } from "@/lib/competitors/analysis/reading";
import { MAP_OPENING_CHARS, SECTION_LABELS } from "@/lib/competitors/analysis/sections";
import { unifyCapabilitiesTool, unifyFeaturesTool, unifyReviewTool } from "@/lib/competitors/analysis/unify";
import { domainsTool } from "@/lib/competitors/analysis/domains";

describe("the map — parseMap, renderMap", () => {
  const entry = (code: string, path: string, pages = 3, extra: Partial<MapEntry["section"]> = {}): MapEntry => ({
    code,
    section: {
      prefix: `acme.example${path}`, pages,
      samples: [{ url: `https://www.acme.example${path}`, title: `Title of ${path}`, opening: `What ${path} does, in its own first lines.` }, { url: `https://www.acme.example${path}/a`, title: "", opening: "" }],
      ...extra,
    },
  });
  const codes = ["S1", "S2", "S3"];
  const answer = (...rows: Array<[string, string]>) => ({ sections: rows.map(([code, label]) => ({ code, label })) });

  it("a label per asked code", () => {
    const r = parseMap(answer(["S1", "product"], ["S2", "noise"], ["S3", "release_notes"]), codes);
    expect([...r.labels.entries()]).toEqual([["S1", "product"], ["S2", "noise"], ["S3", "release_notes"]]);
    expect(r.unknownCodes).toEqual([]);
    expect(r.unknownLabels).toEqual([]);
  });
  it("a code that was not asked is reported, never saved — the step fails the run on it", () => {
    const r = parseMap(answer(["S1", "product"], ["S9", "help"], ["", "help"]), codes);
    expect([...r.labels.keys()]).toEqual(["S1"]);
    expect(r.unknownCodes).toEqual(["S9", "(none)"]);
  });
  it("a label outside the closed set is reported, never guessed", () => {
    const r = parseMap(answer(["S1", "products"], ["S2", "documentation"], ["S3", ""]), codes);
    expect(r.labels.size).toBe(0);
    expect(r.unknownLabels).toEqual(["products", "documentation", "(none)"]);
  });
  it("a code answered twice keeps its first label; a code left out is simply missing", () => {
    const r = parseMap(answer(["S1", "pricing"], ["S1", "noise"]), codes);
    expect([...r.labels.entries()]).toEqual([["S1", "pricing"]]);
    expect(r.unknownCodes).toEqual([]);
  });
  it("never throws on a malformed answer", () => {
    for (const bad of [null, undefined, "text", 5, {}, { sections: "no" }, { sections: [null, 7, "x"] }]) expect(() => parseMap(bad, codes)).not.toThrow();
    expect(parseMap({ sections: [null] }, codes).unknownCodes).toEqual(["(none)"]);
  });
  it("renders the company, the site and every section: code, prefix, pages — then its sample pages, each with its address, title and first lines", () => {
    const text = renderMap({ name: "Acme", site: "https://www.acme.example" }, [entry("S1", "/prisma", 34), entry("S2", "/hc", 1, { sourceLabel: "Help center", samples: [] })], null);
    expect(text).toContain("COMPANY: Acme\nSITE: https://www.acme.example\n\nSECTIONS:\n");
    expect(text).toContain('S1 | acme.example/prisma | 34 pages\n  - /prisma | title: "Title of /prisma" | first lines: "What /prisma does, in its own first lines."\n  - /prisma/a | title: none | first lines: none');
    expect(text).toContain("S2 | acme.example/hc | 1 page | source: Help center");
    expect(text).not.toContain("LLMS.TXT");
  });
  it("the map skims: a sample's first lines are shown up to MAP_OPENING_CHARS and no further; the prompt says to decide from them first", () => {
    const opening = "x".repeat(MAP_OPENING_CHARS + 50);
    const text = renderMap({ name: "Acme", site: "s" }, [entry("S1", "/prisma", 3, { samples: [{ url: "https://www.acme.example/prisma", title: 'The "Prisma" page', opening }] })], null);
    expect(text).toContain(`first lines: "${"x".repeat(MAP_OPENING_CHARS)}…"`);
    expect(text).toContain("title: \"The 'Prisma' page\"");
    expect(MAP_SYSTEM_PROMPT).toContain("the first lines of its own text");
    expect(MAP_SYSTEM_PROMPT).toContain("decide from their first lines first");
    expect(MAP_VERSION).toBe("map-2");
  });
  it("carries the site's llms.txt when there is one, cut to the limit", () => {
    const text = renderMap({ name: "Acme", site: "https://www.acme.example" }, [entry("S1", "/prisma")], `# Acme\n${"x".repeat(LLMS_TXT_MAX_CHARS)}`);
    expect(text).toContain("LLMS.TXT:\n# Acme\n");
    expect(text.indexOf("LLMS.TXT:")).toBeLessThan(text.indexOf("SECTIONS:"));
    const llms = text.slice(text.indexOf("LLMS.TXT:\n") + 10, text.indexOf("\n\nSECTIONS:"));
    expect(llms.length).toBe(LLMS_TXT_MAX_CHARS);
    expect(renderMap({ name: "Acme", site: "s" }, [entry("S1", "/prisma")], "   ")).not.toContain("LLMS.TXT");
  });
  it("the codes and the labels ride in the schema as closed sets — a call never asks more sections than an enum holds", () => {
    const tool = mapTool(["S1", "S2"]) as { input_schema: { properties: { sections: { items: { properties: { code: { enum?: string[] }; label: { enum?: string[] } } } } } } };
    expect(tool.input_schema.properties.sections.items.properties.code.enum).toEqual(["S1", "S2"]);
    expect(tool.input_schema.properties.sections.items.properties.label.enum).toEqual([...SECTION_LABELS]);
    expect(MAP_MAX_SECTIONS).toBeLessThanOrEqual(MAX_ENUM);
  });
  it("TEST KNOB: the injected answer is built from labels by section address — full prefix, path, or * — and unnamed sections are product", () => {
    const entries = [entry("S1", "/blog"), entry("S2", "/customers"), entry("S3", "/prisma")];
    expect(JSON.parse(injectedMapAnswer({ "acme.example/blog": "news", "/customers": "noise" }, entries))).toEqual(answer(["S1", "news"], ["S2", "noise"], ["S3", "product"]));
    expect(JSON.parse(injectedMapAnswer({ "*": "help", "/prisma": "product" }, entries))).toEqual(answer(["S1", "help"], ["S2", "help"], ["S3", "product"]));
    expect(JSON.parse(injectedMapAnswer(undefined, entries))).toEqual(answer(["S1", "product"], ["S2", "product"], ["S3", "product"]));
    // It goes through the same parser: a word outside the labels is an unusable answer.
    expect(parseMap(JSON.parse(injectedMapAnswer({ "/blog": "bogus" }, entries)), ["S1", "S2", "S3"]).unknownLabels).toEqual(["bogus"]);
  });
});


describe("the map, page by page — release notes inside a help center or a blog", () => {
  const entries: MapPageEntry[] = [
    { code: "P1", url: "https://support.acme.example/hc/en-us/articles/360060759874-Acme-Release-Notes", title: "Acme Release Notes", label: "help" },
    { code: "P2", url: "https://support.acme.example/hc/en-us/articles/111-How-to-add-a-user", title: "How to add a user", label: "help" },
    { code: "P3", url: "https://www.acme.example/blog/changelog-may-2026", title: "Changelog: May 2026", label: "news" },
    { code: "P4", url: "https://www.acme.example/blog/why-roadmaps-fail", title: "", label: "news" },
  ];
  const codes = entries.map((e) => e.code);
  it("the call shows each page with its code, the kind of place it sits in, its address and its title — never its text", () => {
    expect(renderMapPages("Acme", entries)).toBe([
      "COMPANY: Acme", "", "PAGES:",
      'P1 | help center | support.acme.example/hc/en-us/articles/360060759874-Acme-Release-Notes | "Acme Release Notes"',
      'P2 | help center | support.acme.example/hc/en-us/articles/111-How-to-add-a-user | "How to add a user"',
      'P3 | blog | www.acme.example/blog/changelog-may-2026 | "Changelog: May 2026"',
      "P4 | blog | www.acme.example/blog/why-roadmaps-fail | no title",
    ].join("\n"));
    expect(MAP_PAGES_BATCH).toBe(400);
  });
  it("the answer names the release-notes pages by code; every other page of the call is not one", () => {
    const r = parseMapPages({ release_notes: ["P1", "P3", "P3"] }, codes);
    expect([...r.releaseNotes]).toEqual(["P1", "P3"]);
    expect(r.unknownCodes).toEqual([]);
    expect(parseMapPages({ release_notes: [] }, codes).releaseNotes.size).toBe(0);
  });
  it("a closed set: a code that was not asked is reported, never guessed — the step fails the run on it", () => {
    expect(parseMapPages({ release_notes: ["P1", "P9", ""] }, codes).unknownCodes).toEqual(["P9", "(none)"]);
    for (const bad of [null, "x", {}, { release_notes: "P1" }]) expect(parseMapPages(bad, codes).releaseNotes.size).toBe(0);
  });
  it("the prompt says what a release-notes page is and is not, and that most help centers and blogs have none", () => {
    for (const line of ["what was shipped in the product", "A how-to article, a guide, a FAQ", "is NOT one", "an empty list is a correct answer", "Use only the codes given"]) expect(MAP_PAGES_SYSTEM_PROMPT).toContain(line);
    expect(JSON.stringify(mapPagesTool(codes))).toContain('"enum":["P1","P2","P3","P4"]');
    expect(JSON.stringify(mapPagesTool(Array.from({ length: 400 }, (_, i) => `P${i + 1}`)))).not.toContain('"enum"');
  });
  it("TEST KNOB: the injected answer is built from a test's list of addresses or paths, and goes through the same parser", () => {
    const injected = JSON.parse(injectedMapPagesAnswer(["/blog/changelog-may-2026", "https://support.acme.example/hc/en-us/articles/360060759874-Acme-Release-Notes"], entries));
    expect(injected).toEqual({ release_notes: ["P1", "P3"] });
    expect(JSON.parse(injectedMapPagesAnswer(undefined, entries))).toEqual({ release_notes: [] });
  });
});

describe("the match — after setup: a company's new items against the rows that exist", () => {
  const catalog: MatchCatalog = {
    ours: new Map([["K-aaaaaaaa", { kind: "capability" as const, id: "cap-1" }], ["F-bbbbbbbb", { kind: "feature" as const, id: "feat-1" }]]),
    domains: new Map([["D-11111111", { id: "dom-active", state: "active" }], ["D-22222222", { id: "dom-suggested", state: "suggested" }]]),
  };
  const batch = [{ code: "T1", kind: "capability" as const }, { code: "T2", kind: "feature" as const }, { code: "T3", kind: "capability" as const }];
  const m = (entry: string, ours: string, extra: Record<string, unknown> = {}) => ({ entry, ours, domain: "none", marketName: "", description: "", ...extra });
  it("an entry that is one of ours carries our row; an entry outside the batch is dropped; a duplicate keeps the first", () => {
    const r = parseMatch({ matches: [m("T1", "K-aaaaaaaa"), m("T2", "F-bbbbbbbb"), m("T9", "K-aaaaaaaa"), m("T1", "none")] }, batch, catalog);
    expect(r.answers).toEqual([{ entry: "T1", ours: { kind: "capability", id: "cap-1" }, placement: null }, { entry: "T2", ours: { kind: "feature", id: "feat-1" }, placement: null }]);
  });
  it("what matches nothing becomes a new row in an EXISTING domain: a capability names a domain of ours", () => {
    const r = parseMatch({ matches: [m("T1", "none", { domain: "D-11111111", marketName: "Session Recording", description: "Records user sessions." })] }, batch, catalog);
    expect(r.answers).toEqual([{ entry: "T1", ours: null, placement: { domainId: "dom-active", marketName: "Session Recording", description: "Records user sessions." } }]);
    expect(r.noDomain).toEqual([]);
  });
  it("no new domain is made: a capability that names no domain of ours is NOT answered — it is asked again, no domain is guessed", () => {
    const r = parseMatch({ matches: [m("T1", "none", { domain: "new", marketName: "X" }), m("T3", "none", { domain: "none", marketName: "Y" })] }, batch, catalog);
    expect(r.answers).toEqual([]);
    expect(r.noDomain).toEqual(["T1", "T3"]);
    expect(MATCH_SYSTEM_PROMPT).toContain("Always one of ours — no new domain is made here");
    expect(JSON.stringify(matchTool(["T1"], catalog))).not.toContain("newDomainName");
  });
  it("a feature that is none of ours carries no domain: it follows its capability", () => {
    const r = parseMatch({ matches: [m("T2", "none", { domain: "D-11111111", marketName: "SAML", description: "Signs in with SAML." })] }, batch, catalog);
    expect(r.answers).toEqual([{ entry: "T2", ours: null, placement: { domainId: null, marketName: "SAML", description: "Signs in with SAML." } }]);
  });
  it("an unknown code of ours counts as none, and is reported", () => {
    const r = parseMatch({ matches: [m("T2", "K-zzzzzzzz", { marketName: "X" })] }, batch, catalog);
    expect(r.unknownOurs).toEqual(["K-zzzzzzzz"]);
    expect(r.answers[0]).toMatchObject({ ours: null });
  });
  it("a market name or description that names a person is emptied", () => {
    const r = parseMatch({ matches: [m("T2", "none", { marketName: "Jane Doe, CEO of Acme, dashboard", description: "Built by jane.doe@acme.example." })] }, batch, catalog);
    expect(r.answers[0].placement?.description).toBe("");
  });
  it("our codes ride in the schema as an enum only while the set is small", () => {
    const tool = matchTool(["T1"], catalog) as { input_schema: { properties: { matches: { items: { properties: Record<string, { enum?: string[] }> } } } } };
    const props = tool.input_schema.properties.matches.items.properties;
    expect(props.entry.enum).toEqual(["T1"]);
    expect(props.ours.enum).toEqual(["none", "K-aaaaaaaa", "F-bbbbbbbb"]);
    expect(props.domain.enum).toEqual(["none", "D-11111111", "D-22222222"]);
    const big: MatchCatalog = { ours: new Map(Array.from({ length: MAX_ENUM + 5 }, (_, i) => [`K-${i}`, { kind: "capability" as const, id: `c${i}` }])), domains: catalog.domains };
    expect((matchTool(["T1"], big) as typeof tool).input_schema.properties.matches.items.properties.ours.enum).toBeUndefined();
  });
  it("renders their list: a capability with what it does, then its features", () => {
    const text = renderMatchTail("Acme", [
      { code: "T1", kind: "capability", name: "Session replay", description: "Records what users do.", quote: 'Watch every "session" again', parent: null },
      { code: "T2", kind: "feature", name: "Rage clicks", description: "", quote: "", parent: { code: "T1" } },
      { code: "T3", kind: "feature", name: "Heatmaps", description: "Shows where users click.", quote: "", parent: { name: "Analytics" } },
    ]);
    expect(text).toBe(`COMPANY: Acme\n\nTHEIR LIST:\nT1 | capability | Session replay — Records what users do. | "Watch every 'session' again"\n  T2 | feature of T1 | Rage clicks\n  T3 | feature of "Analytics" | Heatmaps — Shows where users click.`);
  });
  it("never throws on a malformed answer", () => {
    for (const bad of [null, "x", {}, { matches: "no" }, { matches: [null, 7] }]) expect(parseMatch(bad, batch, catalog).answers).toEqual([]);
  });
});

describe("the second look, in bulk — once per chunk of a company's pages", () => {
  const rows: LookRow[] = [
    { code: "R1", capabilityId: "k-sso", name: "Single Sign-On", description: "Signs users in through the company's identity provider.", aliases: ["SSO"], domain: "Security" },
    { code: "R2", capabilityId: "k-audit", name: "Audit Log", description: "", aliases: [], domain: "Security" },
  ];
  const pages: RequestPage[] = [
    { code: "P1", id: "page-1", url: "https://acme.example/security", hash: "h1", text: "Security\nSingle sign-on with SAML is included in every plan." },
    { code: "P2", id: "page-2", url: "https://acme.example/admin", hash: "h2", text: "Admin\nEvery admin action is written to the audit trail and can be exported." },
  ];
  it("the call lists the rows of ours that are looked for — code, name, what it is, other names, its domain — then the pages", () => {
    expect(renderLook("Acme", rows, "=== PAGE P1 …")).toBe([
      "COMPANY: Acme", "", "CAPABILITIES OF OURS TO LOOK FOR:",
      "R1 | Single Sign-On — Signs users in through the company's identity provider. (also known as: SSO) | domain: Security",
      "R2 | Audit Log | domain: Security",
      "", "=== PAGE P1 …",
    ].join("\n"));
  });
  it("which of these does the company offer? — a row counts as found with its quote, on the page it names", () => {
    const r = parseLook({ found: [{ capability: "R1", quote: "Single sign-on with SAML is included in every plan.", page: "P1", their_name: "Single sign-on" }] }, rows, pages);
    expect(r.incidents).toEqual([]);
    expect(r.found).toEqual([{ capabilityId: "k-sso", code: "R1", pageId: "page-1", pageHash: "h1", quote: "Single sign-on with SAML is included in every plan.", wording: "Single sign-on" }]);
  });
  it("…or nothing: an empty list is an answer; a row answered twice keeps its first answer", () => {
    expect(parseLook({ found: [] }, rows, pages)).toEqual({ found: [], incidents: [] });
    const twice = parseLook({ found: [
      { capability: "R2", quote: "Every admin action is written to the audit trail", page: "P2", their_name: "Audit trail" },
      { capability: "R2", quote: "can be exported", page: "P2", their_name: "Export" },
    ] }, rows, pages);
    expect(twice.found.map((f) => [f.code, f.wording])).toEqual([["R2", "Audit trail"]]);
  });
  it("a closed set of row codes: a code that was not asked is an incident, and nothing of it reaches the table", () => {
    const r = parseLook({ found: [{ capability: "R7", quote: "Single sign-on with SAML is included in every plan.", page: "P1", their_name: "x" }] }, rows, pages);
    expect(r.found).toEqual([]);
    expect(r.incidents).toEqual([expect.objectContaining({ kind: "unknown_item", itemKind: "row", item: "R7" })]);
  });
  it("a quote that is not on the page it names is an incident — it says when another page of the request has it; a page that is not in the request too", () => {
    const wrongPage = parseLook({ found: [{ capability: "R1", quote: "Single sign-on with SAML is included in every plan.", page: "P2", their_name: "SSO" }] }, rows, pages);
    expect(wrongPage.found).toEqual([]);
    expect(wrongPage.incidents).toEqual([expect.objectContaining({ kind: "quote_not_on_page", item: "Single Sign-On", pageUrl: "https://acme.example/admin", foundOn: "https://acme.example/security" })]);
    const nowhere = parseLook({ found: [{ capability: "R2", quote: "A full audit log with a ten-year retention.", page: "P2", their_name: "" }] }, rows, pages);
    expect(nowhere.incidents[0]).toMatchObject({ kind: "quote_not_on_page", foundOn: null });
    expect(parseLook({ found: [{ capability: "R2", quote: "x", page: "P44", their_name: "" }] }, rows, pages).incidents[0]).toMatchObject({ kind: "unknown_page", pageCode: "P44" });
  });
  it("the prompt: only what the pages show, a related or broader offering is not it, and the guide of where a PM looks", () => {
    for (const line of ["Leave out every capability the pages do not show", "A related or broader offering is not the capability", "Use only the capability codes given, each at most once"]) expect(LOOK_SYSTEM_PROMPT).toContain(line);
    expect(LOOK_SYSTEM_PROMPT).toContain(WHERE_A_PM_LOOKS);
    expect(JSON.stringify(lookTool(["R1", "R2"]))).toContain('"enum":["R1","R2"]');
    expect(JSON.stringify(lookTool(["R1"]))).not.toContain("reasoning");
  });
  it("never throws on a malformed answer", () => {
    for (const bad of [null, "x", {}, { found: "no" }, { found: [null, 3] }]) expect(() => parseLook(bad, rows, pages)).not.toThrow();
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
    ["map", mapTool(["S1", "S2"])],
    ["map, page by page", mapPagesTool(["P1", "P2"])],
    ["reading", READ_TOOL],
    ["reading, changes", readChangesTool(["K1"], ["K1", "K1.1"])],
    ["reading, changes of an empty list", readChangesTool([], [])],
    ["unify, capabilities", unifyCapabilitiesTool(["A1", "B1"], ["R1"])],
    ["unify, review", unifyReviewTool(["R1", "R2"])],
    ["unify, features", unifyFeaturesTool(["A1.1"], ["R1"], ["R2"], true)],
    ["unify, moved features", unifyFeaturesTool(["A1.1"], ["R1"], [], false)],
    ["domains", domainsTool(["R1", "R2"])],
    ["match", matchTool(["T1", "T2"], catalog)],
    ["second look", lookTool(["R1", "R2"])],
  ];
  it("no enum holds an empty string and no enum is empty: Gemini refuses the whole request (HTTP 400 — the first real run failed on it)", () => {
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
    expect(match.input_schema.properties.matches.items.properties.ours.enum?.[0]).toBe("none");
  });
});
