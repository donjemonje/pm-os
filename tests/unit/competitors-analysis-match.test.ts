/** Capability Analysis — match and place (analysis/match.ts): our rows as codes, batches, and when a saved match is reused. Pure module. */
import { describe, expect, it } from "vitest";
import { batchItems, buildCatalog, codeFor, isSettled, matchTodo, needsRepair, rematchSelection, type MatchItem } from "@/lib/competitors/analysis/match";

describe("codes", () => {
  it("a code is the first 8 hex characters of the row id", () => {
    expect(codeFor("K", "1a2b3c4d-5e6f-4000-8000-000000000000", new Set())).toBe("K-1a2b3c4d");
    expect(codeFor("D", "1a2b3c4d-5e6f-4000-8000-000000000000", new Set())).toBe("D-1a2b3c4d");
  });
  it("lengthens on a collision, so every code is unique", () => {
    const taken = new Set(["K-1a2b3c4d"]);
    expect(codeFor("K", "1a2b3c4d-9999-4000-8000-000000000000", taken)).toBe("K-1a2b3c4d9");
  });
  it("are stable: the same rows give the same codes whatever their order", () => {
    const domains = [{ id: "d0000000-0000-4000-8000-000000000001", name: "Identity", description: "Who gets in.", state: "active", position: 0 }];
    const caps = [
      { id: "c0000000-aaaa-4000-8000-000000000001", domainId: domains[0].id, name: "SSO", description: "", aliases: [], state: "active", position: 0 },
      { id: "c0000000-bbbb-4000-8000-000000000002", domainId: domains[0].id, name: "MFA", description: "", aliases: [], state: "active", position: 1 },
    ];
    const a = buildCatalog(domains, caps, []);
    const b = buildCatalog(domains, [...caps].reverse(), []);
    expect([...a.codeOf.entries()].sort()).toEqual([...b.codeOf.entries()].sort());
    expect(a.codeOf.get(caps[0].id)).toBe("K-c0000000");
    expect(a.codeOf.get(caps[1].id)).toBe("K-c0000000b");
    expect(new Set(a.ours.keys()).size).toBe(2);
  });
});

describe("buildCatalog", () => {
  const D = (id: string, name: string, state: string, position: number) => ({ id, name, description: `${name} definition.`, state, position });
  const K = (id: string, domainId: string, name: string, state = "active", aliases: string[] = []) => ({ id, domainId, name, description: `${name} does things.`, aliases, state, position: 0 });
  const domains = [D("d1000000", "Identity", "active", 1), D("d2000000", "AI Security", "suggested", 2), D("d3000000", "Legacy", "removed", 3), D("d4000000", "Declined", "dismissed", 4)];
  const caps = [K("c1000000", "d1000000", "SSO", "active", ["Single sign-on"]), K("c2000000", "d1000000", "Password vault", "removed"), K("c3000000", "d1000000", "Kiosk mode", "dismissed"), K("c4000000", "d2000000", "Prompt firewall"), K("c5000000", "d3000000", "Fax gateway")];
  const features = [{ id: "f1000000", capabilityId: "c1000000", name: "SAML", description: "", aliases: [], state: "active", position: 0 }, { id: "f2000000", capabilityId: "c1000000", name: "WS-Fed", description: "", aliases: [], state: "removed", position: 1 }, { id: "f3000000", capabilityId: "c5000000", name: "Cover page", description: "", aliases: [], state: "active", position: 0 }];
  const c = buildCatalog(domains, caps, features);
  it("lists active and suggested domains; removed and declined ones are only named as removed", () => {
    expect([...c.domains.values()].map((d) => d.id).sort()).toEqual(["d1000000", "d2000000"]);
    expect(c.shared).toContain("DOMAIN D-d1000000: Identity\nIdentity definition.");
    expect(c.shared).toContain("DOMAIN D-d2000000: AI Security");
    expect(c.shared).toContain("REMOVED DOMAINS: Legacy, Declined");
    expect(c.shared).not.toContain("Fax gateway");
  });
  it("lists removed and declined rows of ours like any other, so they are recognised and not added back", () => {
    expect(c.shared).toContain("  K-c1000000 SSO — SSO does things. (also known as: Single sign-on)");
    expect(c.shared).toContain("  K-c2000000 Password vault");
    expect(c.shared).toContain("  K-c3000000 Kiosk mode");
    expect(c.shared).toContain("    F-f1000000 SAML");
    expect(c.shared).toContain("    F-f2000000 WS-Fed");
    // The model is not told which rows are removed.
    expect(c.shared.split("\n").find((l) => l.includes("Password vault"))).not.toMatch(/removed|dismissed/i);
    expect(c.ours.get("K-c2000000")).toEqual({ kind: "capability", id: "c2000000" });
    expect(c.ours.get("F-f2000000")).toEqual({ kind: "feature", id: "f2000000" });
    expect(c.ours.has("F-f3000000")).toBe(false);
  });
  it("says none when no domain was removed", () => {
    expect(buildCatalog([domains[0]], [], []).shared).toContain("REMOVED DOMAINS: none");
  });
});

describe("batchItems", () => {
  const cap = (id: string) => ({ id, kind: "capability" as const, key: `c:${id}`, parentItemId: null });
  const feat = (id: string, parent: string) => ({ id, kind: "feature" as const, key: `f:c:${parent}>${id}`, parentItemId: parent });
  it("orders capabilities by key, each followed by its features", () => {
    const batches = batchItems([feat("y", "b"), cap("b"), feat("x", "b"), cap("a"), feat("z", "a")], 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((i) => i.id)).toEqual(["a", "z", "b", "x", "y"]);
  });
  it("keeps a capability with its features and respects the size", () => {
    const items = [cap("a"), feat("a1", "a"), feat("a2", "a"), cap("b"), feat("b1", "b"), feat("b2", "b"), cap("c")];
    const batches = batchItems(items, 4);
    expect(batches.map((b) => b.map((i) => i.id))).toEqual([["a", "a1", "a2"], ["b", "b1", "b2", "c"]]);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(4);
  });
  it("splits a capability that alone is larger than a batch; a feature whose capability is not on the list still goes", () => {
    const big = [cap("a"), ...Array.from({ length: 5 }, (_, i) => feat(`a${i}`, "a")), feat("orphan", "gone")];
    const batches = batchItems(big, 3);
    expect(batches.flat().map((i) => i.id).sort()).toEqual(big.map((i) => i.id).sort());
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(3);
  });
  it("never more than 100 by default", () => {
    const batches = batchItems(Array.from({ length: 250 }, (_, i) => cap(String(i).padStart(3, "0"))));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });
});

describe("a saved match is reused", () => {
  const item = (id: string, extra: Partial<MatchItem> = {}): MatchItem => ({ id, kind: "capability", key: `c:${id}`, parentItemId: null, capabilityId: null, featureId: null, placement: null, matchedBy: null, matchedAt: null, ...extra });
  const at = new Date("2026-11-11T10:00:00Z");
  const items = [
    item("new"),
    item("ai", { capabilityId: "k1", matchedBy: "ai", matchedAt: at }),
    item("name", { capabilityId: "k2", matchedBy: "name", matchedAt: at }),
    item("placed", { placement: { marketName: "X" }, matchedBy: "ai", matchedAt: at }),
    item("created", { capabilityId: "k3", matchedBy: "created", matchedAt: at }),
    item("silent", { featureId: "f1", matchedBy: "silent", matchedAt: at }),
    item("orphaned", { matchedBy: "ai", matchedAt: at }),
  ];
  it("an item with a saved match — to a row of ours, or a placement — is not on the to-do", () => {
    expect(matchTodo(items).map((i) => i.id)).toEqual(["new", "orphaned"]);
    expect(isSettled(items[3])).toBe(true);
  });
  it("an item whose row of ours was deleted is back on it", () => {
    expect(needsRepair(items[6])).toBe(true);
    expect(needsRepair(items[1])).toBe(false);
    expect(needsRepair(items[0])).toBe(false);
  });
  it("a rematch touches only what PMOS AI matched", () => {
    expect(rematchSelection(items).map((i) => i.id)).toEqual(["ai", "placed", "orphaned"]);
  });
});
