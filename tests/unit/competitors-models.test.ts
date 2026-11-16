/** Capability Analysis — a model per step (lib/competitors/models.ts): role → model with and without overrides, and what a refused model says. Pure module. */
import { describe, expect, it } from "vitest";
import {
  callFailureMessage,
  competitorsModels,
  competitorsThinking,
  MODEL_DEFAULTS,
  MODEL_ENV,
  modelFor,
  modelOfPrompt,
  modelRefused,
  modelsLine,
  PROMPT_ROLES,
  providerOf,
  retiredThinkingOverride,
  THINKING_DEFAULTS,
  THINKING_ENV,
  THINKING_ENV_ALL,
  THINKING_LEVELS,
  thinkingFor,
  thinkingLine,
} from "@/lib/competitors/models";

describe("role → thinking level", () => {
  it("a level per role: medium for the reading role and for unify and domains — never low for the steps that build the table", () => {
    expect(THINKING_DEFAULTS).toEqual({ read: "medium", match: "high", judge: "medium" });
    expect(competitorsThinking({})).toEqual({ read: "medium", match: "high", judge: "medium" });
    expect(THINKING_LEVELS).toEqual(["minimal", "low", "medium", "high"]);
  });
  it("each role has its own override", () => {
    expect(THINKING_ENV).toEqual({ read: "COMPETITORS_THINKING_READ", match: "COMPETITORS_THINKING_MATCH", judge: "COMPETITORS_THINKING_JUDGE" });
    expect(thinkingFor("read", { COMPETITORS_THINKING_READ: "minimal" })).toBe("minimal");
    expect(competitorsThinking({ COMPETITORS_THINKING_MATCH: " Medium " })).toEqual({ read: "medium", match: "medium", judge: "medium" });
    expect(competitorsThinking({ COMPETITORS_THINKING_READ: "high", COMPETITORS_THINKING_MATCH: "low", COMPETITORS_THINKING_JUDGE: "high" })).toEqual({ read: "high", match: "low", judge: "high" });
  });
  it("the old COMPETITORS_THINKING forces nothing any more: with it set to low, every role keeps its own level", () => {
    expect(THINKING_ENV_ALL).toBe("COMPETITORS_THINKING");
    expect(competitorsThinking({ COMPETITORS_THINKING: "low" })).toEqual({ read: "medium", match: "high", judge: "medium" });
    expect(competitorsThinking({ COMPETITORS_THINKING: "low", COMPETITORS_THINKING_JUDGE: "high" })).toEqual({ read: "medium", match: "high", judge: "high" });
  });
  it("a value still set in the retired variable is reported, so a run and the admin screen can say it is ignored", () => {
    expect(retiredThinkingOverride({ COMPETITORS_THINKING: " low " })).toBe("low");
    expect(retiredThinkingOverride({ COMPETITORS_THINKING: "  " })).toBeNull();
    expect(retiredThinkingOverride({})).toBeNull();
  });
  it("a value that is not a level is no override", () => {
    expect(competitorsThinking({ COMPETITORS_THINKING_READ: "0", COMPETITORS_THINKING_MATCH: "  " })).toEqual({ read: "medium", match: "high", judge: "medium" });
    expect(thinkingFor("judge", { COMPETITORS_THINKING: "none", COMPETITORS_THINKING_JUDGE: "high" })).toBe("high");
  });
  it("one line for the run log", () => {
    expect(thinkingLine(competitorsThinking({}))).toBe("read medium · match high · judge medium");
  });
});

describe("role → model", () => {
  it("the defaults are the Gemini 4 line-up: read = argon (hydrogen bills most of its reading output as thinking), match = argon, judge = carbon", () => {
    expect(competitorsModels({})).toEqual({ read: "gemini-4-argon", match: "gemini-4-argon", judge: "gemini-4-carbon" });
    expect(MODEL_DEFAULTS).toEqual({ read: "gemini-4-argon", match: "gemini-4-argon", judge: "gemini-4-carbon" });
  });
  it("each role has its own override", () => {
    expect(MODEL_ENV).toEqual({ read: "COMPETITORS_MODEL_READ", match: "COMPETITORS_MODEL_MATCH", judge: "COMPETITORS_MODEL_JUDGE" });
    expect(modelFor("read", { COMPETITORS_MODEL_READ: "gemini-4-neon" })).toBe("gemini-4-neon");
    expect(competitorsModels({ COMPETITORS_MODEL_MATCH: " claude-x " })).toEqual({ read: "gemini-4-argon", match: "claude-x", judge: "gemini-4-carbon" });
    expect(competitorsModels({ COMPETITORS_MODEL_READ: "a", COMPETITORS_MODEL_MATCH: "b", COMPETITORS_MODEL_JUDGE: "c" })).toEqual({ read: "a", match: "b", judge: "c" });
  });
  it("a blank override is no override", () => {
    expect(modelFor("judge", { COMPETITORS_MODEL_JUDGE: "   " })).toBe("gemini-4-carbon");
    expect(modelFor("judge", { COMPETITORS_MODEL_JUDGE: "" })).toBe("gemini-4-carbon");
  });
  it("the old single COMPETITORS_MODEL forces nothing: with it set to hydrogen, every role keeps its own model", () => {
    expect(competitorsModels({ COMPETITORS_MODEL: "gemini-4-hydrogen" })).toEqual({ read: "gemini-4-argon", match: "gemini-4-argon", judge: "gemini-4-carbon" });
    expect(competitorsModels({ COMPETITORS_MODEL: "something-else" })).toEqual(competitorsModels({}));
  });
  it("every prompt has its role: read for the map, the reading, the second look, facts and the pick of a company's other addresses; match for the match; judge for unify and the domains", () => {
    expect(PROMPT_ROLES).toEqual({ map: "read", reading: "read", unify: "judge", unify_review: "judge", unify_features: "judge", domains: "judge", match: "match", second_look: "read", facts: "read", addresses: "read" });
    expect(modelOfPrompt("reading", {})).toBe("gemini-4-argon");
    expect(modelOfPrompt("map", {})).toBe("gemini-4-argon");
    expect(modelOfPrompt("unify", {})).toBe("gemini-4-carbon");
    expect(modelOfPrompt("unify_features", {})).toBe("gemini-4-carbon");
    expect(modelOfPrompt("domains", { COMPETITORS_MODEL_JUDGE: "gemini-4-xenon" })).toBe("gemini-4-xenon");
  });
  it("a run names all three", () => {
    expect(modelsLine(competitorsModels({}))).toBe("read gemini-4-argon · match gemini-4-argon · judge gemini-4-carbon");
  });
  it("a gemini-* id runs on Gemini, anything else on the Anthropic provider", () => {
    expect(providerOf("gemini-4-carbon")).toBe("gemini");
    expect(providerOf("claude-x")).toBe("claude");
  });
});

describe("a model call that failed for good", () => {
  const at = { step: "second_look", role: "read" as const, model: "gemini-4-hydrogen" };
  it("a refused model id is recognised: 404, or 400 / 403 about the model, or a message that says so", () => {
    expect(modelRefused({ status: 404, message: "Not Found" })).toBe(true);
    expect(modelRefused({ status: 400, message: "Invalid model name" })).toBe(true);
    expect(modelRefused({ status: 403, message: "Permission denied on publisher model" })).toBe(true);
    expect(modelRefused({ message: "Publisher Model `projects/p/locations/global/publishers/google/models/gemini-4-hydrogen` was not found" })).toBe(true);
    expect(modelRefused({ status: 400, message: "enum[0]: cannot be empty" })).toBe(false);
    expect(modelRefused({ status: 401, message: "invalid_grant: reauth related error" })).toBe(false);
    expect(modelRefused({ message: "socket hang up" })).toBe(false);
  });
  it("names the model, the step and the setting that chooses it when the model was refused", () => {
    const m = callFailureMessage({ status: 404, message: "Publisher Model was not found or your project does not have access to it." }, at);
    expect(m.startsWith('The model "gemini-4-hydrogen" was refused by Vertex in the second look step (role read: set COMPETITORS_MODEL_READ to a model this project can use)')).toBe(true);
    expect(m).toContain("Publisher Model was not found");
  });
  it("any other failure still names the step and the model, and is not called a refused model", () => {
    const m = callFailureMessage({ status: 401, message: "invalid_grant: reauth related error (invalid_rapt)" }, { step: "map", role: "read", model: "gemini-4-hydrogen" });
    expect(m).toBe("PMOS AI call failed in the map step (model gemini-4-hydrogen, role read) — invalid_grant: reauth related error (invalid_rapt)");
  });
  it("fits what the run stores, with the step and the model inside", () => {
    const m = callFailureMessage({ status: 404, message: "x".repeat(2000) }, { step: "domains", role: "judge", model: "gemini-4-carbon" });
    expect(m.length).toBe(300);
    expect(m).toContain('"gemini-4-carbon"');
    expect(m).toContain("domains step");
    expect(m).toContain("COMPETITORS_MODEL_JUDGE");
  });
});
