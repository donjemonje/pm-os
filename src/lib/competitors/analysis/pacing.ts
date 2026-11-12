import { AnswerError, CapacityError, EndpointError, TransientError } from "../ai";

/**
 * Pacing of an analysis run (Capability Analysis, "How the analysis runs"): calls stay under the model's
 * tokens-per-minute limit, and a "no capacity" answer makes the step wait and continue from where it stopped.
 *
 * Nothing here is a retry in the "try again and hope" sense: an item is worked again only after a capacity answer
 * (or a passing failure of the endpoint: HTTP 500, 502, 504, a network error — waited out the same way), and only
 * because it is still on the to-do. An unusable answer is recorded and skipped (when the step says how); anything
 * else stops the loop. Both kinds of waiting end: capacity after 24 h in all, a failing endpoint after 6 waits in a row.
 *
 * Pure: the clock, the sleep and the work are handed in.
 */

/** Tokens per minute (input + output) one run may use. Env COMPETITORS_ANALYSIS_TPM on the job. */
export const ANALYSIS_TPM = 200_000;
/** Research and second-look calls in flight at once. Env COMPETITORS_ANALYSIS_CONCURRENCY on the job. */
export const ANALYSIS_CONCURRENCY = 4;
/** A run that waited this long in total for capacity fails. */
export const MAX_WAIT_MS = 24 * 3600_000;
/** Added to every estimate for the answer. */
export const OUTPUT_RESERVE = 2_000;
/** The first wait after a capacity answer. */
export const BASE_WAIT_MS = 60_000;
/**
 * Waits in a row after a failing endpoint (500, 502, 504, network) with no call getting through in between. The
 * next failure ends the run: 1 + 2 + 4 + 8 + 15 + 15 = 45 minutes of a broken endpoint is not a blip.
 */
export const MAX_TRANSIENT_WAITS = 6;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
}
export function analysisTpm(): number {
  return positiveInt(process.env.COMPETITORS_ANALYSIS_TPM, ANALYSIS_TPM);
}
export function analysisConcurrency(): number {
  return Math.min(32, positiveInt(process.env.COMPETITORS_ANALYSIS_CONCURRENCY, ANALYSIS_CONCURRENCY));
}
/** TEST KNOB (COMPETITORS_TEST_KNOBS=on only): COMPETITORS_ANALYSIS_WAIT_MS shortens the wait after a capacity answer. */
export function analysisBaseWaitMs(): number {
  const knobs = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  if (knobs !== "on" && knobs !== "true" && knobs !== "1") return BASE_WAIT_MS;
  return positiveInt(process.env.COMPETITORS_ANALYSIS_WAIT_MS, BASE_WAIT_MS);
}

const WINDOW_MS = 60_000;

/** A sliding one-minute window of tokens. One per run, shared by all its steps. */
export class TokenBudget {
  private readonly limit: number;
  private readonly now: () => number;
  private entries: Array<{ id: number; at: number; tokens: number }> = [];
  private nextId = 1;

  constructor(tokensPerMinute: number, now: () => number = Date.now) {
    this.limit = tokensPerMinute;
    this.now = now;
  }

  /**
   * Waits (through `sleep`) until the tokens fit in the last 60 s, then records them. A single request larger than
   * the whole budget is let through when the window is empty. Returns a handle for settle().
   */
  async reserve(tokens: number, sleep: (ms: number) => Promise<void>): Promise<number> {
    for (;;) {
      const t = this.now();
      this.entries = this.entries.filter((e) => t - e.at < WINDOW_MS);
      const used = this.entries.reduce((n, e) => n + e.tokens, 0);
      if (this.entries.length === 0 || used + tokens <= this.limit) {
        const id = this.nextId++;
        this.entries.push({ id, at: t, tokens });
        return id;
      }
      // Until the oldest entry leaves the window; then look again.
      await sleep(Math.max(1, this.entries[0].at + WINDOW_MS - t));
    }
  }

  /** Replace the estimate with what the call really used. */
  settle(handle: number, actualTokens: number): void {
    const e = this.entries.find((x) => x.id === handle);
    if (e) e.tokens = Math.max(0, actualTokens);
  }
}

/** 60 s, 2 min, 4 min, 8 min, then 15 min; never less than the server's retry-after. `attempt` starts at 1. */
export function backoffMs(attempt: number, retryAfterMs: number | null, baseMs: number = BASE_WAIT_MS): number {
  const step = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), baseMs * 15);
  return Math.max(step, retryAfterMs ?? 0);
}

export interface PacedOptions<T> {
  /** The to-do, in its order. */
  items: T[];
  concurrency: number;
  /** Tokens, before the call. */
  estimate: (item: T) => number;
  /** Makes the call AND saves its result; returns the tokens it used. */
  work: (item: T) => Promise<number>;
  budget: TokenBudget;
  sleep: (ms: number) => Promise<void>;
  /** A capacity answer (or a failing endpoint: `cause.transient`): the loop is about to sleep `ms`. */
  onWait: (ms: number, attempt: number, cause: { transient: boolean; message: string }) => Promise<void>;
  onResume: () => Promise<void>;
  /** An unusable answer for one item: record it and go on. Without it an AnswerError stops the loop. */
  onAnswerError?: (item: T, e: AnswerError) => Promise<void>;
  /** Asked before each new item; true ends the loop once the calls in flight are done. */
  shouldStop?: () => Promise<boolean>;
  /**
   * The run's token budget (budget.ts ReadingBudget), asked before each new item starts. False = this item and every
   * item still on the to-do are not started: the loop returns once the calls in flight are done, with `left` = the
   * items it did not work. `release` is called once for every admitted item — when its call ended, however it
   * ended, or when it was put back without starting.
   */
  admit?: (item: T) => boolean;
  release?: (item: T) => void;
  /** All waiting together; past it the loop throws CapacityError. */
  maxWaitMs: number;
  baseWaitMs?: number;
  /** Waits in a row for a failing endpoint; past it the loop throws EndpointError. Default MAX_TRANSIENT_WAITS. */
  maxTransientWaits?: number;
}

export interface PacedResult {
  done: number;
  failed: number;
  waits: number;
  waitedMs: number;
  stopped: boolean;
  /** Items not worked because `admit` said no (the token budget). */
  left: number;
}

/**
 * The one loop every step uses.
 *
 * 1. Items start in order, at most `concurrency` in flight, each after budget.reserve(estimate(item)).
 * 2. work succeeds → the item is done; the count of capacity answers in a row goes back to 0.
 * 3. work throws CapacityError → no new item starts; the calls in flight are left to finish; every item that got a
 *    capacity answer goes back to the front of the to-do in its original order; then onWait, sleep, onResume, and on.
 *    A TransientError (the endpoint failed: 500, 502, 504, network) is waited out the same way, with a ceiling: when
 *    every refusal of a round was transient and no call got through since the last such round, the round counts;
 *    after `maxTransientWaits` such waits in a row the next one throws EndpointError instead of waiting.
 * 4. work throws AnswerError → with onAnswerError: called, the item counts as failed, the loop goes on; without: as 5.
 * 5. work throws anything else → no new item starts, calls in flight finish, the first such error is rethrown.
 * 6. shouldStop() true → calls in flight finish, the loop returns stopped.
 * 7. admit(item) false → that item and the rest of the to-do are dropped from this loop and counted in `left`; calls
 *    in flight finish. An item that comes back after a capacity answer is asked again, and dropped the same way.
 */
export async function runPaced<T>(o: PacedOptions<T>): Promise<PacedResult> {
  const queue: Array<{ index: number; item: T }> = o.items.map((item, index) => ({ index, item }));
  const result: PacedResult = { done: 0, failed: 0, waits: 0, waitedMs: 0, stopped: false, left: 0 };
  const inflight = new Set<Promise<void>>();
  let attempt = 0;
  let transientWaits = 0;
  type Hit = { entries: Array<{ index: number; item: T }>; retryAfterMs: number | null; transient: boolean; message: string };
  let capacity: Hit | null = null;
  let fatal: { error: unknown } | null = null;
  const halted = () => capacity !== null || fatal !== null || result.stopped;

  const run = async (entry: { index: number; item: T }, handle: number): Promise<void> => {
    try {
      const used = await o.work(entry.item);
      o.budget.settle(handle, used);
      result.done++;
      attempt = 0;
      transientWaits = 0;
    } catch (e) {
      if (e instanceof CapacityError) {
        // The request was refused: it used nothing.
        o.budget.settle(handle, 0);
        capacity ??= { entries: [], retryAfterMs: null, transient: true, message: e.message };
        capacity.entries.push(entry);
        // A round is a failing endpoint only when every refusal in it was one; a real capacity answer makes it a capacity round.
        if (!(e instanceof TransientError)) {
          if (capacity.transient) capacity.message = e.message;
          capacity.transient = false;
        }
        if (e.retryAfterMs != null) capacity.retryAfterMs = Math.max(capacity.retryAfterMs ?? 0, e.retryAfterMs);
      } else if (e instanceof AnswerError && o.onAnswerError) {
        try {
          await o.onAnswerError(entry.item, e);
          result.failed++;
        } catch (inner) {
          fatal ??= { error: inner };
        }
      } else {
        fatal ??= { error: e };
      }
    }
  };

  for (;;) {
    while (!halted() && queue.length > 0 && inflight.size < Math.max(1, o.concurrency)) {
      if (o.shouldStop && (await o.shouldStop())) {
        result.stopped = true;
        break;
      }
      if (o.admit && !o.admit(queue[0].item)) {
        // The token budget: nothing more starts. What is on the to-do stays due for the next run.
        result.left += queue.length;
        queue.length = 0;
        break;
      }
      const entry = queue.shift()!;
      const handle = await o.budget.reserve(o.estimate(entry.item), o.sleep);
      if (halted()) {
        // A call in flight ended badly while this one waited for its tokens: it does not start.
        o.budget.settle(handle, 0);
        o.release?.(entry.item);
        queue.unshift(entry);
        break;
      }
      const p: Promise<void> = run(entry, handle).finally(() => {
        o.release?.(entry.item);
        inflight.delete(p);
      });
      inflight.add(p);
    }
    if (inflight.size > 0) {
      await Promise.race(inflight);
      if (!halted()) continue;
      await Promise.all(inflight);
    }
    if (fatal) throw (fatal as { error: unknown }).error;
    if (capacity) {
      const hit: Hit = capacity;
      capacity = null;
      queue.unshift(...hit.entries.sort((a, b) => a.index - b.index));
      attempt++;
      if (hit.transient) {
        if (transientWaits >= (o.maxTransientWaits ?? MAX_TRANSIENT_WAITS)) {
          throw new EndpointError(`PMOS AI did not answer ${transientWaits + 1} times in a row, with ${transientWaits} wait${transientWaits === 1 ? "" : "s"} in between — giving up. Last error: ${hit.message}`.slice(0, 300));
        }
        transientWaits++;
      } else {
        transientWaits = 0;
      }
      const ms = backoffMs(attempt, hit.retryAfterMs, o.baseWaitMs);
      if (result.waitedMs + ms > o.maxWaitMs) throw new CapacityError(`PMOS AI had no capacity for ${Math.round(result.waitedMs / 60_000)} min in all — giving up`, hit.retryAfterMs);
      result.waits++;
      await o.onWait(ms, attempt, { transient: hit.transient, message: hit.message });
      await o.sleep(ms);
      result.waitedMs += ms;
      await o.onResume();
      continue;
    }
    if (result.stopped || queue.length === 0) return result;
  }
}
