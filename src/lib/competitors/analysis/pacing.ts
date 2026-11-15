import { AnswerError, CapacityError, EndpointError, TransientError } from "../ai";

/**
 * Pacing of an analysis run (Capability Analysis, "How the analysis runs").
 *
 * A run paces itself from the provider's answers — no fixed brake (Daniel 2026-11-15: "work based on limits and not
 * just sporadic brakes like pick a number 4 or 200k per min"). Google gives this project no fixed per-minute quota
 * for the models the analysis uses: they are served from a shared pool that answers "no capacity" when it is busy.
 * So the run:
 *   - starts fast: PACE_START_SPEED calls at once;
 *   - speeds up while calls succeed: one more call at once after every full round of successes (Pacer);
 *   - slows down when the provider pushes back — a capacity or rate answer, or an endpoint that fails: half the
 *     speed, a wait (never less than the server's retry-after), and on from where it stopped;
 *   - records every pushback on the run: when, in which step, at what speed, the speed after, how long it waited.
 *
 * Two hard ceilings stay as safety nets only — the most calls at once (our own database is the limit there) and
 * the most tokens per minute. Both are generous, both are environment settings, and a run that is ever held back
 * by one records a cap hit (analysis/caps.ts) like any other limit.
 *
 * Nothing here is a retry in the "try again and hope" sense: an item is worked again only after a pushback, and
 * only because it is still on the to-do. An unusable answer is recorded and skipped (when the step says how);
 * anything else stops the loop. Both kinds of waiting end: capacity after 24 h in all, a failing endpoint after 6
 * waits in a row. A run that stopped continues from the tables: the speed it had learned is not needed for that —
 * it starts fast again.
 *
 * Pure: the clock, the sleep and the work are handed in.
 */

/** Calls in flight at once when a run starts. */
export const PACE_START_SPEED = 8;
/** SAFETY NET: the most calls in flight at once, whatever the provider allows — the run's own writes share one database pool. Env COMPETITORS_ANALYSIS_MAX_SPEED on the job. */
export const PACE_MAX_SPEED = 64;
/** The env ceiling itself is held to this: more calls at once than this would starve the run's own database writes. */
export const PACE_SPEED_LIMIT = 128;
/** SAFETY NET: tokens per minute (input + output) one run may use. Env COMPETITORS_ANALYSIS_TPM on the job. */
export const ANALYSIS_TPM = 4_000_000;
/** A run that waited this long in total for capacity fails. */
export const MAX_WAIT_MS = 24 * 3600_000;
/** Added to every estimate for the answer. */
export const OUTPUT_RESERVE = 2_000;
/** The first wait after a capacity or rate answer: short — the speed was halved already. It doubles with every pushback in a row. */
export const BASE_WAIT_MS = 5_000;
/** The first wait after a failing endpoint (500, 502, 504, network): a broken endpoint is not asked again in seconds. */
export const TRANSIENT_BASE_WAIT_MS = 60_000;
/** No single wait is longer than this — unless the server asks for more (retry-after). */
export const MAX_BACKOFF_MS = 15 * 60_000;
/**
 * Waits in a row after a failing endpoint (500, 502, 504, network) with no call getting through in between. The
 * next failure ends the run: 1 + 2 + 4 + 8 + 15 + 15 = 45 minutes of a broken endpoint is not a blip.
 */
export const MAX_TRANSIENT_WAITS = 6;
/** Pushbacks kept on the run with their details; older ones are counted only. */
export const PUSHBACKS_KEPT = 200;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
}
/** The tokens-per-minute ceiling of a run (a safety net: the default is generous). */
export function analysisTpm(env: Record<string, string | undefined> = process.env): number {
  return positiveInt(env.COMPETITORS_ANALYSIS_TPM, ANALYSIS_TPM);
}
/** The speed ceiling of a run: the most calls at once (a safety net: the default is generous). */
export function analysisMaxSpeed(env: Record<string, string | undefined> = process.env): number {
  return Math.min(PACE_SPEED_LIMIT, positiveInt(env.COMPETITORS_ANALYSIS_MAX_SPEED, PACE_MAX_SPEED));
}
/**
 * TEST KNOB (COMPETITORS_TEST_KNOBS=on only): COMPETITORS_ANALYSIS_WAIT_MS is the first wait after any pushback —
 * a capacity answer and a failing endpoint alike. Without the knob: BASE_WAIT_MS and TRANSIENT_BASE_WAIT_MS.
 */
export function analysisBaseWaitMs(kind: "capacity" | "endpoint" = "capacity"): number {
  const base = kind === "endpoint" ? TRANSIENT_BASE_WAIT_MS : BASE_WAIT_MS;
  const knobs = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  if (knobs !== "on" && knobs !== "true" && knobs !== "1") return base;
  return positiveInt(process.env.COMPETITORS_ANALYSIS_WAIT_MS, base);
}

// ————— The speed of a run —————

/**
 * How fast a run goes: the calls it has in flight at once. One per run, shared by all its steps (and, in a setup
 * run, by all its companies), so what one step learned about the provider holds for the next.
 *
 *   success()   a call succeeded. After `speed` successes in a row — one full round at this speed got through —
 *               the run goes one faster, up to the ceiling.
 *   pushback()  the provider pushed back. Half the speed, never below 1; the round starts again.
 *
 * `ceilingHit` says the run wanted to go faster than the ceiling allows — a cap hit (caps.ts "speed_ceiling").
 */
export class Pacer {
  readonly start: number;
  readonly max: number;
  speed: number;
  /** The fastest the run went. */
  peak: number;
  ceilingHit = false;
  private streak = 0;

  constructor(start: number = PACE_START_SPEED, max: number = PACE_MAX_SPEED) {
    this.max = Math.max(1, Math.floor(max));
    this.start = Math.min(this.max, Math.max(1, Math.floor(start)));
    this.speed = this.start;
    this.peak = this.start;
  }

  success(): void {
    this.streak++;
    if (this.streak < this.speed) return;
    this.streak = 0;
    if (this.speed >= this.max) {
      this.ceilingHit = true;
      return;
    }
    this.speed++;
    this.peak = Math.max(this.peak, this.speed);
  }

  pushback(): { from: number; to: number } {
    const from = this.speed;
    this.speed = Math.max(1, Math.floor(this.speed / 2));
    this.streak = 0;
    return { from, to: this.speed };
  }
}

/** One pushback, as the run records it. */
export interface Pushback {
  /** When (ISO). */
  at: string;
  /** The step that was running. */
  step: string;
  /** The company the calls were for; null = the run as a whole (a setup run's unify and domains). */
  company: string | null;
  /** "capacity" = the provider said it has no capacity or asked to slow down; "endpoint" = it failed (500, 502, 504, network). */
  reason: "capacity" | "endpoint";
  /** Calls at once when it happened, and after it. */
  speed: number;
  next: number;
  /** How long the run waited before it went on. */
  waitMs: number;
  /** What the server asked for, when it did. */
  retryAfterMs: number | null;
}

/** The pacing of a run (CompetitorAnalysis.pacing): where it started, its ceiling, how fast it got, and every pushback. */
export interface PacingRecord {
  /** Calls at once at the start of the (last) walk, and the ceiling. */
  start: number;
  max: number;
  /** The fastest the run went, and its speed when this was written. */
  peak: number;
  speed: number;
  /** The last PUSHBACKS_KEPT pushbacks, oldest first. */
  pushbacks: Pushback[];
  /** Every pushback of the run, also the ones no longer kept. */
  total: number;
}

export function emptyPacing(pacer: Pick<Pacer, "start" | "max" | "speed" | "peak">): PacingRecord {
  return { start: pacer.start, max: pacer.max, peak: pacer.peak, speed: pacer.speed, pushbacks: [], total: 0 };
}

/** One more pushback on the record (changed in place): the newest PUSHBACKS_KEPT are kept, all are counted. */
export function recordPushback(record: PacingRecord, p: Pushback): void {
  record.pushbacks.push(p);
  if (record.pushbacks.length > PUSHBACKS_KEPT) record.pushbacks.splice(0, record.pushbacks.length - PUSHBACKS_KEPT);
  record.total++;
}

/** The stored record (a Json column), checked field by field; null for anything that is not one (a run from before pacing was recorded). */
export function readPacing(raw: unknown): PacingRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  if (!num(r.start) || !num(r.max)) return null;
  const pushbacks: Pushback[] = [];
  for (const p of Array.isArray(r.pushbacks) ? r.pushbacks : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.at !== "string" || typeof o.step !== "string") continue;
    pushbacks.push({
      at: o.at, step: o.step, company: typeof o.company === "string" && o.company ? o.company : null, reason: o.reason === "endpoint" ? "endpoint" : "capacity",
      speed: num(o.speed), next: num(o.next), waitMs: num(o.waitMs), retryAfterMs: typeof o.retryAfterMs === "number" && Number.isFinite(o.retryAfterMs) ? o.retryAfterMs : null,
    });
  }
  return { start: num(r.start), max: num(r.max), peak: num(r.peak) || num(r.start), speed: num(r.speed) || num(r.start), pushbacks, total: Math.max(num(r.total), pushbacks.length) };
}

/** A run's pacing as Administration shows it: the record, and its one line (written on the server — a screen never loads this module). */
export type PacingView = PacingRecord & { line: string };

export function pacingView(raw: unknown): PacingView | null {
  const record = readPacing(raw);
  return record ? { ...record, line: pacingLine(record) } : null;
}

/** "started at 8 calls at once, fastest 23, 2 pushbacks (waited 15 s in all)" — one line for the run log and Administration. */
export function pacingLine(r: PacingRecord): string {
  const waited = r.pushbacks.reduce((n, p) => n + p.waitMs, 0);
  const pushbacks = r.total === 0 ? "no pushback from the provider" : `${r.total} pushback${r.total === 1 ? "" : "s"} from the provider${waited ? ` (waited ${Math.round(waited / 1000)} s${r.total > r.pushbacks.length ? ` for the last ${r.pushbacks.length}` : " in all"})` : ""}`;
  return `started at ${r.start} call${r.start === 1 ? "" : "s"} at once, fastest ${r.peak}, ceiling ${r.max} — ${pushbacks}`;
}

const WINDOW_MS = 60_000;

/** A sliding one-minute window of tokens: the tokens-per-minute ceiling. One per run, shared by all its steps. */
export class TokenBudget {
  private readonly limit: number;
  private readonly now: () => number;
  private entries: Array<{ id: number; at: number; tokens: number }> = [];
  private nextId = 1;
  /** The limit as given: what a cap hit reports. */
  readonly tokensPerMinute: number;
  /** Calls the ceiling held back, and how long in all: the ceiling is a safety net, so the run records it when it ever binds. */
  holds = 0;
  heldMs = 0;

  constructor(tokensPerMinute: number, now: () => number = Date.now) {
    this.limit = tokensPerMinute;
    this.tokensPerMinute = tokensPerMinute;
    this.now = now;
  }

  /**
   * Waits (through `sleep`) until the tokens fit in the last 60 s, then records them. A single request larger than
   * the whole budget is let through when the window is empty. Returns a handle for settle().
   */
  async reserve(tokens: number, sleep: (ms: number) => Promise<void>): Promise<number> {
    let held = false;
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
      const ms = Math.max(1, this.entries[0].at + WINDOW_MS - t);
      if (!held) this.holds++;
      held = true;
      this.heldMs += ms;
      await sleep(ms);
    }
  }

  /** Replace the estimate with what the call really used. */
  settle(handle: number, actualTokens: number): void {
    const e = this.entries.find((x) => x.id === handle);
    if (e) e.tokens = Math.max(0, actualTokens);
  }
}

/**
 * The wait before the run goes on: the base, doubled with every pushback in a row, at most MAX_BACKOFF_MS — and
 * never less than the server's retry-after. From 5 s: 5, 10, 20, 40, 80 s … 15 min. From 60 s: 1, 2, 4, 8, 15 min.
 * `attempt` starts at 1.
 */
export function backoffMs(attempt: number, retryAfterMs: number | null, baseMs: number = BASE_WAIT_MS): number {
  const step = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), Math.max(baseMs, MAX_BACKOFF_MS));
  return Math.max(step, retryAfterMs ?? 0);
}

export interface PacedOptions<T> {
  /** The to-do, in its order. */
  items: T[];
  /**
   * Calls in flight at once. "self" = the run's own speed (`pacer`): it grows while calls succeed and halves on a
   * pushback. A number is for the steps whose calls depend on each other and go one at a time (map, merge, match).
   */
  concurrency: number | "self";
  /** The run's speed. Every pushback slows it; successes speed it up only in a "self" loop — one call at a time proves nothing about going faster. */
  pacer?: Pacer;
  /** Tokens, before the call. */
  estimate: (item: T) => number;
  /** Makes the call AND saves its result; returns the tokens it used. */
  work: (item: T) => Promise<number>;
  budget: TokenBudget;
  sleep: (ms: number) => Promise<void>;
  /** A pushback — a capacity answer, or a failing endpoint (`cause.transient`): the loop is about to sleep `ms`. `cause.speed` is the run's speed before and after, when it has a pacer. */
  onWait: (ms: number, attempt: number, cause: { transient: boolean; message: string; retryAfterMs: number | null; speed: { from: number; to: number } | null }) => Promise<void>;
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
  /** The first wait after a capacity answer (default BASE_WAIT_MS) and after a failing endpoint (default TRANSIENT_BASE_WAIT_MS). */
  baseWaitMs?: number;
  transientBaseWaitMs?: number;
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
 * 1. Items start in order, at most `concurrency` in flight — the run's own speed when it is "self" — each after
 *    budget.reserve(estimate(item)).
 * 2. work succeeds → the item is done; the count of capacity answers in a row goes back to 0; in a "self" loop the
 *    pacer counts the success (a full round of them makes the run one faster).
 * 3. work throws CapacityError → no new item starts; the calls in flight are left to finish; every item that got a
 *    capacity answer goes back to the front of the to-do in its original order; then onWait, sleep, onResume, and on.
 *    The pacer halves the run's speed before the wait. The wait doubles with every pushback in a row (backoffMs).
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
  /** Calls in flight at most, right now: the run's speed in a "self" loop (1 without a pacer), else the number given. */
  const limit = () => Math.max(1, o.concurrency === "self" ? o.pacer?.speed ?? 1 : o.concurrency);

  const run = async (entry: { index: number; item: T }, handle: number): Promise<void> => {
    try {
      const used = await o.work(entry.item);
      o.budget.settle(handle, used);
      result.done++;
      attempt = 0;
      transientWaits = 0;
      if (o.concurrency === "self") o.pacer?.success();
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
    while (!halted() && queue.length > 0 && inflight.size < limit()) {
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
      const ms = backoffMs(attempt, hit.retryAfterMs, hit.transient ? o.transientBaseWaitMs ?? TRANSIENT_BASE_WAIT_MS : o.baseWaitMs ?? BASE_WAIT_MS);
      if (result.waitedMs + ms > o.maxWaitMs) throw new CapacityError(`PMOS AI had no capacity for ${Math.round(result.waitedMs / 60_000)} min in all — giving up`, hit.retryAfterMs);
      result.waits++;
      // The provider pushed back: the run slows down before it goes on.
      const speed = o.pacer?.pushback() ?? null;
      await o.onWait(ms, attempt, { transient: hit.transient, message: hit.message, retryAfterMs: hit.retryAfterMs, speed });
      await o.sleep(ms);
      result.waitedMs += ms;
      await o.onResume();
      continue;
    }
    if (result.stopped || queue.length === 0) return result;
  }
}
