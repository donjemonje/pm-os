import { describe, expect, it } from "vitest";
import { knowledgeFileProblem, knowledgeIntegrations, knowledgeRows, KNOWLEDGE_FORM } from "@/lib/competitors/news/knowledge";
import { dueStatus, newsPageKind, type DuePage } from "@/lib/competitors/news/after-scan";

const item = (over: Record<string, unknown> = {}) => ({
  code: "F1", kind: "feature", name: "Leaked credential alerts", company_name: " Identity  Guard ", problem: "Without it, a stolen password is found too late.", problem_source: "stated",
  how_it_works: "Watches stolen-credential sources and alerts the team.", users: [{ name: "SOC analyst", kind: "person" }], workflows: [{ workflow: "respond to a leak", step: "get the alert" }],
  evidence: [{ quote: "alerts the team", url: "https://example.test/a", page_kind: "product page", strength: "explains" }], ...over,
});
const file = (over: Record<string, unknown> = {}) => ({ company: "Acme", label: "acme-f1", form: KNOWLEDGE_FORM, items: [item()], integrations: [{ tool: "Jira", page: "P1" }, { tool: "jira", page: "P2" }, { tool: "Slack", page: "P2" }], ...over });

describe("knowledge base: a list file becomes rows", () => {
  it("takes only the current form, with a company and items", () => {
    expect(knowledgeFileProblem(file())).toBeNull();
    expect(knowledgeFileProblem(file({ form: undefined }))).toContain("older list form");
    expect(knowledgeFileProblem(file({ company: "" }))).toContain("no company");
    expect(knowledgeFileProblem(file({ items: [] }))).toContain("no items");
  });
  it("keeps every field of a feature, tidied, in the file's order", () => {
    const rows = knowledgeRows(file({ items: [item(), item({ name: "Second" })] }));
    expect(rows.map((r) => r.name)).toEqual(["Leaked credential alerts", "Second"]);
    expect(rows[0]).toMatchObject({ companyName: "Identity Guard", problemSource: "stated", howItWorks: "Watches stolen-credential sources and alerts the team." });
    expect(rows[0].users).toEqual([{ name: "SOC analyst", kind: "person" }]);
    expect(rows[0].workflows).toEqual([{ workflow: "respond to a leak", step: "get the alert" }]);
    expect((rows[0].evidence as unknown[]).length).toBe(1);
  });
  it("leaves out an item with no name and survives missing lists", () => {
    const rows = knowledgeRows(file({ items: [item({ name: " " }), item({ users: null, workflows: undefined, evidence: "x" })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ users: [], workflows: [], evidence: [] });
  });
  it("lists each integration once, by tool name", () => {
    expect(knowledgeIntegrations(file())).toEqual(["Jira", "Slack"]);
    expect(knowledgeIntegrations(file({ integrations: undefined }))).toEqual([]);
  });
});

describe("news after a scan: which pages are due", () => {
  const ready = new Date("2026-11-22T10:00:00Z");
  const before = new Date("2026-11-20T10:00:00Z");
  const after = new Date("2026-11-23T10:00:00Z");
  const page = (over: Partial<DuePage> = {}): DuePage => ({ id: "p", url: "https://example.test/product/alerts", hash: "h2", newsHash: null, firstSeenAt: before, changedAt: null, ...over });
  it("a page from before the knowledge base that did not change is never news", () => {
    expect(dueStatus(page(), ready)).toBeNull();
    expect(dueStatus(page({ changedAt: before }), ready)).toBeNull();
  });
  it("a page that appeared after the knowledge base is new, and is sent whole", () => {
    expect(dueStatus(page({ firstSeenAt: after }), ready)).toBe("new");
  });
  it("a page that changed after the knowledge base is changed", () => {
    expect(dueStatus(page({ changedAt: after }), ready)).toBe("changed");
  });
  it("a page the intake already read in its current text is not due; once it changes again it is", () => {
    expect(dueStatus(page({ firstSeenAt: after, newsHash: "h2" }), ready)).toBeNull();
    expect(dueStatus(page({ firstSeenAt: after, newsHash: "h1" }), ready)).toBe("changed");
  });
  it("careers, legal and localized pages are never due", () => {
    expect(dueStatus(page({ url: "https://example.test/careers/engineer", firstSeenAt: after }), ready)).toBeNull();
    expect(dueStatus(page({ url: "https://example.test/de/product", firstSeenAt: after }), ready)).toBeNull();
  });
});

describe("news after a scan: the kind of page", () => {
  it("follows the address it was found under, then the map's word, then the path", () => {
    expect(newsPageKind("helpcenter", "https://help.example.test/a", null)).toBe("help");
    expect(newsPageKind("helpcenter", "https://help.example.test/a", "release_notes")).toBe("release_notes");
    expect(newsPageKind("changelog", "https://example.test/x", null)).toBe("release_notes");
    expect(newsPageKind("apidocs", "https://dev.example.test/x", null)).toBe("api_docs");
    expect(newsPageKind("website", "https://example.test/blog/post", null)).toBe("blog");
    expect(newsPageKind("website", "https://example.test/press/funding", null)).toBe("news");
    expect(newsPageKind("website", "https://example.test/pricing", null)).toBe("pricing");
    expect(newsPageKind("website", "https://example.test/whats-new/november", null)).toBe("release_notes");
    expect(newsPageKind("website", "https://example.test/platform/alerts", null)).toBe("product");
  });
});
