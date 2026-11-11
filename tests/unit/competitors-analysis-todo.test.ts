/** Capability Analysis — what is due (analysis/todo.ts): a run keeps no cursor, the to-do is computed from state. Pure module. */
import { describe, expect, it } from "vitest";
import { carriedFactsBaseline, factsBaseline, factsBaselineSources, factsTodo, readKey, researchTodo, rowsSince, tooManyFailed } from "@/lib/competitors/analysis/todo";

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

describe("the facts baseline is carried over from the competitor's last unfinished run", () => {
  const run = (status: string, baseline?: unknown) => ({ status, cursor: baseline === undefined ? {} : { factsBaselineSources: baseline } });
  it("no earlier run: nothing to carry", () => {
    expect(carriedFactsBaseline([])).toEqual([]);
  });
  it("the last run stopped inside the facts step: its baseline is handed on", () => {
    expect(carriedFactsBaseline([run("failed", ["s1", "s2"])])).toEqual(["s1", "s2"]);
    expect(carriedFactsBaseline([run("cancelled", ["s1"])])).toEqual(["s1"]);
  });
  it("runs that stopped before the facts step are stepped over, back to the one that decided a baseline", () => {
    expect(carriedFactsBaseline([run("queued"), run("failed"), run("failed", ["s1"]), run("failed", ["old"])])).toEqual(["s1"]);
  });
  it("a finished run ends the search: every page was read, nothing is a first read any more", () => {
    expect(carriedFactsBaseline([run("failed"), run("done", ["s1"]), run("failed", ["s0"])])).toEqual([]);
    expect(carriedFactsBaseline([run("done")])).toEqual([]);
  });
  it("a baseline that decided 'no source is a first read' is handed on as that", () => {
    expect(carriedFactsBaseline([run("failed", []), run("failed", ["s1"])])).toEqual([]);
  });
  it("a cursor that is not what it should be carries nothing", () => {
    expect(carriedFactsBaseline([{ status: "failed", cursor: null }, { status: "failed", cursor: "x" }, { status: "failed", cursor: { factsBaselineSources: ["s1", 7, null] } }])).toEqual(["s1"]);
  });
  it("THE BUG: run 1 failed mid-facts on a first-read source; in run 2 that source is still baseline, so its remaining facts are not news", () => {
    // After run 1: one page of s1 was read (it carries a key), one was not.
    const pages = [{ sourceId: "s1", factsKey: "facts-1:h" }, { sourceId: "s1", factsKey: null }];
    // Without the carry-over s1 is no longer a first read.
    expect(factsBaselineSources(["s1"], pages)).toEqual([]);
    // With it, it is.
    expect(factsBaseline(["s1"], pages, carriedFactsBaseline([run("failed", ["s1"])]))).toEqual(["s1"]);
  });
  it("sources never read are baseline as before; an inherited source that no longer exists is dropped; no source twice", () => {
    const pages = [{ sourceId: "s1", factsKey: "facts-1:h" }, { sourceId: "s2", factsKey: null }];
    expect(factsBaseline(["s1", "s2"], pages, ["s1", "s2", "gone"])).toEqual(["s2", "s1"]);
  });
});

describe("rowsSince — the rows a competitor's runs made that still need their follow-up runs", () => {
  const row = (id: string, at: string) => ({ id, createdAt: new Date(at) });
  const rows = [row("old", "2026-11-01T10:00:00Z"), row("new", "2026-11-11T10:05:00Z")];
  it("the competitor never finished a run: every row made from its items", () => {
    expect(rowsSince(rows, null).map((r) => r.id)).toEqual(["old", "new"]);
  });
  it("only the rows made after its last finished run — whichever run made them, also one that crashed or failed after making them", () => {
    expect(rowsSince(rows, new Date("2026-11-11T10:00:00Z")).map((r) => r.id)).toEqual(["new"]);
  });
  it("nothing made since: no follow-up", () => {
    expect(rowsSince(rows, new Date("2026-11-11T11:00:00Z"))).toEqual([]);
    expect(rowsSince([], null)).toEqual([]);
  });
});
