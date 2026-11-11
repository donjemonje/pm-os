/** Capability Analysis — the competitor's merged list (analysis/items.ts). Pure module. */
import { describe, expect, it } from "vitest";
import { canonicalName, findItem, itemKey, ownKey, planChildMerges, planMerges, wordingKey, type ItemLite } from "@/lib/competitors/analysis/items";

const item = (id: string, extra: Partial<ItemLite> = {}): ItemLite => ({ id, kind: "capability", key: `c:${id}`, name: id, wordings: [id], parentItemId: null, mergeChecked: false, findings: 1, settled: false, ...extra });

describe("wordingKey / itemKey", () => {
  it("is the same for wordings that differ in case, punctuation, marks and &", () => {
    expect(wordingKey("Threat-Intelligence Platform™")).toBe("threat intelligence platform");
    expect(wordingKey("  threat   intelligence PLATFORM (TM) ")).toBe("threat intelligence platform");
    expect(wordingKey("Detection & Response")).toBe("detection and response");
    expect(wordingKey("Detection and response®")).toBe("detection and response");
    expect(wordingKey("SSO / SAML 2.0")).toBe("sso saml 2 0");
    expect(wordingKey("™")).toBe("");
  });
  it("keys a capability by its wording and a feature by its capability's key and its wording", () => {
    expect(itemKey("capability", null, "Access Management")).toBe("c:access management");
    expect(itemKey("feature", "c:access management", "Role-based access")).toBe("f:c:access management>role based access");
    expect(ownKey({ key: "f:c:access management>role based access" })).toBe("role based access");
  });
});

describe("findItem", () => {
  const items = [
    item("a", { key: "c:access management", wordings: ["access management", "identity and access"] }),
    item("f1", { kind: "feature", key: "f:c:access management>rbac", wordings: ["rbac"], parentItemId: "a" }),
    item("b", { key: "c:reporting", wordings: ["reporting"] }),
    item("f2", { kind: "feature", key: "f:c:reporting>rbac", wordings: ["rbac"], parentItemId: "b" }),
  ];
  it("finds a capability by its key and by a wording an earlier merge saved", () => {
    expect(findItem(items, "capability", null, "Access-Management")?.id).toBe("a");
    expect(findItem(items, "capability", null, "Identity & Access")?.id).toBe("a");
    expect(findItem(items, "capability", null, "Billing")).toBeNull();
  });
  it("finds a feature only under its own capability", () => {
    expect(findItem(items, "feature", "a", "RBAC")?.id).toBe("f1");
    expect(findItem(items, "feature", "b", "RBAC")?.id).toBe("f2");
    expect(findItem(items, "feature", "c", "RBAC")).toBeNull();
    expect(findItem(items, "capability", null, "RBAC")).toBeNull();
  });
});

describe("canonicalName", () => {
  it("the most frequent wording; tie → the shortest; tie → alphabetical", () => {
    expect(canonicalName(["SSO", "Single sign-on", "Single sign-on"])).toBe("Single sign-on");
    expect(canonicalName(["Single sign-on", "SSO"])).toBe("SSO");
    expect(canonicalName(["Beta", "Alfa"])).toBe("Alfa");
    expect(canonicalName([])).toBe("");
  });
});

describe("planMerges", () => {
  it("the item merged by an earlier run (KNOWN) is the keeper", () => {
    const byCode = new Map([["M1", item("new", { findings: 9 })], ["M2", item("known", { mergeChecked: true, findings: 1 })]]);
    expect(planMerges([["M1", "M2"]], byCode)).toEqual([{ keepId: "known", absorbIds: ["new"], matchFromId: null }]);
  });
  it("otherwise the one with the most findings, then the smallest key", () => {
    const byCode = new Map([["M1", item("b", { findings: 2 })], ["M2", item("c", { findings: 5 })], ["M3", item("a", { findings: 5 })]]);
    expect(planMerges([["M1", "M2", "M3"]], byCode)).toEqual([{ keepId: "a", absorbIds: ["b", "c"], matchFromId: null }]);
  });
  it("an absorbed item's saved match is handed over only when the keeper has none", () => {
    const withMatch = new Map([["M1", item("keep", { findings: 3 })], ["M2", item("gone", { settled: true })]]);
    expect(planMerges([["M1", "M2"]], withMatch)[0].matchFromId).toBe("gone");
    const bothMatched = new Map([["M1", item("keep", { findings: 3, settled: true })], ["M2", item("gone", { settled: true })]]);
    expect(planMerges([["M1", "M2"]], bothMatched)[0].matchFromId).toBeNull();
  });
  it("ignores codes it does not know and groups left with one item", () => {
    expect(planMerges([["M1", "M9"], ["M8"]], new Map([["M1", item("a")]]))).toEqual([]);
  });
});

describe("planChildMerges", () => {
  it("features of merged capabilities that share a wording become one", () => {
    const children = [
      item("x", { kind: "feature", key: "f:c:a>rbac", wordings: ["rbac"], parentItemId: "a", findings: 1 }),
      item("y", { kind: "feature", key: "f:c:b>rbac", wordings: ["rbac", "role based access"], parentItemId: "a", findings: 4 }),
      item("z", { kind: "feature", key: "f:c:a>audit log", wordings: ["audit log"], parentItemId: "a" }),
    ];
    expect(planChildMerges(children)).toEqual([{ keepId: "y", absorbIds: ["x"], matchFromId: null }]);
  });
});
