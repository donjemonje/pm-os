import { describe, expect, it } from "vitest";
import { ownProductLabel } from "@/lib/competitors/ownProduct";

describe("ownProductLabel", () => {
  it("returns the whole value when it has no note", () => {
    expect(ownProductLabel("Identity Guard")).toBe("Identity Guard");
  });
  it("keeps only the part before the first semicolon", () => {
    expect(ownProductLabel("Monitor; also surfaced in Investigate")).toBe("Monitor");
    expect(ownProductLabel("ULTRA RED; Network Vulnerability incidents inside Monitor")).toBe("ULTRA RED");
  });
  it("trims and falls back to the trimmed value when the head is empty", () => {
    expect(ownProductLabel("  Brand Control ; x")).toBe("Brand Control");
    expect(ownProductLabel("; note only")).toBe("; note only");
    expect(ownProductLabel("")).toBe("");
  });
});
