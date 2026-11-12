/** Capability Analysis — pacing and the resume state machine (analysis/pacing.ts). Pure module: fake clock, fake work. */
import { describe, expect, it } from "vitest";
import { AnswerError, asCapacityError, CapacityError, EndpointError, isNetworkError, TransientError } from "@/lib/competitors/ai";
import { ReadingBudget } from "@/lib/competitors/analysis/budget";
import { backoffMs, estimateTokens, runPaced, TokenBudget, type PacedOptions } from "@/lib/competitors/analysis/pacing";

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

describe("TokenBudget", () => {
  it("lets requests through while they fit in the last minute", async () => {
    const c = fakeClock();
    const b = new TokenBudget(1000, c.now);
    await b.reserve(400, c.sleep);
    await b.reserve(600, c.sleep);
    expect(c.slept).toEqual([]);
  });
  it("waits exactly until the window frees", async () => {
    const c = fakeClock();
    const b = new TokenBudget(1000, c.now);
    await b.reserve(600, c.sleep);
    c.advance(10_000);
    await b.reserve(600, c.sleep);
    expect(c.slept).toEqual([50_000]);
    expect(c.now()).toBe(60_000);
  });
  it("a request larger than the whole budget goes alone, when the window is empty", async () => {
    const c = fakeClock();
    const b = new TokenBudget(1000, c.now);
    await b.reserve(5000, c.sleep);
    expect(c.slept).toEqual([]);
    await b.reserve(5000, c.sleep);
    expect(c.slept).toEqual([60_000]);
  });
  it("settle replaces the estimate with what the call used", async () => {
    const c = fakeClock();
    const b = new TokenBudget(1000, c.now);
    const h = await b.reserve(900, c.sleep);
    b.settle(h, 100);
    await b.reserve(800, c.sleep);
    expect(c.slept).toEqual([]);
  });
  it("estimates 4 characters per token", () => {
    expect(estimateTokens(4001)).toBe(1001);
  });
});

describe("backoffMs", () => {
  it("60 s, 2 min, 4 min, 8 min, then 15 min", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((a) => backoffMs(a, null))).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });
  it("never less than the server's retry-after", () => {
    expect(backoffMs(1, 300_000)).toBe(300_000);
    expect(backoffMs(3, 1000)).toBe(240_000);
  });
  it("a shorter base (test knob) scales the whole sequence", () => {
    expect([1, 2, 5].map((a) => backoffMs(a, null, 10))).toEqual([10, 20, 150]);
  });
});

/** A fake store and a fake model: `fail(item, callNo)` says how the n-th call for an item ends. */
function harness(items: string[], fail: (item: string, call: number) => Error | null = () => null, opts: Partial<PacedOptions<string>> = {}) {
  const c = fakeClock();
  const saved: string[] = [];
  const started: string[] = [];
  const calls = new Map<string, number>();
  const events: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const options: PacedOptions<string> = {
    items,
    concurrency: 1,
    estimate: () => 10,
    work: async (item) => {
      started.push(item);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // The answer comes later than the start of the next items.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inflight--;
      const n = (calls.get(item) ?? 0) + 1;
      calls.set(item, n);
      const e = fail(item, n);
      if (e) throw e;
      saved.push(item);
      return 10;
    },
    budget: new TokenBudget(1_000_000, c.now),
    sleep: c.sleep,
    onWait: async (ms, attempt, cause) => { events.push(`wait ${ms} #${attempt}${cause.transient ? " endpoint" : ""}`); },
    onResume: async () => { events.push("resume"); },
    maxWaitMs: 24 * 3600_000,
    ...opts,
  };
  return { c, saved, started, calls, events, options, maxInflight: () => maxInflight };
}

describe("runPaced", () => {
  const ITEMS = ["a", "b", "c", "d", "e", "f"];

  it("works the to-do in order, one at a time", async () => {
    const h = harness(ITEMS);
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(ITEMS);
    expect(h.maxInflight()).toBe(1);
    expect(r).toEqual({ done: 6, failed: 0, waits: 0, waitedMs: 0, stopped: false, left: 0 });
  });
  it("starts items in order with 4 in flight, never more", async () => {
    const h = harness(ITEMS, () => null, { concurrency: 4 });
    await runPaced(h.options);
    expect(h.started).toEqual(ITEMS);
    expect(h.maxInflight()).toBe(4);
    expect([...h.saved].sort()).toEqual(ITEMS);
  });
  it("a capacity answer at item k: the items before it are saved once; the loop waits, resumes, and does k and the rest", async () => {
    const h = harness(ITEMS, (item, n) => (item === "c" && n === 1 ? new CapacityError("429") : null));
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(ITEMS);
    expect(h.events).toEqual(["wait 60000 #1", "resume"]);
    expect(h.calls.get("a")).toBe(1);
    expect(h.calls.get("b")).toBe(1);
    expect(h.calls.get("c")).toBe(2);
    expect(r).toMatchObject({ done: 6, waits: 1, waitedMs: 60_000 });
  });
  it("with calls in flight: those that got through are saved, those refused go back to the front in their order", async () => {
    const h = harness(ITEMS, (item, n) => ((item === "b" || item === "c") && n === 1 ? new CapacityError("429") : null), { concurrency: 4 });
    await runPaced(h.options);
    // b and c were refused while a, d (and e, started when a ended) got through: after the wait b and c go first, in their order.
    expect(h.started).toEqual(["a", "b", "c", "d", "e", "b", "c", "f"]);
    expect(h.saved).toEqual(["a", "d", "e", "b", "c", "f"]);
    expect(h.events).toEqual(["wait 60000 #1", "resume"]);
    for (const i of ITEMS) expect(h.calls.get(i), i).toBe(i === "b" || i === "c" ? 2 : 1);
  });
  it("capacity answers in a row grow the wait; a success resets it; retry-after is honoured", async () => {
    const h = harness(ITEMS, (item, n) => {
      if (item === "b" && n <= 3) return new CapacityError("429");
      if (item === "e" && n === 1) return new CapacityError("503", 200_000);
      return null;
    });
    const r = await runPaced(h.options);
    expect(h.events).toEqual(["wait 60000 #1", "resume", "wait 120000 #2", "resume", "wait 240000 #3", "resume", "wait 200000 #1", "resume"]);
    expect(h.saved).toEqual(ITEMS);
    expect(r.waits).toBe(4);
    expect(r.waitedMs).toBe(620_000);
  });
  it("gives up once the waiting in all would pass the limit", async () => {
    const h = harness(ITEMS, (item) => (item === "b" ? new CapacityError("429") : null), { maxWaitMs: 200_000 });
    await expect(runPaced(h.options)).rejects.toBeInstanceOf(CapacityError);
    expect(h.saved).toEqual(["a"]);
    expect(h.events).toEqual(["wait 60000 #1", "resume", "wait 120000 #2", "resume"]);
  });
  it("a failing endpoint (500, 504, network) is waited out like a capacity answer and the loop continues from where it stopped", async () => {
    const h = harness(ITEMS, (item, n) => (item === "c" && n <= 2 ? new TransientError("500 Internal error") : null));
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(ITEMS);
    expect(h.events).toEqual(["wait 60000 #1 endpoint", "resume", "wait 120000 #2 endpoint", "resume"]);
    expect(h.calls.get("c")).toBe(3);
    expect(r).toMatchObject({ done: 6, waits: 2, waitedMs: 180_000 });
  });
  it("an endpoint that keeps failing ends the loop with a clear error after 6 waits in a row — it never waits forever", async () => {
    const h = harness(ITEMS, (item) => (item === "b" ? new TransientError("fetch failed") : null));
    const run = runPaced(h.options);
    await expect(run).rejects.toBeInstanceOf(EndpointError);
    await expect(run).rejects.toThrow(/did not answer 7 times in a row.*fetch failed/);
    expect(h.saved).toEqual(["a"]);
    expect(h.calls.get("b")).toBe(7);
    // 1 + 2 + 4 + 8 + 15 + 15 minutes.
    expect(h.events.filter((e) => e.startsWith("wait")).map((e) => e.split(" ")[1])).toEqual(["60000", "120000", "240000", "480000", "900000", "900000"]);
  });
  it("the ceiling counts failures in a row: a call that gets through, or a real capacity answer, starts the count again", async () => {
    // b fails 5 times, then works; c fails 5 times, then works: 10 waits in all, never 7 failures in a row.
    const h = harness(ITEMS, (item, n) => ((item === "b" || item === "c") && n <= 5 ? new TransientError("504") : null), { maxTransientWaits: 5 });
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(ITEMS);
    expect(r.waits).toBe(10);
    // Capacity answers have no such ceiling (only the 24 h in all).
    const k = harness(ITEMS, (item, n) => (item === "b" && n <= 9 ? new CapacityError("429") : null), { maxTransientWaits: 2 });
    await runPaced(k.options);
    expect(k.saved).toEqual(ITEMS);
    // A round with a real capacity answer in it is a capacity round.
    const m = harness(ITEMS, (item, n) => (n <= 4 && (item === "a" || item === "b") ? (item === "a" ? new TransientError("500") : new CapacityError("429")) : null), { concurrency: 2, maxTransientWaits: 2 });
    await runPaced(m.options);
    expect([...m.saved].sort()).toEqual(ITEMS);
    expect(m.events.filter((e) => e.endsWith("endpoint"))).toEqual([]);
  });
  it("an unusable answer with a handler is recorded and the loop goes on", async () => {
    const failedItems: string[] = [];
    const h = harness(ITEMS, (item) => (item === "c" ? new AnswerError("invalid JSON") : null), { onAnswerError: async (item) => { failedItems.push(item); } });
    const r = await runPaced(h.options);
    expect(failedItems).toEqual(["c"]);
    expect(h.saved).toEqual(["a", "b", "d", "e", "f"]);
    expect(r).toMatchObject({ done: 5, failed: 1 });
    expect(h.calls.get("c")).toBe(1);
  });
  it("an unusable answer without a handler stops the loop", async () => {
    const h = harness(ITEMS, (item) => (item === "c" ? new AnswerError("invalid JSON") : null));
    await expect(runPaced(h.options)).rejects.toBeInstanceOf(AnswerError);
    expect(h.saved).toEqual(["a", "b"]);
    expect(h.started).toEqual(["a", "b", "c"]);
  });
  it("any other error stops new items and lets the calls in flight finish", async () => {
    const h = harness(ITEMS, (item) => (item === "b" ? new Error("boom") : null), { concurrency: 3 });
    await expect(runPaced(h.options)).rejects.toThrow("boom");
    // d started when a ended, before b's error; nothing starts after the error.
    expect(h.started).toEqual(["a", "b", "c", "d"]);
    expect([...h.saved].sort()).toEqual(["a", "c", "d"]);
  });
  it("stops when asked: nothing new starts", async () => {
    let asked = 0;
    const h = harness(ITEMS, () => null, { shouldStop: async () => ++asked > 2 });
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(["a", "b"]);
    expect(r.stopped).toBe(true);
  });
  it("TOKEN BUDGET: when the next call would pass it nothing more starts; the rest of the to-do is counted as left", async () => {
    // 10 tokens per call, a budget of 35: three calls fit, the fourth would pass it.
    let used = 0;
    const gate = new ReadingBudget(35, () => used);
    const h = harness(ITEMS, () => null, { admit: () => gate.admit(10), release: () => gate.release(10) });
    const work = h.options.work;
    h.options.work = async (item) => {
      const tokens = await work(item);
      used += tokens;
      return tokens;
    };
    const r = await runPaced(h.options);
    expect(h.saved).toEqual(["a", "b", "c"]);
    expect(r).toMatchObject({ done: 3, left: 3, stopped: false });
    expect(gate.reached).toBe(true);
  });
  it("TOKEN BUDGET with calls in flight: their estimates count, the calls in flight finish, and every admitted call is released once", async () => {
    let used = 0;
    const gate = new ReadingBudget(25, () => used);
    const released: string[] = [];
    const h = harness(ITEMS, () => null, { concurrency: 4, admit: () => gate.admit(10), release: (item) => { released.push(item); gate.release(10); } });
    const r = await runPaced(h.options);
    // Nothing was counted as used yet when c asked: a + b in flight (20) + c (10) > 25.
    expect(h.started).toEqual(["a", "b"]);
    expect([...h.saved].sort()).toEqual(["a", "b"]);
    expect(r).toMatchObject({ done: 2, left: 4 });
    expect(released.sort()).toEqual(["a", "b"]);
  });
  it("TOKEN BUDGET: a later loop of the same run starts nothing at all", async () => {
    const gate = new ReadingBudget(5, () => 100);
    expect(gate.admit(1)).toBe(false);
    const h = harness(ITEMS, () => null, { admit: () => gate.admit(10), release: () => gate.release(10) });
    const r = await runPaced(h.options);
    expect(h.started).toEqual([]);
    expect(r).toMatchObject({ done: 0, left: 6 });
  });
  it("TOKEN BUDGET: an item that comes back after a capacity answer is asked again — and left when the budget was reached meanwhile", async () => {
    let used = 0;
    const gate = new ReadingBudget(15, () => used);
    const h = harness(["a", "b"], (item, call) => (item === "a" && call === 1 ? new CapacityError("no capacity") : null), { concurrency: 2, admit: () => gate.admit(5), release: () => gate.release(5) });
    const work = h.options.work;
    h.options.work = async (item) => {
      const tokens = await work(item);
      used += tokens;
      return tokens;
    };
    const r = await runPaced(h.options);
    // b got through and used 10 of the 15; a (5 more + the 10 used = 15) still fits when it comes back.
    expect([...h.saved].sort()).toEqual(["a", "b"]);
    expect(r).toMatchObject({ done: 2, left: 0, waits: 1 });
    const gate2 = new ReadingBudget(12, () => used2);
    let used2 = 0;
    const h2 = harness(["a", "b"], (item, call) => (item === "a" && call === 1 ? new CapacityError("no capacity") : null), { concurrency: 2, admit: () => gate2.admit(5), release: () => gate2.release(5) });
    const work2 = h2.options.work;
    h2.options.work = async (item) => {
      const tokens = await work2(item);
      used2 += tokens;
      return tokens;
    };
    const r2 = await runPaced(h2.options);
    expect(h2.saved).toEqual(["b"]);
    expect(r2).toMatchObject({ done: 1, left: 1, waits: 1 });
  });
  it("RESUME: after a failure, a second run on the to-do recomputed from the store works only what is left — nothing twice", async () => {
    const store = new Set<string>();
    const worked: string[] = [];
    const run = async (failOn: string | null) => {
      const todo = ITEMS.filter((i) => !store.has(i));
      const h = harness(todo, (item) => (item === failOn ? new Error("the process died") : null));
      h.options.work = async (item) => {
        if (item === failOn) throw new Error("the process died");
        worked.push(item);
        store.add(item);
        return 10;
      };
      return runPaced(h.options);
    };
    await expect(run("d")).rejects.toThrow("the process died");
    expect(worked).toEqual(["a", "b", "c"]);
    const r = await run(null);
    expect(worked).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(r.done).toBe(3);
  });
});

describe("asCapacityError — which provider errors the run waits out", () => {
  const http = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
  it("429, 503, 529 and RESOURCE_EXHAUSTED are capacity answers (no ceiling but the 24 h)", () => {
    for (const e of [http(429), http(503), http(529), new Error("RESOURCE_EXHAUSTED: quota")]) {
      const c = asCapacityError(e);
      expect(c).toBeInstanceOf(CapacityError);
      expect(c).not.toBeInstanceOf(TransientError);
    }
  });
  it("500, 502 and 504 are a failing endpoint: waited out, with a ceiling", () => {
    for (const status of [500, 502, 504]) expect(asCapacityError(http(status))).toBeInstanceOf(TransientError);
    // A TransientError is a CapacityError for every caller that only knows "wait and continue".
    expect(asCapacityError(http(500))).toBeInstanceOf(CapacityError);
  });
  it("network errors are a failing endpoint", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" }) });
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const sdk = new Error("Connection error.");
    const timeout = new Error("Request timed out.");
    for (const e of [fetchFailed, reset, sdk, timeout]) {
      expect(isNetworkError(e), e.message).toBe(true);
      expect(asCapacityError(e), e.message).toBeInstanceOf(TransientError);
    }
  });
  it("anything else is returned untouched and stops the run: a refused request, no permission, a bug", () => {
    const bad = http(400, "INVALID_ARGUMENT: schema");
    const denied = http(403, "PERMISSION_DENIED");
    const bug = new TypeError("cannot read properties of undefined");
    for (const e of [bad, denied, bug]) expect(asCapacityError(e)).toBe(e);
    // An error with an HTTP status is never a network error, whatever its text says.
    expect(isNetworkError(http(400, "timeout must be a number"))).toBe(false);
  });
  it("keeps the server's retry-after", () => {
    const e = Object.assign(new Error("HTTP 500"), { status: 500, headers: { "retry-after": "30" } });
    expect((asCapacityError(e) as TransientError).retryAfterMs).toBe(30_000);
  });
});
