/**
 * IMP-24 (release QA 4.0.0) — customers read from Jira issue text, tier 1:
 * the deterministic catalog match (src/lib/ideas/customer-mentions.ts).
 * Pure module, no DB, no Vertex. The AI tier and the snapshot upsert that
 * keeps dismissals are DB/model paths (store.ts) and are not covered here.
 */
import { describe, expect, it } from "vitest";
import {
  customersTextHash,
  findCatalogCustomers,
  issueCustomerText,
  JIRA_CUSTOMERS_PROMPT_VERSION,
} from "@/lib/ideas/customer-mentions";

const catalog = [
  { name: "Nuvei" },
  { name: "Vital" },
  { name: "Papaya Global", aliases: ["Papaya"] },
  { name: "Bank Hapoalim", aliases: ["Hapoalim", "BHP"] },
  { name: "All Customers" },
  { name: "AB" }, // shorter than the 3-char floor
];

describe("findCatalogCustomers — tier 1 catalog match", () => {
  it("returns catalog spelling for names found whole in the text, in catalog order, once each", () => {
    const text = "Requested by Nuvei and Nuvei again; Papaya global wants it too. Vital asked as well.";
    expect(findCatalogCustomers(text, catalog)).toEqual(["Nuvei", "Vital", "Papaya Global"]);
  });

  it("multi-word names match case-insensitively; a single-word name must match its casing", () => {
    expect(findCatalogCustomers("PAPAYA GLOBAL needs exports", catalog)).toEqual(["Papaya Global"]);
    expect(findCatalogCustomers("this is vital for the launch", catalog)).toEqual([]);
    expect(findCatalogCustomers("Vital for the launch", catalog)).toEqual(["Vital"]);
  });

  it("aliases count, including single-word ones with exact casing", () => {
    expect(findCatalogCustomers("Hapoalim reported it", catalog)).toEqual(["Bank Hapoalim"]);
    expect(findCatalogCustomers("the BHP team", catalog)).toEqual(["Bank Hapoalim"]);
    expect(findCatalogCustomers("the bhp team", catalog)).toEqual([]);
    expect(findCatalogCustomers("Papaya asked", catalog)).toEqual(["Papaya Global"]);
  });

  it("whole-word only: no hit inside a longer word, punctuation next to the name is fine", () => {
    expect(findCatalogCustomers("Vitality metrics and Nuveis", catalog)).toEqual([]);
    expect(findCatalogCustomers("(Nuvei), Vital. and 'Papaya Global'!", catalog)).toEqual(["Nuvei", "Vital", "Papaya Global"]);
  });

  it("skips the built-in All Customers row and names under 3 characters; empty text is empty", () => {
    expect(findCatalogCustomers("All Customers want AB", catalog)).toEqual([]);
    expect(findCatalogCustomers("   ", catalog)).toEqual([]);
  });

  it("handles non-Latin names with the unicode boundary", () => {
    const heb = [{ name: "בנק לאומי" }];
    expect(findCatalogCustomers("פנייה מ בנק לאומי לגבי ייצוא", heb)).toEqual(["בנק לאומי"]);
  });
});

describe("issueCustomerText + customersTextHash", () => {
  it("joins summary and description in one stable shape and trims", () => {
    expect(issueCustomerText("  Title ", "Body\n")).toBe("Title \n\nBody");
    expect(issueCustomerText("", "")).toBe("");
  });

  it("hash is stable for the same text and bound to the prompt version", () => {
    const t = issueCustomerText("T", "B");
    expect(customersTextHash(t)).toBe(customersTextHash(t));
    expect(customersTextHash(t)).not.toBe(customersTextHash(t + " "));
    expect(JIRA_CUSTOMERS_PROMPT_VERSION).toMatch(/^jira-customers-v\d+$/);
    expect(customersTextHash(t)).toHaveLength(40); // sha1 hex
  });
});
