/** Capability Analysis — the reading of a company in chunks (analysis/reading.ts): the prompts' rules, the parsers, the quote incidents, applying a changes-answer. Pure module. */
import { describe, expect, it } from "vitest";
import {
  applyChanges,
  codeList,
  dropUnproven,
  listFrom,
  listSize,
  NAMES_RULE,
  OBJECT_RULE,
  parseChanges,
  parseList,
  READ_CHANGES_RULES,
  READ_SYSTEM_PROMPT,
  READ_TOOL,
  READ_VERSION,
  readChangesTool,
  renderListSoFar,
  renderReading,
  SIZE_RULE,
  stillUnexplained,
  UNEXPLAINED_RULE,
  WHERE_A_PM_LOOKS,
  type ListCapability,
  type RequestPage,
} from "@/lib/competitors/analysis/reading";
import { READ_ORDER } from "@/lib/competitors/analysis/sections";

const HELP = "How to use it\nAdd custom fields to ideas so every request carries the data your team needs.\nSpark transcribes your words into the input as you speak.";
const NOTES = "Release notes\nNew: roadmaps can now be shared as a read-only link with people outside your workspace.\nPortal SSO is available on the Enterprise plan.";
const PRICING = "Plans\nStarter\nCustom fields\nSSO\nAudit log";
const PAGES: RequestPage[] = [
  { code: "P1", id: "notes", url: "https://acme.example/release-notes/2026", hash: "h-notes", text: NOTES },
  { code: "P2", id: "help", url: "https://support.acme.example/ideas/custom-fields", hash: "h-help", text: HELP },
  { code: "P3", id: "pricing", url: "https://acme.example/pricing", hash: "h-pricing", text: PRICING },
];
const item = (name: string, quote: string, page: string, description = `${name} does something.`) => ({ name, description, quote, page });

describe("the prompt's rules (shown in Administration → Competitors → AI prompts)", () => {
  it("capability size: the three sizes with the car example, and the rule to split an area", () => {
    expect(SIZE_RULE).toContain('A domain is an area: "Car entertainment". Do not list domains.');
    expect(SIZE_RULE).toContain('A capability is ONE thing the product can do: "Bluetooth connection".');
    expect(SIZE_RULE).toContain('A feature is a detail of that one capability: "iPhone support".');
    expect(SIZE_RULE).toContain("An item with many unrelated things under it is an area, not a capability: split it into the capabilities it holds.");
    expect(SIZE_RULE).toContain("tens of capabilities, each with a few features");
  });
  it("no invented umbrella: a name is the company's own term, never one coined to hold what is left over", () => {
    expect(NAMES_RULE).toContain("A capability's name is the company's own term for that one thing");
    expect(NAMES_RULE).toContain("Never coin a name to hold what is left over");
    expect(NAMES_RULE).toContain("the capability it belongs to is missing from your list");
  });
  it("every feature says what it is about", () => {
    expect(OBJECT_RULE).toContain("custom fields ON WHAT, reports ABOUT WHAT, templates FOR WHAT");
  });
  it("a bare label is reported as seen but not explained, not dressed up", () => {
    expect(UNEXPLAINED_RULE).toContain("is not a feature");
    expect(UNEXPLAINED_RULE).toContain('Put it under "unexplained"');
    expect(JSON.stringify(READ_TOOL)).toContain('"unexplained"');
  });
  it("where a PM looks: release notes first, then the help center, API docs, the pricing table, product pages, marketing pages — the order the chunks are read in", () => {
    const at = (s: string) => WHERE_A_PM_LOOKS.indexOf(s);
    const order = ["1. Release notes", "2. Help center", "3. API and developer documentation", "4. The pricing page's plan table", "5. Product and feature pages", "6. Marketing pages"];
    for (const o of order) expect(at(o), o).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
    // The guide names the kinds in the same order the reading plan reads them in.
    const kinds = READ_ORDER.map((k) => at(`kind ${k}`));
    expect(kinds.every((i) => i > -1)).toBe(true);
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    expect(WHERE_A_PM_LOOKS).toContain("take the quote from the strongest page that says it clearly");
  });
  it("the system prompt carries all of them, and a finding carries name, description, quote and page — no reasoning", () => {
    for (const rule of [SIZE_RULE, WHERE_A_PM_LOOKS, NAMES_RULE, OBJECT_RULE, UNEXPLAINED_RULE]) expect(READ_SYSTEM_PROMPT).toContain(rule);
    const schema = JSON.stringify(READ_TOOL);
    for (const field of ['"name"', '"description"', '"quote"', '"page"']) expect(schema).toContain(field);
    expect(schema).not.toContain("reasoning");
    expect(READ_VERSION).toBe("read-1");
  });
  it("a later request answers only with what changes: add, correct, remove", () => {
    for (const word of ["new_capabilities", "new_features", "corrections", "removed", "Do NOT repeat the list", "PROOF LOST"]) expect(READ_CHANGES_RULES).toContain(word);
    const tool = JSON.stringify(readChangesTool(["K1"], ["K1", "K1.1"]));
    for (const field of ["new_capabilities", "new_features", "corrections", "removed", "unexplained"]) expect(tool).toContain(`"${field}"`);
    // The codes of the list ride in the schema as a closed set while the list is small.
    expect(tool).toContain('"enum":["K1","K1.1"]');
    expect(JSON.stringify(readChangesTool(Array.from({ length: 200 }, (_, i) => `K${i}`), []))).not.toContain('"enum":["K0"');
  });
});

describe("the first request: the company's list", () => {
  const answer = {
    capabilities: [
      { ...item("Custom fields on ideas", "Add custom fields to ideas so every request carries the data your team needs.", "P2"), features: [] },
      { ...item("Roadmap sharing", "roadmaps can now be shared as a read-only link", "P1"), features: [item("Read-only links", "shared as a read-only link with people outside your workspace", "P1")] },
    ],
    unexplained: [{ label: "Audit log", page: "P3" }],
  };
  it("each capability and each feature once, with its description and the proof: the page, the text it had and the quote", () => {
    const parsed = parseList(answer, PAGES);
    expect(parsed.incidents).toEqual([]);
    expect(parsed.capabilities.map((k) => [k.name, k.proof?.pageId, k.features.map((f) => f.name)])).toEqual([["Custom fields on ideas", "help", []], ["Roadmap sharing", "notes", ["Read-only links"]]]);
    expect(parsed.capabilities[1].features[0].proof).toEqual({ pageId: "notes", pageHash: "h-notes", quote: "shared as a read-only link with people outside your workspace" });
    expect(parsed.capabilities[0].description).toBe("Custom fields on ideas does something.");
    expect(parsed.unexplained).toEqual([{ label: "Audit log", url: "https://acme.example/pricing" }]);
    expect(listSize(listFrom(parsed.capabilities))).toEqual({ capabilities: 2, features: 1 });
  });
  it("the quote is checked against the page it NAMES: on another page of the request it is an incident that says which page has it", () => {
    const parsed = parseList({ capabilities: [{ ...item("Portal SSO", "Portal SSO is available on the Enterprise plan.", "P2"), features: [] }], unexplained: [] }, PAGES);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.incidents).toEqual([{ kind: "quote_not_on_page", itemKind: "capability", item: "Portal SSO", parent: null, quote: "Portal SSO is available on the Enterprise plan.", pageCode: "P2", pageUrl: "https://support.acme.example/ideas/custom-fields", pageId: "help", pageHash: "h-help", foundOn: "https://acme.example/release-notes/2026" }]);
  });
  it("a quote that is on no page of the request is an incident with no other page", () => {
    const parsed = parseList({ capabilities: [{ ...item("AI roadmap writer", "Writes your whole roadmap with AI in one click, every morning.", "P1"), features: [] }], unexplained: [] }, PAGES);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.incidents[0]).toMatchObject({ kind: "quote_not_on_page", item: "AI roadmap writer", foundOn: null, pageId: "notes" });
  });
  it("a page code that is not a page of the request is an incident too", () => {
    const parsed = parseList({ capabilities: [{ ...item("Portal SSO", "Portal SSO is available on the Enterprise plan.", "P99"), features: [] }], unexplained: [] }, PAGES);
    expect(parsed.incidents[0]).toMatchObject({ kind: "unknown_page", pageCode: "P99", pageUrl: null });
    expect(parsed.capabilities).toEqual([]);
  });
  it("a feature whose quote fails does not reach the list; the capability and its other features stay", () => {
    const parsed = parseList({ capabilities: [{ ...item("Roadmap sharing", "roadmaps can now be shared as a read-only link", "P1"), features: [item("Password links", "links can be protected by a password", "P1"), item("Read-only links", "shared as a read-only link", "P1")] }], unexplained: [] }, PAGES);
    expect(parsed.capabilities[0].features.map((f) => f.name)).toEqual(["Read-only links"]);
    expect(parsed.incidents.map((i) => [i.itemKind, i.item, i.parent])).toEqual([["feature", "Password links", "Roadmap sharing"]]);
  });
  it("a capability whose own quote fails stays only to hold the features that passed — with no proof of its own; with none it goes", () => {
    const holder = parseList({ capabilities: [{ ...item("Sharing", "not on any page at all, really not", "P1"), features: [item("Read-only links", "shared as a read-only link", "P1")] }], unexplained: [] }, PAGES);
    expect(holder.capabilities).toEqual([{ name: "Sharing", description: "Sharing does something.", proof: null, features: [expect.objectContaining({ name: "Read-only links" })] }]);
    expect(holder.incidents).toHaveLength(1);
    const gone = parseList({ capabilities: [{ ...item("Sharing", "not on any page at all, really not", "P1"), features: [] }], unexplained: [] }, PAGES);
    expect(gone.capabilities).toEqual([]);
  });
  it("the same capability listed twice is one; its features join the first; the same feature twice under it is one", () => {
    const parsed = parseList({ capabilities: [
      { ...item("Roadmap sharing", "roadmaps can now be shared as a read-only link", "P1"), features: [item("Read-only links", "shared as a read-only link", "P1")] },
      { ...item("ROADMAP  Sharing", "roadmaps can now be shared", "P1"), features: [item("Read-only links", "shared as a read-only link", "P1"), item("Outside sharing", "with people outside your workspace", "P1")] },
    ], unexplained: [] }, PAGES);
    expect(parsed.capabilities.map((k) => [k.name, k.features.map((f) => f.name)])).toEqual([["Roadmap sharing", ["Read-only links", "Outside sharing"]]]);
    expect(parsed.dropped.repeated).toBe(2);
  });
  it("nothing about people: an item that names a person is left out; a description that does is emptied", () => {
    const pages: RequestPage[] = [{ code: "P1", id: "x", url: "https://acme.example/x", hash: "h", text: "Contact jane.doe@acme.example to enable roadmap sharing for your account today." }];
    const parsed = parseList({ capabilities: [
      { name: "Roadmap sharing", description: "Ask jane.doe@acme.example for it.", quote: "to enable roadmap sharing for your account today", page: "P1", features: [] },
      { name: "Sharing by jane.doe@acme.example", description: "x", quote: "to enable roadmap sharing for your account today", page: "P1", features: [] },
    ], unexplained: [] }, pages);
    expect(parsed.capabilities.map((k) => [k.name, k.description])).toEqual([["Roadmap sharing", ""]]);
    expect(parsed.dropped.pii).toBe(1);
  });
  it("never throws on a malformed answer", () => {
    for (const bad of [null, "x", 7, {}, { capabilities: "no" }, { capabilities: [null, 5, { name: 3 }, { name: "", quote: "x", page: "P1" }] }]) {
      expect(parseList(bad, PAGES).capabilities).toEqual([]);
    }
  });
});

describe("a later request: what its pages change in the list so far", () => {
  const proof = (pageId: string, quote: string) => ({ pageId, pageHash: `h-${pageId}`, quote });
  const list = (): ListCapability[] => [
    { id: "k1", name: "Roadmap sharing", description: "Shares roadmaps.", proof: proof("notes", "roadmaps can now be shared as a read-only link"), features: [{ id: "f1", name: "Read-only links", description: "Links that cannot edit.", proof: proof("notes", "shared as a read-only link") }] },
    { id: "k2", name: "Custom fields on ideas", description: "Adds fields to ideas.", proof: null, features: [] },
  ];
  it("the list so far is shown with codes — K1 a capability, K1.1 a feature — and an item with no proof is marked", () => {
    const coded = codeList(list());
    expect(coded.map((c) => c.code)).toEqual(["K1", "K1.1", "K2"]);
    expect(renderListSoFar(coded)).toBe("K1 | Roadmap sharing — Shares roadmaps.\n  K1.1 | Read-only links — Links that cannot edit.\nK2 | Custom fields on ideas — Adds fields to ideas. | PROOF LOST");
    expect(renderReading("Acme", renderListSoFar(coded), "=== PAGE P1 …")).toBe(`COMPANY: Acme\n\nLIST SO FAR:\n${renderListSoFar(coded)}\n\n=== PAGE P1 …`);
    expect(renderReading("Acme", null, "=== PAGE P1 …")).toBe("COMPANY: Acme\n\n=== PAGE P1 …");
  });
  it("ADD: a new capability with its features, and a new feature under a capability of the list (by its code)", () => {
    const current = list();
    const parsed = parseChanges({
      new_capabilities: [{ ...item("Voice input", "Spark transcribes your words into the input as you speak.", "P2"), features: [] }],
      new_features: [{ capability: "K1", ...item("Sharing outside the workspace", "with people outside your workspace", "P1") }],
      corrections: [], removed: [], unexplained: [],
    }, codeList(current), PAGES);
    expect(parsed.incidents).toEqual([]);
    const { list: next, counts } = applyChanges(current, parsed.ops);
    expect(counts).toEqual({ newCapabilities: 1, newFeatures: 1, corrections: 0, removed: 0 });
    expect(next.map((k) => [k.id, k.name, k.features.map((f) => f.name)])).toEqual([["k1", "Roadmap sharing", ["Read-only links", "Sharing outside the workspace"]], ["k2", "Custom fields on ideas", []], [null, "Voice input", []]]);
    // The list given is not touched.
    expect(current[0].features).toHaveLength(1);
  });
  it("CORRECT: only the fields the answer gives change; the item keeps its id (and with it its saved match)", () => {
    const current = list();
    const parsed = parseChanges({ new_capabilities: [], new_features: [], removed: [], unexplained: [], corrections: [
      { item: "K1.1", new_name: "Read-only share links", description: "", quote: "", page: "" },
      { item: "K2", new_name: "", description: "Adds the team's own fields to every idea.", quote: "Add custom fields to ideas so every request carries the data your team needs.", page: "P2" },
    ] }, codeList(current), PAGES);
    const { list: next, counts } = applyChanges(current, parsed.ops);
    expect(counts.corrections).toBe(2);
    expect(next[0].features[0]).toEqual({ id: "f1", name: "Read-only share links", description: "Links that cannot edit.", proof: proof("notes", "shared as a read-only link") });
    expect(next[1]).toMatchObject({ id: "k2", name: "Custom fields on ideas", description: "Adds the team's own fields to every idea.", proof: { pageId: "help", pageHash: "h-help" } });
  });
  it("CORRECT with a quote that is not on its page: an incident, and the old proof stays", () => {
    const current = list();
    const parsed = parseChanges({ new_capabilities: [], new_features: [], removed: [], unexplained: [], corrections: [{ item: "K1", new_name: "", description: "", quote: "roadmaps are shared with a magic wand", page: "P1" }] }, codeList(current), PAGES);
    expect(parsed.incidents).toHaveLength(1);
    expect(parsed.incidents[0]).toMatchObject({ kind: "quote_not_on_page", itemKind: "capability", item: "Roadmap sharing" });
    expect(applyChanges(current, parsed.ops).list[0].proof).toEqual(current[0].proof);
  });
  it("REMOVE: an item the pages show the company does not offer leaves the list — a capability with its features", () => {
    const current = list();
    const feature = parseChanges({ new_capabilities: [], new_features: [], corrections: [], unexplained: [], removed: [{ item: "K1.1", why: "The release notes say read-only links were retired." }] }, codeList(current), PAGES);
    expect(applyChanges(current, feature.ops)).toMatchObject({ counts: { removed: 1 }, list: [{ id: "k1", features: [] }, { id: "k2" }] });
    const capability = parseChanges({ new_capabilities: [], new_features: [], corrections: [{ item: "K1.1", new_name: "X", description: "", quote: "", page: "" }], unexplained: [], removed: [{ item: "K1", why: "Gone." }, { item: "K1", why: "Again." }] }, codeList(current), PAGES);
    const after = applyChanges(current, capability.ops);
    expect(after.list.map((k) => k.id)).toEqual(["k2"]);
    expect(after.counts).toEqual({ newCapabilities: 0, newFeatures: 0, corrections: 0, removed: 1 });
  });
  it("UNKNOWN NAMES: a code that is not in the list is an incident — the feature, the correction or the removal is left out", () => {
    const current = list();
    const parsed = parseChanges({
      new_capabilities: [],
      new_features: [{ capability: "K9", ...item("Ghost feature", "shared as a read-only link", "P1") }, { capability: "K1.1", ...item("Under a feature", "shared as a read-only link", "P1") }],
      corrections: [{ item: "Roadmap sharing", new_name: "X", description: "", quote: "", page: "" }],
      removed: [{ item: "K7", why: "?" }],
      unexplained: [],
    }, codeList(current), PAGES);
    expect(parsed.ops).toEqual([]);
    expect(parsed.incidents.map((i) => [i.kind, i.item])).toEqual([["unknown_item", "K9"], ["unknown_item", "K1.1"], ["unknown_item", "K7"], ["unknown_item", "Roadmap sharing"]]);
    expect(applyChanges(current, parsed.ops).list).toEqual(current);
  });
  it("a 'new' capability the list already has IS that capability: its features join it, and its quote is the proof when that one had none", () => {
    const current = list();
    const parsed = parseChanges({ new_capabilities: [{ ...item("custom fields on IDEAS", "Add custom fields to ideas so every request carries the data your team needs.", "P2"), features: [item("Fields on requests", "every request carries the data your team needs", "P2")] }], new_features: [{ capability: "K1", ...item("Read-only links", "shared as a read-only link", "P1") }], corrections: [], removed: [], unexplained: [] }, codeList(current), PAGES);
    const { list: next } = applyChanges(current, parsed.ops);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: "k2", name: "Custom fields on ideas", proof: { pageId: "help" }, features: [{ name: "Fields on requests" }] });
    // The feature the capability already has is not added twice.
    expect(next[0].features).toHaveLength(1);
    expect(parsed.dropped.repeated).toBe(1);
  });
  it("a rename to a name another item of the same level has is refused: two items would be one", () => {
    const current = list();
    const parsed = parseChanges({ new_capabilities: [], new_features: [], removed: [], unexplained: [], corrections: [{ item: "K2", new_name: "Roadmap Sharing", description: "", quote: "", page: "" }] }, codeList(current), PAGES);
    expect(parsed.ops).toEqual([]);
    expect(parsed.dropped.renameRefused).toBe(1);
  });
  it("an answer that changes nothing changes nothing; a malformed one never throws", () => {
    const current = list();
    expect(parseChanges({ new_capabilities: [], new_features: [], corrections: [], removed: [], unexplained: [] }, codeList(current), PAGES).ops).toEqual([]);
    for (const bad of [null, "x", {}, { removed: [null], corrections: "no", new_features: [7] }]) expect(() => parseChanges(bad, codeList(current), PAGES)).not.toThrow();
  });
});

describe("after the reading", () => {
  const proof = { pageId: "p", pageHash: "h", quote: "q" };
  it("what has no proof leaves the list: a feature goes; a capability stays only while it holds a feature", () => {
    const list: ListCapability[] = [
      { id: "k1", name: "A", description: "", proof, features: [{ id: "f1", name: "a1", description: "", proof: null }, { id: "f2", name: "a2", description: "", proof }] },
      { id: "k2", name: "B", description: "", proof: null, features: [{ id: "f3", name: "b1", description: "", proof }] },
      { id: "k3", name: "C", description: "", proof: null, features: [{ id: "f4", name: "c1", description: "", proof: null }] },
    ];
    const { list: next, dropped } = dropUnproven(list);
    expect(next.map((k) => [k.id, k.features.map((f) => f.id)])).toEqual([["k1", ["f2"]], ["k2", ["f3"]]]);
    expect(dropped).toBe(3);
    expect(dropUnproven(next).dropped).toBe(0);
  });
  it("seen but not explained: a label a later page explained (it is an item of the list now) is not; each label once", () => {
    const list: ListCapability[] = [{ id: "k", name: "Single sign-on", description: "", proof, features: [{ id: "f", name: "Audit log", description: "", proof }] }];
    expect(stillUnexplained([{ label: "Audit log", url: "u1" }, { label: "Custom fields", url: "u1" }, { label: "custom  FIELDS", url: "u2" }, { label: "Single Sign-On", url: null }], list)).toEqual([{ label: "Custom fields", url: "u1" }]);
  });
});
