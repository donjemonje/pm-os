/** Capability Analysis — the token budget of one run (analysis/budget.ts): the setting's limits and the gate of the reading calls. Pure module. */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_TOKEN_BUDGET_DEFAULT,
  ANALYSIS_TOKEN_BUDGET_MAX,
  ANALYSIS_TOKEN_BUDGET_MIN,
  analysisTokenBudgetOf,
  checkAnalysisTokenBudget,
  ReadingBudget,
} from "@/lib/competitors/analysis/budget";

describe("the setting", () => {
  it("defaults to 1,000,000 tokens per competitor, per run", () => {
    expect(ANALYSIS_TOKEN_BUDGET_DEFAULT).toBe(1_000_000);
    expect(ANALYSIS_TOKEN_BUDGET_MIN).toBeLessThan(ANALYSIS_TOKEN_BUDGET_DEFAULT);
    expect(ANALYSIS_TOKEN_BUDGET_MAX).toBeGreaterThan(ANALYSIS_TOKEN_BUDGET_DEFAULT);
  });
  it("accepts a whole number between the minimum and the maximum, the limits included", () => {
    for (const v of [ANALYSIS_TOKEN_BUDGET_MIN, 250_000, ANALYSIS_TOKEN_BUDGET_DEFAULT, ANALYSIS_TOKEN_BUDGET_MAX]) expect(checkAnalysisTokenBudget(v), String(v)).toEqual({ value: v });
  });
  it("refuses anything else, and says what is expected", () => {
    for (const v of [ANALYSIS_TOKEN_BUDGET_MIN - 1, ANALYSIS_TOKEN_BUDGET_MAX + 1, 0, -5, 1_000_000.5, Number.NaN, Number.POSITIVE_INFINITY, "1000000", null, undefined, true, {}]) {
      const r = checkAnalysisTokenBudget(v);
      expect("error" in r, String(v)).toBe(true);
      if ("error" in r) expect(r.error).toBe("The analysis token budget must be a whole number between 100,000 and 50,000,000.");
    }
  });
  it("a stored value that is not a valid budget reads as the default — never as no budget", () => {
    for (const stored of [undefined, null, "2000000", 0, -1, 12.5, ANALYSIS_TOKEN_BUDGET_MAX + 1, { n: 1 }]) expect(analysisTokenBudgetOf(stored), String(stored)).toBe(ANALYSIS_TOKEN_BUDGET_DEFAULT);
    expect(analysisTokenBudgetOf(2_000_000)).toBe(2_000_000);
  });
});

describe("ReadingBudget — the gate of every reading call", () => {
  it("admits calls while what the run used, the calls in flight and the next call fit", () => {
    let used = 0;
    const b = new ReadingBudget(100, () => used);
    expect(b.admit(40)).toBe(true);
    expect(b.admit(40)).toBe(true);
    // 80 in flight + 30 > 100
    expect(b.admit(30)).toBe(false);
    expect(b.reached).toBe(true);
  });
  it("every token of the run counts — also what the map, merge and match used", () => {
    const b = new ReadingBudget(100, () => 95);
    expect(b.admit(10)).toBe(false);
    expect(b.reached).toBe(true);
    const fits = new ReadingBudget(100, () => 90);
    expect(fits.admit(10)).toBe(true);
    expect(fits.reached).toBe(false);
  });
  it("a released call counts by what it really used, not by its estimate", () => {
    let used = 0;
    const b = new ReadingBudget(100, () => used);
    expect(b.admit(60)).toBe(true);
    used += 20; // the call used less than estimated
    b.release(60);
    expect(b.admit(60)).toBe(true);
    used += 60;
    b.release(60);
    expect(b.admit(30)).toBe(false);
  });
  it("once reached, no further reading call starts — however small, whatever is released later", () => {
    let used = 0;
    const b = new ReadingBudget(100, () => used);
    expect(b.admit(90)).toBe(true);
    expect(b.admit(20)).toBe(false);
    b.release(90);
    used = 10;
    expect(b.admit(1)).toBe(false);
    expect(b.admit(0)).toBe(false);
    expect(b.reached).toBe(true);
  });
  it("exactly the budget fits; one token more does not", () => {
    expect(new ReadingBudget(100, () => 60).admit(40)).toBe(true);
    expect(new ReadingBudget(100, () => 60).admit(41)).toBe(false);
  });
  it("a page larger than the whole budget cannot block every run forever: the first reading call of a run goes through, and the gate closes behind it", () => {
    const b = new ReadingBudget(100, () => 5);
    expect(b.admit(500)).toBe(true);
    expect(b.reached).toBe(true);
    expect(b.admit(1)).toBe(false);
    // Not the first reading call: an oversized call is refused like any other.
    const later = new ReadingBudget(100, () => 0);
    expect(later.admit(10)).toBe(true);
    expect(later.admit(500)).toBe(false);
  });
  it("deterministic: the same to-do in the same order stops at the same call", () => {
    const run = () => {
      let used = 0;
      const b = new ReadingBudget(1000, () => used);
      const read: number[] = [];
      for (const estimate of [300, 300, 300, 50, 300]) {
        if (!b.admit(estimate)) break;
        read.push(estimate);
        used += estimate;
        b.release(estimate);
      }
      return read;
    };
    // 900 used; the 50 fits (950); the last 300 would pass it.
    expect(run()).toEqual([300, 300, 300, 50]);
    expect(run()).toEqual(run());
  });
});
