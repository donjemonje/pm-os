/** Story 3 (competitors) — the news feed's pure parts: how a status move reads, and its impact. */
import { describe, expect, it } from "vitest";
import { impactOf, statusKind } from "@/lib/competitors/feed";

describe("statusKind", () => {
  it("gap when the org lacks it, raised when it has it too, lowered on a drop, nothing on a tie", () => {
    expect(statusKind("missing", "has", "missing")).toBe("gap");
    expect(statusKind("partial", "has", "partial")).toBe("raised");
    expect(statusKind("has", "partial", "has")).toBe("lowered");
    expect(statusKind("has", "has", "missing")).toBeNull();
  });
});

describe("impactOf", () => {
  it("gap is High, status moves Medium, facts and suggestions Low", () => {
    expect(impactOf("gap")).toBe("High");
    expect(impactOf("raised")).toBe("Medium");
    expect(impactOf("lowered")).toBe("Medium");
    expect(impactOf("fact")).toBe("Low");
    expect(impactOf("suggestion")).toBe("Low");
  });
});
