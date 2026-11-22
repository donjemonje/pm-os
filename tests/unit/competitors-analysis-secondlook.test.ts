/** Capability Analysis — the second look, in bulk (analysis/secondlook.ts): what decides that a row is asked again, and how a look that stopped continues. Pure module. The prompt and its parser are tested in competitors-analysis-prompts.test.ts. */
import { describe, expect, it } from "vitest";
import { LOOK_VERSION } from "@/lib/competitors/analysis/prompts";
import { chunksLeft, lookFingerprint, lookKey, readLookProgress } from "@/lib/competitors/analysis/secondlook";

const capability = { name: "Single Sign-On", description: "Signs users in through the company's identity provider.", aliases: ["SSO", "SAML login"] };
const domain = { name: "Security", description: "Protects accounts and data." };

describe("lookKey — the same question is not asked twice", () => {
  const key = lookKey(capability, domain, "gemini-4-argon");
  it("the same row, domain and model give the same key — whatever the order of its other names", () => {
    expect(lookKey({ ...capability, aliases: ["SAML login", "SSO"] }, domain, "gemini-4-argon")).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
  it("it changes with the row's name, description or other names, its domain's name or definition, and the model", () => {
    expect(lookKey({ ...capability, name: "SSO" }, domain, "gemini-4-argon")).not.toBe(key);
    expect(lookKey({ ...capability, description: "Other." }, domain, "gemini-4-argon")).not.toBe(key);
    expect(lookKey({ ...capability, aliases: ["SSO"] }, domain, "gemini-4-argon")).not.toBe(key);
    expect(lookKey(capability, { ...domain, name: "Trust" }, "gemini-4-argon")).not.toBe(key);
    expect(lookKey(capability, { ...domain, description: "Other." }, "gemini-4-argon")).not.toBe(key);
    expect(lookKey(capability, domain, "gemini-4-carbon")).not.toBe(key);
  });
  it("it does not carry the company's pages: a page that is new or changed is read by the reading step, not by asking every row again", () => {
    expect(lookKey.length).toBe(3);
    expect(LOOK_VERSION).toBe("look-3");
  });
});

describe("a look that stopped half-way continues after the chunks it asked — when it is the same look", () => {
  const fingerprint = lookFingerprint(["gemini-4-argon"], ["chunk-a", "chunk-b", "chunk-c"]);
  it("the fingerprint is the chunks in their order (their pages and texts): a changed or reordered chunk is another look", () => {
    expect(lookFingerprint(["gemini-4-argon"], ["chunk-a", "chunk-b", "chunk-c"])).toBe(fingerprint);
    expect(lookFingerprint(["gemini-4-argon"], ["chunk-a", "chunk-b", "chunk-x"])).not.toBe(fingerprint);
    expect(lookFingerprint(["gemini-4-argon"], ["chunk-b", "chunk-a", "chunk-c"])).not.toBe(fingerprint);
    expect(lookFingerprint(["gemini-4-carbon"], ["chunk-a", "chunk-b", "chunk-c"])).not.toBe(fingerprint);
  });
  it("the same look goes on after the chunks it asked", () => {
    expect(chunksLeft(3, { fingerprint, done: 2 }, fingerprint)).toEqual({ from: 2, left: 1 });
    expect(chunksLeft(3, { fingerprint, done: 3 }, fingerprint)).toEqual({ from: 3, left: 0 });
    expect(chunksLeft(3, { fingerprint, done: 9 }, fingerprint)).toEqual({ from: 3, left: 0 });
  });
  it("another look — other chunks, or no saved progress — starts from the first chunk", () => {
    expect(chunksLeft(3, { fingerprint: "other", done: 2 }, fingerprint)).toEqual({ from: 0, left: 3 });
    expect(chunksLeft(3, null, fingerprint)).toEqual({ from: 0, left: 3 });
  });
  it("the cursor's record is read field by field; anything that is not one is no progress", () => {
    expect(readLookProgress({ fingerprint, done: 2, rows: ["k1"] })).toEqual({ fingerprint, done: 2 });
    for (const bad of [null, undefined, "x", [], { fingerprint: "", done: 1 }, { fingerprint, done: -1 }, { fingerprint, done: 1.5 }, { done: 2 }]) expect(readLookProgress(bad)).toBeNull();
  });
});
