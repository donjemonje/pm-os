/**
 * Story 3 (competitors) — the scan notification's pure parts: how a cell's
 * move reads for the org, domain entrances, the run summary, and the email
 * (one competitor / several / nothing to send).
 */
import { describe, expect, it } from "vitest";
import { bottomLine, classifyChange, isDomainEntrance, renderRunEmail, summarize, type CompetitorChanges, type RunNotification } from "@/lib/competitors/notify";

const base = (over: Partial<CompetitorChanges> = {}): CompetitorChanges => ({
  competitorId: "c1",
  name: "Acme Intel",
  pagesRead: 50,
  pagesChanged: 13,
  changes: [],
  domainEntrances: [],
  facts: [],
  suggestions: [],
  ...over,
});

const run = (competitors: CompetitorChanges[], unchanged: string[] = []): RunNotification => ({
  orgName: "Org",
  startedBy: "Dana",
  trigger: "manual",
  startedAt: new Date("2026-10-29T08:42:00Z"),
  sitesScanned: competitors.length + unchanged.length,
  competitors,
  unchanged,
  appUrl: "http://localhost:3000",
});

describe("classifyChange", () => {
  it("is a gap when they now offer what the org lacks", () => {
    expect(classifyChange("missing", "has", "missing")).toBe("gap");
    expect(classifyChange("unknown", "partial", "missing")).toBe("gap");
  });
  it("is raised when the org has it too, lowered when they drop", () => {
    expect(classifyChange("partial", "has", "partial")).toBe("raised");
    expect(classifyChange("missing", "has", "has")).toBe("raised");
    expect(classifyChange("has", "partial", "missing")).toBe("lowered");
  });
  it("is nothing when the rank did not move", () => {
    expect(classifyChange("has", "has", "missing")).toBeNull();
  });
});

describe("isDomainEntrance", () => {
  it("fires when a domain goes from nothing to something", () => {
    expect(isDomainEntrance(["missing", "unknown"], ["has", "unknown"])).toBe(true);
  });
  it("does not fire when the domain already had an offer, or still has none", () => {
    expect(isDomainEntrance(["partial", "missing"], ["has", "missing"])).toBe(false);
    expect(isDomainEntrance(["missing"], ["missing"])).toBe(false);
    expect(isDomainEntrance([], [])).toBe(false);
  });
});

describe("renderRunEmail", () => {
  const gap = { capability: "Autonomous hunting", domain: "Operations", from: "missing" as const, to: "has" as const, own: "missing" as const, kind: "gap" as const, quote: "Hunt across your stack", sourceUrl: "https://acme.example/products/hunt", product: "Acme Hunt", summary: null, imageUrl: null };
  const fact = { kind: "product", value: "Acme MCP generally available", sourceUrl: "https://acme.example/blog/mcp", factDate: "2026-09-28T00:00:00.000Z", headline: null, summary: null, imageUrl: null };

  it("sends nothing when no competitor changed", () => {
    expect(renderRunEmail(run([], ["Acme Intel"]))).toBeNull();
  });
  it("one competitor: names it in the subject, lists only its changes, no glance table", () => {
    const mail = renderRunEmail(run([base({ changes: [gap], facts: [fact], suggestions: [{ name: "Shadow AI feeds", domain: "AI Security" }] })], ["Beta Corp"]))!;
    expect(mail.subject).toBe("Acme Intel changed — competitor scan");
    expect(mail.html).toContain("Gap opened");
    expect(mail.html).toContain("Autonomous hunting");
    expect(mail.html).toContain("Hunt across your stack");
    expect(mail.html).toContain("Acme MCP generally available");
    expect(mail.html).toContain("Shadow AI feeds");
    expect(mail.html).not.toContain("At a glance");
    expect(mail.html).not.toContain("Beta Corp");
    expect(mail.text).toContain("Autonomous hunting: Missing → Has it (Org missing)");
    expect(mail.text).toContain("Shadow AI feeds · AI Security");
  });
  it("several competitors: one email, a glance row each, unchanged ones not mentioned, suggestions tagged", () => {
    const mail = renderRunEmail(run([
      base({ changes: [gap] }),
      base({ competitorId: "c2", name: "Beta Corp", changes: [{ ...gap, kind: "raised", own: "partial", from: "partial" }] }),
      base({ competitorId: "c3", name: "Gamma", suggestions: [{ name: "Takedowns", domain: "Brand" }] }),
    ], ["Delta"]))!;
    expect(mail.subject).toBe("3 competitors changed — competitor scan");
    expect(mail.html).toContain("At a glance");
    expect(mail.html).not.toContain("Delta");
    expect(mail.html).toContain("Takedowns");
    expect(mail.html).toContain("· Gamma");
    expect(mail.html.match(/Open profile →/g)?.length).toBe(3);
    expect(mail.text).toContain("== Beta Corp");
  });
  it("escapes HTML in scanned text", () => {
    const mail = renderRunEmail(run([base({ changes: [{ ...gap, quote: "<script>alert(1)</script>" }] })]))!;
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});

describe("summarize", () => {
  it("counts by kind across competitors", () => {
    const gap = { capability: "A", domain: "D", from: "missing" as const, to: "has" as const, own: "missing" as const, kind: "gap" as const, quote: null, sourceUrl: null, product: null, summary: null, imageUrl: null };
    const s = summarize(run([
      base({ changes: [gap, { ...gap, kind: "raised" }], domainEntrances: [{ domain: "D", capabilities: ["A"] }], facts: [{ kind: "customer", value: "X", sourceUrl: null, factDate: null, headline: null, summary: null, imageUrl: null }] }),
      base({ competitorId: "c2", name: "B", changes: [{ ...gap, kind: "lowered" }], suggestions: [{ name: "S", domain: "D" }] }),
    ]), 2);
    expect(s).toEqual({ competitors: 2, gaps: 1, raised: 1, lowered: 1, domains: 1, facts: 1, suggestions: 1, recipients: 2 });
  });
});

describe("bottomLine", () => {
  it("keeps the first sentence and cuts long ones at a word", () => {
    expect(bottomLine("Payment Fraud monitors card shops. Teams search by BIN.")).toBe("Payment Fraud monitors card shops.");
    expect(bottomLine("x".repeat(10) + " word ".repeat(40), 60)!.endsWith("…")).toBe(true);
    expect(bottomLine("  ")).toBeNull();
  });
});
