import { describe, expect, it } from "vitest";
import { diffIdea, undoAll, undoOne, type IdeaBaseline, type IdeaLike } from "@/lib/ideas/changes";

const base: IdeaBaseline = {
  title: "Export presets",
  details: "Save export settings as presets.",
  manual: null,
  products: ["Other"],
  platforms: [],
  addedCustomers: [],
  zen: ["ZEN-1"],
  jira: ["KQA-10"],
};

const touched: IdeaLike = {
  ...base,
  title: "Export presets (shared)",
  details: "Save export settings as presets. Share them with the team.",
  products: ["Workflows"],
  platforms: ["Web"],
  addedCustomers: ["Acme"],
  zen: ["ZEN-1", "ZEN-7"],
  jira: ["KQA-10"],
};

describe("diffIdea", () => {
  it("is empty when nothing changed", () => {
    expect(diffIdea(undoAll(base), base)).toEqual([]);
  });

  it("lists one undoable line per difference", () => {
    const ids = diffIdea(touched, base).map((c) => c.id);
    expect(ids).toEqual([
      "source:zen:+:ZEN-7",
      "title",
      "details",
      "product:+:Workflows",
      "product:-:Other",
      "platform:+:Web",
      "customer:+:Acme",
    ]);
  });

  it("compares names case-insensitively", () => {
    expect(diffIdea({ ...base, products: ["other"] }, base)).toEqual([]);
  });
});

describe("undoOne", () => {
  it("detaches an added source and leaves the rest", () => {
    const next = undoOne(touched, base, "source:zen:+:ZEN-7");
    expect(next.zen).toEqual(["ZEN-1"]);
    expect(next.title).toBe(touched.title);
  });

  it("re-attaches a removed source", () => {
    const next = undoOne({ ...touched, zen: [] }, base, "source:zen:-:ZEN-1");
    expect(next.zen).toEqual(["ZEN-1"]);
  });

  it("restores a field to the baseline", () => {
    expect(undoOne(touched, base, "title").title).toBe(base.title);
    expect(undoOne(touched, base, "details").details).toBe(base.details);
  });

  it("never leaves the product-line list empty", () => {
    const next = undoOne(touched, base, "product:+:Workflows");
    expect(next.products).toEqual(["Other"]);
  });

  it("undoing every line equals undo all", () => {
    let cur: IdeaLike = touched;
    for (const c of diffIdea(touched, base)) cur = undoOne(cur, base, c.id);
    expect(diffIdea(cur, base)).toEqual([]);
    expect(cur).toEqual(undoAll(base));
  });

  it("ignores an unknown change id", () => {
    expect(undoOne(touched, base, "nope")).toEqual(touched);
  });
});
