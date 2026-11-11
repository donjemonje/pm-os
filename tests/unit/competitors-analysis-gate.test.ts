/** Capability Analysis — who may run while the PMOS AI step is off (analysis/gate.ts). Pure module. */
import { describe, expect, it } from "vitest";
import { analysisMayRun, queueFilter } from "@/lib/competitors/analysis/gate";

describe("analysisMayRun", () => {
  it("with the AI step on, every trigger runs", () => {
    for (const trigger of ["scan", "catalog", "manual"]) expect(analysisMayRun({ trigger, injected: false }, { aiOff: false })).toBe(true);
  });
  it("with the AI step off, the automatic triggers queue nothing", () => {
    expect(analysisMayRun({ trigger: "scan", injected: false }, { aiOff: true })).toBe(false);
    expect(analysisMayRun({ trigger: "catalog", injected: false }, { aiOff: true })).toBe(false);
  });
  it("with the AI step off, a run asked for by hand still runs", () => {
    expect(analysisMayRun({ trigger: "manual", injected: false }, { aiOff: true })).toBe(true);
  });
  it("with the AI step off, a run with injected answers still runs (it never calls a model)", () => {
    expect(analysisMayRun({ trigger: "scan", injected: true }, { aiOff: true })).toBe(true);
    expect(analysisMayRun({ trigger: "catalog", injected: true }, { aiOff: true })).toBe(true);
  });
});

describe("queueFilter", () => {
  it("with the AI step on, the queue is every queued, running or waiting run", () => {
    expect(queueFilter({ aiOff: false })).toEqual({ status: { in: ["queued", "running", "waiting"] } });
  });
  it("with the AI step off, a queued run counts only when it is manual or injected; running and waiting runs always count", () => {
    expect(queueFilter({ aiOff: true })).toEqual({
      OR: [{ status: { in: ["running", "waiting"] } }, { status: "queued", OR: [{ trigger: "manual" }, { injected: true }] }],
    });
  });
});
