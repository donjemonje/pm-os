import { describe, expect, it } from "vitest";
import { diffIdea, type IdeaBaseline, type IdeaLike } from "@/lib/ideas/changes";

const base: IdeaBaseline = {
  title: "Export presets",
  details: "Save export settings as presets.",
  manual: null,
  products: ["Other"],
  platforms: [],
  addedCustomers: [],
  customers: ["Acme"],
  zen: ["825"],
  jira: ["PRDT-10"],
};

const touched: IdeaLike = {
  ...base,
  title: "Export presets (shared)",
  details: "Save export settings as presets. Share them with the team.",
  products: ["Workflows", "Platform"],
  platforms: ["Web"],
  customers: ["Acme", "Nuvei", "Hitachi"],
  zen: ["825", "112", "624"],
  jira: ["PRDT-10", "PRDT-331"],
};

describe("diffIdea", () => {
  it("is empty when nothing changed", () => {
    expect(diffIdea({ ...base }, base)).toEqual([]);
  });

  it("folds related items into one line each", () => {
    expect(diffIdea(touched, base).map((c) => c.label)).toEqual([
      "+2 votes: 112, 624",
      "Jira merges 1: PRDT-331",
      "Title changed",
      "Description updated",
      "Product lines added: Workflows, Platform",
      "Product lines removed: Other",
      "Platforms added: Web",
      "+2 customers",
    ]);
  });

  it("carries the previous text on the Description updated line", () => {
    expect(diffIdea(touched, base).find((c) => c.kind === "details")?.from).toBe(base.details);
  });

  it("reports removals with a minus", () => {
    const labels = diffIdea({ ...base, zen: [], customers: [] }, base).map((c) => c.label);
    expect(labels).toEqual(["−1 vote: 825", "−1 customer"]);
  });

  it("skips the customers line for baselines that do not know them", () => {
    const old = { ...base, customers: undefined };
    expect(diffIdea(touched, old).some((c) => c.kind === "customers")).toBe(false);
  });

  it("compares names case-insensitively", () => {
    expect(diffIdea({ ...base, products: ["other"], customers: ["ACME"] }, base)).toEqual([]);
  });
});
