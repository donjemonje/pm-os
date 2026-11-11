/** Capability Analysis — what is due (analysis/todo.ts): a run keeps no cursor, the to-do is computed from state. Pure module. */
import { describe, expect, it } from "vitest";
import { factsBaselineSources, factsTodo, readKey, researchTodo, tooManyFailed } from "@/lib/competitors/analysis/todo";

describe("researchTodo", () => {
  const V = "research-1";
  const p = (url: string, hash: string, analyzedKey: string | null) => ({ url, hash, analyzedKey });
  it("a page read under the current version and hash is not due", () => {
    expect(researchTodo([p("/a", "h1", readKey(V, "h1"))], V)).toEqual([]);
  });
  it("a page never read, a page whose text moved and a page read under another prompt version are due — in address order", () => {
    const todo = researchTodo([p("/c", "h3", "research-0:h3"), p("/a", "h1", null), p("/d", "h4", readKey(V, "h4")), p("/b", "h2new", readKey(V, "h2old"))], V);
    expect(todo.map((x) => x.url)).toEqual(["/a", "/b", "/c"]);
  });
  it("a page whose answer was unusable carries the current key: it is not asked again until it changes", () => {
    const failed = { ...p("/a", "h1", readKey(V, "h1")), analysisError: "invalid JSON" };
    expect(researchTodo([failed], V)).toEqual([]);
    expect(researchTodo([{ ...failed, hash: "h2" }], V)).toHaveLength(1);
  });
});

describe("tooManyFailed", () => {
  it("more than max(5, 5% of the to-do) unusable answers fails the run", () => {
    expect(tooManyFailed(5, 40)).toBe(false);
    expect(tooManyFailed(6, 40)).toBe(true);
    expect(tooManyFailed(30, 600)).toBe(false);
    expect(tooManyFailed(31, 600)).toBe(true);
  });
});

describe("factsTodo / factsBaselineSources", () => {
  const V = "facts-1";
  const p = (url: string, extra: Partial<{ hash: string; factsKey: string | null; state: string; hasText: boolean }> = {}) => ({ url, hash: "h", factsKey: null as string | null, state: "present", hasText: true, ...extra });
  it("every stored page with text whose facts key is not current, any tier, in address order; removed and text-less pages never", () => {
    const todo = factsTodo([p("/z"), p("/blog/a"), p("/done", { factsKey: readKey(V, "h") }), p("/moved", { factsKey: readKey(V, "old") }), p("/gone", { state: "removed" }), p("/empty", { hasText: false })], V);
    expect(todo.map((x) => x.url)).toEqual(["/blog/a", "/moved", "/z"]);
  });
  it("a source with no page ever read for facts is a baseline source", () => {
    const pages = [{ sourceId: "s1", factsKey: "facts-1:h" }, { sourceId: "s1", factsKey: null }, { sourceId: "s2", factsKey: null }];
    expect(factsBaselineSources(["s1", "s2", "s3"], pages)).toEqual(["s2", "s3"]);
  });
});
