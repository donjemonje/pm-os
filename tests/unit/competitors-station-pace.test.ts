import { describe, expect, it } from "vitest";
import { afterProbeAnswered, afterSlowDown, afterStuckPage, makeQueue, MAX_SLOWDOWN_WAIT_MS, retryAfterMs, sectionOf, slowedPause, SLOWDOWN_WAITS_MS } from "../../scripts/pmos-local-scan/pace.mjs";

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
  it("gives the page up at the fourth slow down in a row, and says the page had its waits", () => {
    expect(afterSlowDown({ inARow: 4, pauseMs: 20_000 })).toMatchObject({ stop: true, waited: true });
  });
  it("a site that asks for too long, or a station with no waits, gives up without having waited", () => {
    expect(afterSlowDown({ inARow: 1, retryAfter: MAX_SLOWDOWN_WAIT_MS + 1, pauseMs: 2_000 })).toMatchObject({ stop: true, waited: false });
    expect(afterSlowDown({ inARow: 1, pauseMs: 0, waits: [] })).toMatchObject({ stop: true, waited: false });
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
  it("a page that used up its waits goes to the very end, behind the known pages", () => {
    const q = start(["home", "a"], ["n1", "n2"]);
    expect(q.next()).toBe("home");
    const stuck = q.next();
    q.toEnd(stuck);
    expect(q.list()).toEqual(["n2", "a", "n1"]);
    expect(q.fresh).toBe(1);
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

/**
 * A whole section that answers "slow down" (found 2026-11-22 on a competitor's site: every page under one section
 * answered 429 every time, two of them stood one after the other, and four scans stopped there with 1,479 pages left).
 */
describe("sectionOf — the first part of a page's address path", () => {
  it("is the first path part, lower case; empty for the home page or a bad address", () => {
    expect(sectionOf("https://site.test/Advisories/19426")).toBe("advisories");
    expect(sectionOf("https://site.test/blog/a/b?x=1")).toBe("blog");
    expect(sectionOf("https://site.test/")).toBe("");
    expect(sectionOf("https://site.test")).toBe("");
    expect(sectionOf("not an address")).toBe("");
  });
});

describe("makeQueue — bringForward and moveToEnd", () => {
  const S = "https://site.test";
  it("bringForward puts the first accepted page first and keeps the front count true", () => {
    const q = makeQueue({ queue: [`${S}/a/1`, `${S}/a/2`, `${S}/b/1`, `${S}/c/1`], fresh: 2 });
    expect(q.bringForward((k) => sectionOf(k) !== "a")).toBe(`${S}/b/1`);
    expect(q.list()).toEqual([`${S}/b/1`, `${S}/a/1`, `${S}/a/2`, `${S}/c/1`]);
    // /b/1 came from the back part: the two new pages are still the front part behind it.
    expect(q.fresh).toBe(3);
    expect(q.next()).toBe(`${S}/b/1`);
    expect(q.fresh).toBe(2);
  });
  it("bringForward of a page that is already in the front part does not change the count", () => {
    const q = makeQueue({ queue: [`${S}/a/1`, `${S}/b/1`, `${S}/c/1`], fresh: 2 });
    expect(q.bringForward((k) => sectionOf(k) === "b")).toBe(`${S}/b/1`);
    expect(q.fresh).toBe(2);
  });
  it("bringForward answers undefined and changes nothing when no page is accepted", () => {
    const q = makeQueue({ queue: [`${S}/a/1`, `${S}/a/2`], fresh: 1 });
    expect(q.bringForward((k) => sectionOf(k) !== "a")).toBeUndefined();
    expect(q.list()).toEqual([`${S}/a/1`, `${S}/a/2`]);
    expect(q.fresh).toBe(1);
  });
  it("moveToEnd moves every accepted page to the end in their order and takes them out of the front count", () => {
    const q = makeQueue({ queue: [`${S}/a/1`, `${S}/b/1`, `${S}/a/2`, `${S}/c/1`, `${S}/a/3`], fresh: 3 });
    expect(q.moveToEnd((k) => sectionOf(k) === "a")).toBe(3);
    expect(q.list()).toEqual([`${S}/b/1`, `${S}/c/1`, `${S}/a/1`, `${S}/a/2`, `${S}/a/3`]);
    expect(q.fresh).toBe(1);
  });
});

describe("afterStuckPage / afterProbeAnswered — a section that keeps answering slow down", () => {
  const S = "https://site.test";
  const state = (pages: string[], fresh = 0) => ({ queue: makeQueue({ queue: pages, fresh }), moved: new Set<string>(), sentToEnd: new Set<string>() });

  it("after a stuck page the first page of ANOTHER section is tried, not the next page of the same section", () => {
    const st = state([`${S}/advisories/2`, `${S}/advisories/3`, `${S}/blog/1`, `${S}/blog/2`]);
    const r = afterStuckPage({ url: `${S}/advisories/1`, probe: null, ...st });
    expect(r).toEqual({ stop: false, probe: { section: "advisories", page: `${S}/advisories/1` }, next: `${S}/blog/1` });
    expect(st.queue.list()).toEqual([`${S}/blog/1`, `${S}/advisories/2`, `${S}/advisories/3`, `${S}/blog/2`, `${S}/advisories/1`]);
  });

  it("the page of the other section is answered: the stuck section goes to the end and the scan goes on", () => {
    const st = state([`${S}/advisories/2`, `${S}/advisories/3`, `${S}/blog/1`, `${S}/blog/2`], 2);
    const r = afterStuckPage({ url: `${S}/advisories/1`, probe: null, ...st });
    if (r.stop) throw new Error("expected the scan to go on");
    expect(st.queue.next()).toBe(`${S}/blog/1`);
    expect(afterProbeAnswered({ probe: r.probe, queue: st.queue, moved: st.moved })).toBe(3);
    expect(st.queue.list()).toEqual([`${S}/blog/2`, `${S}/advisories/2`, `${S}/advisories/3`, `${S}/advisories/1`]);
    expect([...st.moved]).toEqual(["advisories"]);
    expect(st.queue.fresh).toBe(0);
  });

  it("the page of the other section is stuck too: the site slows everything down, the scan stops", () => {
    const st = state([`${S}/advisories/2`, `${S}/blog/1`, `${S}/blog/2`]);
    const r = afterStuckPage({ url: `${S}/advisories/1`, probe: null, ...st });
    if (r.stop) throw new Error("expected the scan to go on");
    st.queue.next();
    const second = afterStuckPage({ url: `${S}/blog/1`, probe: r.probe, ...st });
    expect(second.stop).toBe(true);
    // Nothing was moved: the next scan starts from the same line.
    expect(st.moved.size).toBe(0);
  });

  it("when the line reaches the moved section again and a page of it is stuck again, the scan stops at once", () => {
    const st = state([`${S}/advisories/2`, `${S}/advisories/1`]);
    st.moved.add("advisories");
    const r = afterStuckPage({ url: `${S}/advisories/3`, probe: null, ...st });
    expect(r.stop).toBe(true);
    expect(st.queue.list()).toEqual([`${S}/advisories/2`, `${S}/advisories/1`]);
  });

  it("a second section can be tested later, and a page of an already moved section is never the test", () => {
    const st = state([`${S}/advisories/2`, `${S}/news/2`, `${S}/blog/1`]);
    st.moved.add("advisories");
    const r = afterStuckPage({ url: `${S}/news/1`, probe: null, ...st });
    expect(r).toMatchObject({ stop: false, next: `${S}/blog/1`, probe: { section: "news" } });
  });

  it("with no page of another section left, the next page in line is tried: once per page, and two in a row stop the scan", () => {
    const st = state([`${S}/hc/2`, `${S}/hc/3`]);
    const r = afterStuckPage({ url: `${S}/hc/1`, probe: null, ...st });
    expect(r).toEqual({ stop: false, probe: { section: null, page: `${S}/hc/1` }, next: `${S}/hc/2` });
    expect(st.queue.list()).toEqual([`${S}/hc/2`, `${S}/hc/3`, `${S}/hc/1`]);
    // The next page is answered: nothing is moved, the scan goes on.
    if (r.stop) throw new Error("expected the scan to go on");
    expect(afterProbeAnswered({ probe: r.probe, queue: st.queue, moved: st.moved })).toBe(0);
    expect(st.moved.size).toBe(0);
    // The same page stuck a second time ends the scan.
    st.queue.next();
    st.queue.next();
    st.queue.next();
    expect(afterStuckPage({ url: `${S}/hc/1`, probe: null, ...st }).stop).toBe(true);
    // And the next page stuck right after a stuck page ends it too.
    const st2 = state([`${S}/hc/2`, `${S}/hc/3`]);
    const first = afterStuckPage({ url: `${S}/hc/1`, probe: null, ...st2 });
    if (first.stop) throw new Error("expected the scan to go on");
    st2.queue.next();
    expect(afterStuckPage({ url: `${S}/hc/2`, probe: first.probe, ...st2 }).stop).toBe(true);
  });

  it("a stuck page that was the last page ends the scan", () => {
    const st = state([]);
    expect(afterStuckPage({ url: `${S}/a/1`, probe: null, ...st }).stop).toBe(true);
  });
});
