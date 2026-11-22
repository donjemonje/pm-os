/** Capability Analysis — what identifies an entry of a company's list (analysis/items.ts). Pure module. */
import { describe, expect, it } from "vitest";
import { itemKey, wordingKey } from "@/lib/competitors/analysis/items";

describe("wordingKey / itemKey", () => {
  it("normalizes: case, punctuation, the ampersand, marks", () => {
    expect(wordingKey("Threat-Intelligence Platform™")).toBe("threat intelligence platform");
    expect(wordingKey("Threat-Intelligence Platform(TM)")).toBe("threat intelligence platform");
    expect(wordingKey("  SSO & SAML  ")).toBe("sso and saml");
    expect(wordingKey("Roadmaps®")).toBe("roadmaps");
    expect(wordingKey("—")).toBe("");
  });
  it("keys a capability by its wording, and a feature by its capability ITEM and its wording — so a capability that is renamed keeps its features' keys", () => {
    expect(itemKey("capability", null, "Single Sign-On")).toBe("c:single sign on");
    expect(itemKey("feature", "item-123", "SAML 2.0")).toBe("f:item-123>saml 2 0");
    expect(itemKey("feature", "item-123", "saml  2.0")).toBe(itemKey("feature", "item-123", "SAML 2.0"));
    expect(itemKey("feature", "item-456", "SAML 2.0")).not.toBe(itemKey("feature", "item-123", "SAML 2.0"));
  });
});
