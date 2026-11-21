/** Capability Analysis — what is due (analysis/todo.ts): a run keeps no cursor, the to-do is computed from state. Pure module. */
import { describe, expect, it } from "vitest";
import { readKey, rowsSince } from "@/lib/competitors/analysis/todo";

describe("readKey", () => {
  it("is the prompt version and the hash of the text that was read: a page whose text or whose prompt version moved has another key, so it is due", () => {
    expect(readKey("read-1", "h1")).toBe("read-1:h1");
    expect(readKey("read-1", "h2")).not.toBe(readKey("read-1", "h1"));
    expect(readKey("read-2", "h1")).not.toBe(readKey("read-1", "h1"));
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
