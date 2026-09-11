import type { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * Import run trace: the health record of one import. The batch row is
 * created the moment an import starts and carries, stage by stage, wall
 * time, model-call time (sum and slowest), DB time, token usage and any
 * error — persisted on `IdeaBatch.trace`, heartbeat on
 * `IdeaBatch.heartbeatAt`, and echoed to the server log as one line per
 * stage. A run the server never finished is not silent: it stays `running`
 * with a stale heartbeat until the next server start or import marks it
 * `aborted` with the stage it was last alive in.
 */

export interface TokenUsage {
  input: number;
  output: number;
  /** Prompt tokens served from the provider's cache (counted in `input` too). */
  cacheRead: number;
  /** Gemini "thoughts" tokens — reasoning the model spent before answering. */
  thinking: number;
}

export interface CallSample {
  /** Wall time of the provider call. */
  aiMs: number;
  /** DB time spent on this call's bookkeeping (the ledger row). */
  dbMs?: number;
  tokens?: Partial<TokenUsage>;
}

/** What a stage module reports back to the trace — one sample per model call. */
export interface StageHooks {
  call(sample: CallSample): void;
}

export type StageKind = "ai" | "db" | "http";

export interface StageTrace {
  stage: string;
  kind: StageKind;
  startedAt: string;
  endedAt?: string;
  ms?: number;
  /** Units the stage worked on (tickets, FR units, groups…). */
  items?: number;
  calls?: number;
  /** Sum of call wall times — exceeds `ms` when calls run in parallel. */
  aiMs?: number;
  aiMaxMs?: number;
  dbMs?: number;
  tokens?: TokenUsage;
  model?: string;
  promptVersion?: string;
  note?: string;
  error?: string;
}

export interface BatchTrace {
  version: 1;
  pid: number;
  serverBootedAt: string;
  uploaded: number;
  fresh: number;
  stages: StageTrace[];
}

/** Boot instant of this server process — a running batch from another boot is dead. */
const SERVER_BOOTED_AT = new Date();

/** A running batch with no beat for this long is treated as dead. */
export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

const HEARTBEAT_EVERY_MS = 5000;

const LOG_PREFIX = "[ideas:import";

function secs(ms: number | undefined): string {
  if (ms === undefined) return "–";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function kilo(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function addTokens(into: TokenUsage, t: Partial<TokenUsage> | undefined): void {
  if (!t) return;
  into.input += t.input ?? 0;
  into.output += t.output ?? 0;
  into.cacheRead += t.cacheRead ?? 0;
  into.thinking += t.thinking ?? 0;
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, thinking: 0 };
}

/** Token usage from an Anthropic `message.usage` object. */
export function anthropicUsage(usage: unknown): Partial<TokenUsage> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cacheRead = n(u.cache_read_input_tokens);
  return {
    input: n(u.input_tokens) + cacheRead + n(u.cache_creation_input_tokens),
    output: n(u.output_tokens),
    cacheRead,
  };
}

/** Token usage from a Gemini `response.usageMetadata` object. */
export function geminiUsage(usage: unknown): Partial<TokenUsage> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: n(u.promptTokenCount),
    output: n(u.candidatesTokenCount),
    cacheRead: n(u.cachedContentTokenCount),
    thinking: n(u.thoughtsTokenCount),
  };
}

export function describeStage(s: StageTrace): string {
  const bits = [`${s.stage} ${s.error ? "FAILED" : "done"} ${secs(s.ms)}`];
  if (s.items !== undefined) bits.push(`${s.items} items`);
  if (s.calls) {
    bits.push(`${s.calls} calls`);
    bits.push(`ai max ${secs(s.aiMaxMs)} / sum ${secs(s.aiMs)}`);
  }
  if (s.dbMs !== undefined && s.kind !== "db") bits.push(`db ${secs(s.dbMs)}`);
  if (s.tokens && (s.tokens.input || s.tokens.output)) {
    const t = s.tokens;
    let tok = `tokens ${kilo(t.input)} in / ${kilo(t.output)} out`;
    if (t.thinking) tok += ` (${kilo(t.thinking)} thinking)`;
    if (t.cacheRead) tok += ` (${kilo(t.cacheRead)} cached)`;
    bits.push(tok);
  }
  if (s.model) bits.push(`${s.model}${s.promptVersion ? ` ${s.promptVersion}` : ""}`);
  if (s.note) bits.push(s.note);
  if (s.error) bits.push(`error: ${s.error}`);
  return bits.join(" · ");
}

export class ImportTrace implements StageHooks {
  private readonly stages: StageTrace[] = [];
  private current: StageTrace | null = null;
  private currentStart = 0;
  private pending: Promise<void> = Promise.resolve();
  private lastBeat = Date.now();
  private readonly t0 = performance.now();
  private readonly tag: string;
  uploaded = 0;
  fresh = 0;

  constructor(readonly batchId: string) {
    this.tag = `${LOG_PREFIX} ${batchId.slice(0, 8)}]`;
  }

  get elapsedMs(): number {
    return Math.round(performance.now() - this.t0);
  }

  /** Start a stage; an open stage is closed first. */
  begin(stage: string, kind: StageKind, items?: number): void {
    if (this.current) this.end();
    this.current = {
      stage,
      kind,
      startedAt: new Date().toISOString(),
      ...(items !== undefined ? { items } : {}),
    };
    this.currentStart = performance.now();
    this.stages.push(this.current);
    console.log(`${this.tag} ${stage} start${items !== undefined ? ` · ${items} items` : ""}`);
  }

  call(sample: CallSample): void {
    const s = this.current;
    if (!s) return;
    s.calls = (s.calls ?? 0) + 1;
    s.aiMs = Math.round((s.aiMs ?? 0) + sample.aiMs);
    s.aiMaxMs = Math.round(Math.max(s.aiMaxMs ?? 0, sample.aiMs));
    if (sample.dbMs !== undefined) s.dbMs = Math.round((s.dbMs ?? 0) + sample.dbMs);
    if (sample.tokens) {
      s.tokens ??= emptyTokens();
      addTokens(s.tokens, sample.tokens);
    }
    this.beat(false);
  }

  /** Close the open stage, attaching model/prompt/notes and logging its line. */
  end(extra?: Partial<Pick<StageTrace, "items" | "calls" | "model" | "promptVersion" | "note">>): void {
    const s = this.current;
    if (!s) return;
    s.endedAt = new Date().toISOString();
    s.ms = Math.round(performance.now() - this.currentStart);
    if (s.kind === "db") s.dbMs = s.ms;
    Object.assign(s, extra ?? {});
    this.current = null;
    console.log(`${this.tag} ${describeStage(s)}`);
    this.beat(true);
  }

  /** Record the failure on the open stage; returns the user-facing message. */
  fail(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const s = this.current;
    if (s) {
      s.error = message;
      this.end();
      console.error(`${this.tag} failed at ${s.stage} after ${secs(this.elapsedMs)}: ${message}`);
      return `${s.stage} failed: ${message}`;
    }
    console.error(`${this.tag} failed after ${secs(this.elapsedMs)}: ${message}`);
    return message;
  }

  snapshot(): BatchTrace {
    return {
      version: 1,
      pid: process.pid,
      serverBootedAt: SERVER_BOOTED_AT.toISOString(),
      uploaded: this.uploaded,
      fresh: this.fresh,
      stages: this.stages.map((s) => ({ ...s })),
    };
  }

  /** Persist heartbeat + trace; throttled unless forced. Never fails the import. */
  private beat(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastBeat < HEARTBEAT_EVERY_MS) return;
    this.lastBeat = now;
    const trace = this.snapshot();
    this.pending = this.pending
      .then(() =>
        db.ideaBatch
          .update({
            where: { id: this.batchId },
            data: {
              heartbeatAt: new Date(),
              trace: trace as unknown as Prisma.InputJsonValue,
            },
          })
          .then(() => undefined),
      )
      .catch((e: unknown) => {
        console.error(`${this.tag} heartbeat write failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** Final write: status, stats or error, full trace. */
  async flush(final: {
    status: "completed" | "failed";
    stats?: unknown;
    error?: string;
  }): Promise<void> {
    if (this.current) this.end();
    await this.pending;
    const trace = this.snapshot();
    await db.ideaBatch.update({
      where: { id: this.batchId },
      data: {
        status: final.status,
        completedAt: new Date(),
        heartbeatAt: new Date(),
        error: final.error ?? null,
        ...(final.stats !== undefined
          ? { stats: final.stats as Prisma.InputJsonValue }
          : {}),
        trace: trace as unknown as Prisma.InputJsonValue,
      },
    });
    const totals = emptyTokens();
    for (const s of trace.stages) addTokens(totals, s.tokens);
    const summary = trace.stages
      .filter((s) => s.kind === "ai" || (s.ms ?? 0) >= 500)
      .map((s) => `${s.stage} ${secs(s.ms)}${s.calls ? ` (${s.calls})` : ""}`)
      .join(" · ");
    console.log(
      `${this.tag} ${final.status} in ${secs(this.elapsedMs)} — ${summary} · tokens ${kilo(totals.input)} in / ${kilo(totals.output)} out${final.error ? ` · ${final.error}` : ""}`,
    );
  }
}

/**
 * Close out runs the server never finished: every batch still `running`
 * whose heartbeat is older than the stale window (or all of them, on server
 * start — nothing can still be running then). Deterministic, no guessing.
 */
export async function markAbandonedImports(
  reason: "server started" | "stale heartbeat",
): Promise<number> {
  const cutoff =
    reason === "server started"
      ? new Date()
      : new Date(Date.now() - STALE_HEARTBEAT_MS);
  const dead = await db.ideaBatch.findMany({
    where: { status: "running", heartbeatAt: { lt: cutoff } },
    select: { id: true, heartbeatAt: true, trace: true },
  });
  for (const b of dead) {
    const trace = b.trace as unknown as BatchTrace | null;
    const last = trace?.stages.at(-1);
    const where = last
      ? `${last.stage}${last.error ? ` (${last.error})` : ""}`
      : "before the first stage";
    const error = `Import aborted — ${
      reason === "server started"
        ? "the server was stopped while it was running"
        : "no heartbeat since the server stopped or lost the request"
    }; last alive at ${b.heartbeatAt.toISOString()} in ${where}`;
    await db.ideaBatch.update({
      where: { id: b.id },
      data: { status: "aborted", error, completedAt: b.heartbeatAt },
    });
    console.error(`${LOG_PREFIX} ${b.id.slice(0, 8)}] ${error}`);
  }
  return dead.length;
}
