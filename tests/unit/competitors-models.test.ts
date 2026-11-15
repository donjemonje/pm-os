/** Capability Analysis — a model per step (lib/competitors/models.ts): role → model with and without overrides, and what a refused model says. Pure module. */
import { describe, expect, it } from "vitest";
import { callFailureMessage, competitorsModels, MODEL_DEFAULTS, MODEL_ENV, modelFor, modelOfPrompt, modelRefused, modelsLine, PROMPT_ROLES, providerOf } from "@/lib/competitors/models";

describe("role → model", () => {
  it("the defaults are the Gemini 4 line-up: read = hydrogen, match = argon, judge = carbon", () => {
    expect(competitorsModels({})).toEqual({ read: "gemini-4-hydrogen", match: "gemini-4-argon", judge: "gemini-4-carbon" });
    expect(MODEL_DEFAULTS).toEqual({ read: "gemini-4-hydrogen", match: "gemini-4-argon", judge: "gemini-4-carbon" });
  });
  it("each role has its own override", () => {
    expect(MODEL_ENV).toEqual({ read: "COMPETITORS_MODEL_READ", match: "COMPETITORS_MODEL_MATCH", judge: "COMPETITORS_MODEL_JUDGE" });
    expect(modelFor("read", { COMPETITORS_MODEL_READ: "gemini-4-neon" })).toBe("gemini-4-neon");
    expect(competitorsModels({ COMPETITORS_MODEL_MATCH: " claude-x " })).toEqual({ read: "gemini-4-hydrogen", match: "claude-x", judge: "gemini-4-carbon" });
    expect(competitorsModels({ COMPETITORS_MODEL_READ: "a", COMPETITORS_MODEL_MATCH: "b", COMPETITORS_MODEL_JUDGE: "c" })).toEqual({ read: "a", match: "b", judge: "c" });
  });
  it("a blank override is no override", () => {
    expect(modelFor("judge", { COMPETITORS_MODEL_JUDGE: "   " })).toBe("gemini-4-carbon");
    expect(modelFor("judge", { COMPETITORS_MODEL_JUDGE: "" })).toBe("gemini-4-carbon");
  });
  it("the old single COMPETITORS_MODEL forces nothing: with it set to argon, read and judge keep their own models", () => {
    expect(competitorsModels({ COMPETITORS_MODEL: "gemini-4-argon" })).toEqual({ read: "gemini-4-hydrogen", match: "gemini-4-argon", judge: "gemini-4-carbon" });
    expect(competitorsModels({ COMPETITORS_MODEL: "something-else" })).toEqual(competitorsModels({}));
  });
  it("every prompt has its role: read for map, research, second look, facts and the pick of a company's other addresses; match for merge, unify and match; judge for the unify review and the domains", () => {
    expect(PROMPT_ROLES).toEqual({ map: "read", research: "read", merge: "match", unify: "match", unify_review: "judge", domains: "judge", match: "match", second_look: "read", facts: "read", addresses: "read" });
    expect(modelOfPrompt("research", {})).toBe("gemini-4-hydrogen");
    expect(modelOfPrompt("unify", {})).toBe("gemini-4-argon");
    expect(modelOfPrompt("domains", { COMPETITORS_MODEL_JUDGE: "gemini-4-xenon" })).toBe("gemini-4-xenon");
  });
  it("a run names all three", () => {
    expect(modelsLine(competitorsModels({}))).toBe("read gemini-4-hydrogen · match gemini-4-argon · judge gemini-4-carbon");
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
