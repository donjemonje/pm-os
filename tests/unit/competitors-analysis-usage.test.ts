/** Capability Analysis — a run's tokens by step, model and company (analysis/usage.ts, setup-rules.ts setupTotals). Pure modules. */
import { describe, expect, it } from "vitest";
import { geminiUsage } from "@/lib/competitors/ai";
import { emptyCounters, readCounters, sumCounters } from "@/lib/competitors/analysis/counters";
import { emptySetupProgress, readSetupProgress, setupTotals } from "@/lib/competitors/analysis/setup-rules";
import { addUsage, answerTokens, readUsage, rollUp, sortUsage, usageByModel, usageByModelText, usageByStep, usageLine, usageSince, usageTotal, type StepUsage } from "@/lib/competitors/analysis/usage";

const H = "gemini-4-hydrogen";
const A = "gemini-4-argon";
const C = "gemini-4-carbon";

/** One company's run: 2 research calls, a merge, a go-back that reads and merges, a second look. */
function company(): StepUsage[] {
  const list: StepUsage[] = [];
  addUsage(list, "map", H, { input: 900, output: 100, cached: 0 });
  addUsage(list, "research", H, { input: 10_000, output: 800, cached: 0 });
  addUsage(list, "research", H, { input: 12_000, output: 700, cached: 2_000 });
  addUsage(list, "merge", A, { input: 3_000, output: 400, cached: 0 });
  addUsage(list, "go_back", H, { input: 5_000, output: 300, cached: 0 });
  addUsage(list, "go_back", A, { input: 1_000, output: 100, cached: 0 });
  addUsage(list, "second_look", H, { input: 20_000, output: 150, cached: 0 });
  return list;
}

describe("every call adds to the row of its step and its model", () => {
  const list = company();
  it("one row per step and model: calls counted, input / output / cached added up", () => {
    expect(list.find((r) => r.step === "research")).toEqual({ step: "research", model: H, calls: 2, input: 22_000, output: 1_500, cached: 2_000, thinking: 0, ms: 0 });
    expect(list).toHaveLength(6);
  });
  it("a go-back round reads with one model and merges with another: two rows under go_back", () => {
    expect(list.filter((r) => r.step === "go_back").map((r) => r.model).sort()).toEqual([A, H]);
  });
  it("a call with an unusable answer is billed and counted like any call", () => {
    const l: StepUsage[] = [];
    addUsage(l, "research", H, { input: 500, output: 8_000, cached: 0 });
    expect(l[0]).toMatchObject({ calls: 1, input: 500, output: 8_000 });
  });
  it("an injected answer (test knob) counts the call with no tokens", () => {
    const l: StepUsage[] = [];
    addUsage(l, "match", A, { input: 0, output: 0, cached: 0 });
    expect(l[0]).toEqual({ step: "match", model: A, calls: 1, input: 0, output: 0, cached: 0, thinking: 0, ms: 0 });
  });
});

describe("thinking tokens are recorded apart from the visible answer, wherever the provider reports them", () => {
  it("Gemini reports the answer and the thinking apart: both are output, the thinking is kept as its own number", () => {
    expect(geminiUsage({ promptTokenCount: 2_650, candidatesTokenCount: 1_143, thoughtsTokenCount: 1_536, cachedContentTokenCount: 0 })).toEqual({ input: 2_650, output: 2_679, cached: 0, thinking: 1_536 });
    expect(geminiUsage({ promptTokenCount: 900, candidatesTokenCount: 100 })).toEqual({ input: 900, output: 100, cached: 0, thinking: 0 });
    expect(geminiUsage(undefined)).toEqual({ input: 0, output: 0, cached: 0, thinking: 0 });
  });
  it("a row adds up the thinking of its calls; the answer is the output without it", () => {
    const l: StepUsage[] = [];
    addUsage(l, "research", H, { input: 2_650, output: 2_679, cached: 0, thinking: 1_536 });
    addUsage(l, "research", H, { input: 3_000, output: 2_000, cached: 0, thinking: 900 });
    addUsage(l, "merge", A, { input: 3_000, output: 1_182, cached: 0, thinking: 0 });
    expect(l[0]).toEqual({ step: "research", model: H, calls: 2, input: 5_650, output: 4_679, cached: 0, thinking: 2_436, ms: 0 });
    expect(answerTokens(l[0])).toBe(2_243);
    expect(answerTokens(l[1])).toBe(1_182);
    expect(usageTotal(l)).toEqual({ calls: 3, input: 8_650, output: 5_861, cached: 0, thinking: 2_436, ms: 0 });
    expect(usageByModel(l).map((m) => [m.model, m.thinking])).toEqual([[A, 0], [H, 2_436]]);
    expect(usageByStep(l).map((x) => [x.step, x.thinking])).toEqual([["research", 2_436], ["merge", 0]]);
  });
  it("a call that reports no thinking, or gives none, adds none", () => {
    const l: StepUsage[] = [];
    addUsage(l, "match", A, { input: 10, output: 5, cached: 0 });
    expect(l[0].thinking).toBe(0);
  });
  it("the run log says the thinking part of a step only when there is one", () => {
    expect(usageLine({ model: H, calls: 12, input: 120_000, output: 8_000, cached: 3_000, thinking: 4_500, ms: 0 })).toBe(`${H}: 12 calls · 120,000 input + 8,000 output tokens, 4,500 of them thinking (3,000 cached)`);
    expect(usageLine({ model: A, calls: 1, input: 3_000, output: 400, cached: 0, thinking: 0, ms: 0 })).toBe(`${A}: 1 call · 3,000 input + 400 output tokens`);
  });
  it("what a step cost carries its thinking; roll-ups add it up; a row stored before thinking was recorded reads as 0", () => {
    const before: StepUsage[] = [{ step: "research", model: H, calls: 1, input: 100, output: 50, cached: 0, thinking: 20, ms: 0 }];
    const now: StepUsage[] = [{ step: "research", model: H, calls: 3, input: 400, output: 250, cached: 0, thinking: 120, ms: 0 }];
    expect(usageSince(now, before)).toEqual([{ step: "research", model: H, calls: 2, input: 300, output: 200, cached: 0, thinking: 100, ms: 0 }]);
    expect(rollUp([before, now])).toEqual([{ step: "research", model: H, calls: 4, input: 500, output: 300, cached: 0, thinking: 140, ms: 0 }]);
    expect(readUsage([{ step: "research", model: H, calls: 2, input: 22_000, output: 1_500, cached: 2_000 }])).toEqual([{ step: "research", model: H, calls: 2, input: 22_000, output: 1_500, cached: 2_000, thinking: 0, ms: 0 }]);
    expect(readUsage([{ step: "research", model: H, calls: 1, input: 1, output: 9, cached: 0, thinking: 4, ms: 0 }])[0].thinking).toBe(4);
  });
  it("the run's counters keep the total next to input and output", () => {
    expect(emptyCounters().thinkingTokens).toBe(0);
    expect(readCounters({ inputTokens: 5, outputTokens: 9, thinkingTokens: 4 }).thinkingTokens).toBe(4);
    expect(readCounters({ inputTokens: 5, outputTokens: 9 }).thinkingTokens).toBe(0);
    expect(sumCounters([{ ...emptyCounters(), thinkingTokens: 4 }, { ...emptyCounters(), thinkingTokens: 6 }]).thinkingTokens).toBe(10);
  });
});

describe("roll-ups", () => {
  const list = company();
  it("per step, in run order, with the models the step used", () => {
    expect(usageByStep(list).map((s) => [s.step, s.models, s.calls, s.input, s.output])).toEqual([
      ["map", [H], 1, 900, 100],
      ["research", [H], 2, 22_000, 1_500],
      ["merge", [A], 1, 3_000, 400],
      ["go_back", [A, H], 2, 6_000, 400],
      ["second_look", [H], 1, 20_000, 150],
    ]);
  });
  it("per model, whatever the step", () => {
    expect(usageByModel(list)).toEqual([
      { model: A, calls: 2, input: 4_000, output: 500, cached: 0, thinking: 0, ms: 0 },
      { model: H, calls: 5, input: 47_900, output: 2_050, cached: 2_000, thinking: 0, ms: 0 },
    ]);
    expect(usageByModelText(list)).toBe(`${A} 4000/500; ${H} 47900/2050`);
  });
  it("the total is every row", () => {
    expect(usageTotal(list)).toEqual({ calls: 7, input: 51_900, output: 2_550, cached: 2_000, thinking: 0, ms: 0 });
  });
  it("rows are shown by step in run order, then by model; an unknown step comes last", () => {
    expect(sortUsage([{ step: "zzz", model: H, calls: 1, input: 1, output: 1, cached: 0, thinking: 0, ms: 0 }, ...list]).map((r) => `${r.step}/${r.model}`)).toEqual([
      `map/${H}`, `research/${H}`, `merge/${A}`, `go_back/${A}`, `go_back/${H}`, `second_look/${H}`, `zzz/${H}`,
    ]);
  });
  it("what a step cost is what was added since it started, model by model — the line the run log carries", () => {
    const before = list.map((r) => ({ ...r }));
    addUsage(list, "apply", H, { input: 7_000, output: 600, cached: 1_000 });
    addUsage(list, "apply", H, { input: 3_000, output: 400, cached: 0 });
    const step = usageSince(list, before);
    expect(step).toEqual([{ step: "apply", model: H, calls: 2, input: 10_000, output: 1_000, cached: 1_000, thinking: 0, ms: 0 }]);
    expect(usageByModel(step).map(usageLine)).toEqual([`${H}: 2 calls · 10,000 input + 1,000 output tokens (1,000 cached)`]);
    expect(usageLine({ model: C, calls: 1, input: 30_000, output: 5_000, cached: 0, thinking: 0, ms: 0 })).toBe(`${C}: 1 call · 30,000 input + 5,000 output tokens`);
    expect(usageSince(list, list.map((r) => ({ ...r })))).toEqual([]);
  });
});

describe("a setup run: per company, and the whole run", () => {
  const own = company();
  const competitor = company();
  addUsage(competitor, "match", A, { input: 40_000, output: 9_000, cached: 30_000 });
  const shared: StepUsage[] = [];
  addUsage(shared, "unify", A, { input: 8_000, output: 2_000, cached: 0 });
  addUsage(shared, "unify", C, { input: 15_000, output: 1_000, cached: 0 }); // the review, under the same step
  addUsage(shared, "domains", C, { input: 14_000, output: 4_000, cached: 0 });
  const progress = { ...emptySetupProgress(), sharedUsage: shared, companies: [
    { competitorId: "us", name: "Aha", own: true, stage: "done" as const, pagesTotal: 2, pagesDone: 2, appliedAt: null, counters: emptyCounters(), usage: own, notRead: {} },
    { competitorId: "pb", name: "Productboard", own: false, stage: "done" as const, pagesTotal: 2, pagesDone: 2, appliedAt: null, counters: emptyCounters(), usage: competitor, notRead: {} },
  ] };
  it("each company keeps its own rows", () => {
    expect(usageTotal(progress.companies[0].usage)).toEqual({ calls: 7, input: 51_900, output: 2_550, cached: 2_000, thinking: 0, ms: 0 });
    expect(usageTotal(progress.companies[1].usage)).toEqual({ calls: 8, input: 91_900, output: 11_550, cached: 32_000, thinking: 0, ms: 0 });
  });
  it("the run's rows are the roll-up of its companies and of the shared calls: one row per step and model", () => {
    const run = setupTotals(progress).usage;
    expect(run.find((r) => r.step === "research")).toEqual({ step: "research", model: H, calls: 4, input: 44_000, output: 3_000, cached: 4_000, thinking: 0, ms: 0 });
    expect(run.filter((r) => r.step === "unify").map((r) => [r.model, r.calls])).toEqual([[A, 1], [C, 1]]);
    expect(run.find((r) => r.step === "domains")).toMatchObject({ model: C, calls: 1, input: 14_000, output: 4_000 });
    expect(usageTotal(run)).toEqual({ calls: 18, input: 180_800, output: 21_100, cached: 34_000, thinking: 0, ms: 0 });
    expect(usageTotal(run)).toEqual(usageTotal(rollUp([own, competitor, shared])));
    expect(usageByModel(run).map((m) => m.model)).toEqual([A, C, H]);
  });
  it("rolling up does not change the lists it was made from", () => {
    const before = JSON.stringify(own);
    rollUp([own, competitor, shared]);
    expect(JSON.stringify(own)).toBe(before);
  });
  it("the stored progress carries the lists; a run stored before they existed reads as none", () => {
    const back = readSetupProgress(JSON.parse(JSON.stringify(progress)));
    expect(back.companies[1].usage).toEqual(competitor);
    expect(back.sharedUsage).toEqual(shared);
    expect(readSetupProgress({ companies: [{ competitorId: "x", name: "X" }] }).companies[0].usage).toEqual([]);
  });
});

describe("the stored list", () => {
  it("is read row by row: anything that is not a row is left out, a bad number is 0", () => {
    expect(readUsage([{ step: "map", model: H, calls: 1, input: 5, output: "x", cached: -3 }, { step: "", model: H }, null, 7, { model: H }])).toEqual([{ step: "map", model: H, calls: 1, input: 5, output: 0, cached: 0, thinking: 0, ms: 0 }]);
    expect(readUsage(undefined)).toEqual([]);
    expect(readUsage({})).toEqual([]);
  });
});

describe("the time of the calls is kept with the tokens (Administration shows the time per step)", () => {
  it("a call's time is added to the row of its step and model; a row stored before time was recorded reads as 0", () => {
    const l: StepUsage[] = [];
    addUsage(l, "reading", A, { input: 400_000, output: 9_000, cached: 0, thinking: 0 }, 211_000);
    addUsage(l, "reading", A, { input: 440_000, output: 3_300, cached: 0, thinking: 0 }, 64_000);
    addUsage(l, "unify", C, { input: 6_500, output: 17_700, cached: 0, thinking: 14_700 }, 202_000);
    expect(l[0]).toEqual({ step: "reading", model: A, calls: 2, input: 840_000, output: 12_300, cached: 0, thinking: 0, ms: 275_000 });
    expect(usageTotal(l).ms).toBe(477_000);
    expect(usageByStep(l).map((s) => [s.step, s.ms])).toEqual([["reading", 275_000], ["unify", 202_000]]);
    expect(rollUp([l, l]).find((r) => r.step === "unify")?.ms).toBe(404_000);
    expect(readUsage([{ step: "reading", model: A, calls: 1, input: 1, output: 1, cached: 0 }])[0].ms).toBe(0);
  });
  it("the reading is a step of its own, shown after the map", () => {
    expect(sortUsage([{ step: "unify", model: C, calls: 1, input: 1, output: 1, cached: 0, thinking: 0, ms: 0 }, { step: "reading", model: A, calls: 1, input: 1, output: 1, cached: 0, thinking: 0, ms: 0 }, { step: "map", model: A, calls: 1, input: 1, output: 1, cached: 0, thinking: 0, ms: 0 }]).map((r) => r.step)).toEqual(["map", "reading", "unify"]);
  });
});
