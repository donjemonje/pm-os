import { describe, expect, it } from "vitest";
import { afterSlowDown, makeQueue, MAX_SLOWDOWN_WAIT_MS, retryAfterMs, slowedPause, SLOWDOWN_WAITS_MS } from "../../scripts/pmos-local-scan/pace.mjs";

/**
 * The pace of one scan of the local station and the order of its pages (Daniel 2026-11-21, found on KELA's own site:
 * "slow down" after about 25 requests a minute, one new page per scan, 861 waiting). The rules live in
 * scripts/pmos-local-scan/pace.mjs; the poller only calls them.
 */

describe("retryAfterMs — what the site asked for", () => {
  it("reads seconds", () => {
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs(" 0 ")).toBe(0);
  });
  it("reads an HTTP date as the time left, never negative", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(retryAfterMs("Sat, 21 Nov 2026 10:02:00 GMT", now)).toBe(120_000);
    expect(retryAfterMs("Sat, 21 Nov 2026 09:00:00 GMT", now)).toBe(0);
  });
  it("is null when the header is missing or unreadable", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("")).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("slowedPause — the pause between pages after a slow down", () => {
  it("doubles the pause, to at least 5 seconds and at most 30", () => {
    expect(slowedPause(2_000)).toBe(5_000);
    expect(slowedPause(5_000)).toBe(10_000);
    expect(slowedPause(10_000)).toBe(20_000);
    expect(slowedPause(20_000)).toBe(30_000);
    expect(slowedPause(30_000)).toBe(30_000);
  });
  it("a pause of 0 (tests) stays 0", () => {
    expect(slowedPause(0)).toBe(0);
  });
});

describe("afterSlowDown — wait and go on, or stop", () => {
  it("waits 1, then 2, then 5 minutes on the same page, each time with a longer pause", () => {
    expect(afterSlowDown({ inARow: 1, pauseMs: 2_000 })).toEqual({ stop: false, waitMs: 60_000, pauseMs: 5_000 });
    expect(afterSlowDown({ inARow: 2, pauseMs: 5_000 })).toEqual({ stop: false, waitMs: 120_000, pauseMs: 10_000 });
    expect(afterSlowDown({ inARow: 3, pauseMs: 10_000 })).toEqual({ stop: false, waitMs: 300_000, pauseMs: 20_000 });
  });
  it("stops the scan at the fourth slow down in a row", () => {
    expect(afterSlowDown({ inARow: 4, pauseMs: 20_000 }).stop).toBe(true);
  });
  it("waits what the site asks when that is longer than the planned wait", () => {
    expect(afterSlowDown({ inARow: 1, retryAfter: 90_000, pauseMs: 2_000 })).toMatchObject({ stop: false, waitMs: 90_000 });
    expect(afterSlowDown({ inARow: 1, retryAfter: 10_000, pauseMs: 2_000 })).toMatchObject({ stop: false, waitMs: 60_000 });
  });
  it("stops now when the site asks for more than the longest wait: PM-OS would take the silent scan for a dead one", () => {
    expect(afterSlowDown({ inARow: 1, retryAfter: MAX_SLOWDOWN_WAIT_MS + 1, pauseMs: 2_000 }).stop).toBe(true);
    expect(afterSlowDown({ inARow: 1, retryAfter: MAX_SLOWDOWN_WAIT_MS, pauseMs: 2_000 })).toMatchObject({ stop: false, waitMs: MAX_SLOWDOWN_WAIT_MS });
  });
  it("no wait is longer than 5 minutes, and the default waits stay under PM-OS's 10 minutes of silence", () => {
    for (const w of SLOWDOWN_WAITS_MS) expect(w).toBeLessThanOrEqual(MAX_SLOWDOWN_WAIT_MS);
    expect(MAX_SLOWDOWN_WAIT_MS).toBeLessThan(10 * 60_000);
  });
  it("test knob: no waits = stop at the first slow down, as the station did before; waits of 0 = the same tries without waiting", () => {
    expect(afterSlowDown({ inARow: 1, pauseMs: 0, waits: [] }).stop).toBe(true);
    expect(afterSlowDown({ inARow: 1, pauseMs: 0, waits: [0, 0, 0] })).toEqual({ stop: false, waitMs: 0, pauseMs: 0 });
    expect(afterSlowDown({ inARow: 4, pauseMs: 0, waits: [0, 0, 0] }).stop).toBe(true);
  });
});

describe("makeQueue — pages PM-OS has never read come first", () => {
  const start = (known: string[], discovered: string[]) => {
    const q = makeQueue({ known });
    q.putBack("home");
    for (const k of known) if (k !== "home") q.add(k);
    for (const k of discovered) if (k !== "home" && !known.includes(k)) q.add(k);
    return q;
  };
  it("the home page, then the new pages as discovered, then the pages PM-OS has", () => {
    const q = start(["home", "a", "b"], ["a", "n1", "b", "n2"]);
    expect(q.list()).toEqual(["home", "n1", "n2", "a", "b"]);
    expect(q.fresh).toBe(3);
  });
  it("KELA's case: 13 pages known, 861 waiting — the second page read is a new one", () => {
    const known = ["home", ...Array.from({ length: 12 }, (_, i) => `k${i}`)];
    const discovered = Array.from({ length: 861 }, (_, i) => `n${i}`);
    const q = start(known, discovered);
    expect(q.next()).toBe("home");
    expect(q.next()).toBe("n0");
    expect(q.length).toBe(872);
  });
  it("a new page found on the way goes before the known ones, after the new ones already waiting", () => {
    const q = makeQueue({ known: ["home", "a", "late"] });
    q.putBack("home");
    q.add("a");
    q.add("n1");
    expect(q.next()).toBe("home");
    q.add("n2");
    q.add("late");
    expect(q.list()).toEqual(["n1", "n2", "a", "late"]);
  });
  it("with nothing known every page is new and the order is the order of discovery", () => {
    const q = start([], ["x", "y"]);
    expect(q.list()).toEqual(["home", "x", "y"]);
  });
  it("a page that was not read goes back to be read first", () => {
    const q = start(["home", "a"], ["n1"]);
    const first = q.next();
    q.putBack(first);
    expect(q.first()).toBe("home");
    expect(q.next()).toBe("home");
    expect(q.next()).toBe("n1");
    expect(q.next()).toBe("a");
    expect(q.next()).toBeUndefined();
    expect(q.length).toBe(0);
  });
  it("a saved place keeps the front part: a scan that continues still reads new pages before known ones", () => {
    const q = start(["home", "a", "b"], ["n1", "n2"]);
    q.next();
    const saved = { queue: q.list(), fresh: q.fresh };
    const again = makeQueue({ ...saved, known: ["home", "a", "b"] });
    again.add("n3");
    expect(again.list()).toEqual(["n1", "n2", "n3", "a", "b"]);
  });
});
