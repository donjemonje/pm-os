import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";
import { getVertexProjectId } from "../vertex-config";
import { modelFor, providerOf, type ModelProvider, type ThinkingLevelName } from "./models";
import { getCompetitorsClient, prefixedUserMessage } from "./vertex";
import { allowLongCalls } from "./long-calls";
import { openCallLog } from "./call-log";

/**
 * PMOS AI for competitors: structured calls, never free text. The model is
 * chosen per call by its role (models.ts: read / match / judge — the old single
 * COMPETITORS_MODEL decides nothing any more): a `gemini-*` id runs on Gemini (Vertex, structured
 * output through a response schema — Daniel 2026-10-26: Gemini is covered by
 * the GCP credits, so competitors is where it is tried first); anything else
 * runs on Claude through the Vertex Anthropic client (forced tool use). Both
 * paths validate the answer field by field.
 *
 * This module is the model boundary: callTool (one structured call, with the tokens it used and typed errors) and
 * the string cleaners. It holds no prompt: the prompts of the capability analysis live next to their rules
 * (analysis/prompts.ts, reading.ts, unify.ts, domains.ts), the pick of a company's other addresses in addresses.ts.
 * The profile-facts prompt that used to live here is gone with its step (Daniel 2026-11-16: "we don't care about
 * profile now, only the table"); the facts a profile already holds stay and are shown — nothing writes new ones.
 *
 * Pages are sent as text only. A shared prefix (when a prompt has one) goes first so that provider-side
 * caching can apply; the per-call tail follows.
 */

export type CompetitorsProvider = ModelProvider;
/** The provider of a model; with no model given, of the "read" model. */
export function getCompetitorsProvider(model = modelFor("read")): CompetitorsProvider {
  return providerOf(model);
}

/**
 * Gemini region for competitors. The newest Gemini models (gemini-4-argon,
 * 2026-10-26) are served on the "global" endpoint only — not in
 * europe-west1 — so "global" is the default here; COMPETITORS_GEMINI_LOCATION
 * overrides (e.g. the app's GEMINI_LOCATION for older models).
 */
export function getCompetitorsGeminiLocation(): string {
  return process.env.COMPETITORS_GEMINI_LOCATION?.trim() || "global";
}

let gemini: GoogleGenAI | null = null;
let geminiKey = "";
function getGemini(): GoogleGenAI {
  const project = getVertexProjectId();
  const location = getCompetitorsGeminiLocation();
  const key = `${project}|${location}`;
  if (!gemini || geminiKey !== key) {
    gemini = new GoogleGenAI({ vertexai: true, project, location });
    geminiKey = key;
  }
  return gemini;
}

/** The tool's JSON schema, as Gemini's response schema (same shape, typed enums). */
function toGeminiSchema(node: Record<string, unknown>): Schema {
  const t = String(node.type ?? "object").toLowerCase();
  const out: Schema = {
    type: t === "string" ? Type.STRING : t === "number" ? Type.NUMBER : t === "integer" ? Type.INTEGER : t === "boolean" ? Type.BOOLEAN : t === "array" ? Type.ARRAY : Type.OBJECT,
  };
  if (typeof node.description === "string") out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum.map(String);
  if (node.properties && typeof node.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(node.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (Array.isArray(node.required)) out.required = node.required as string[];
  if (node.items && typeof node.items === "object") out.items = toGeminiSchema(node.items as Record<string, unknown>);
  if (typeof node.minimum === "number") out.minimum = node.minimum;
  if (typeof node.maximum === "number") out.maximum = node.maximum;
  return out;
}

/**
 * Tokens one call used. `output` is everything billed as output — the visible answer and the model's own thinking;
 * `thinking` is the part of it that was thinking, as the provider reports it (0 when it reports none); `cached` is
 * the part of `input` served from a cache.
 */
export interface Usage {
  input: number;
  output: number;
  cached: number;
  thinking: number;
}
export const NO_USAGE: Usage = { input: 0, output: 0, cached: 0, thinking: 0 };

/** PMOS AI has no capacity right now (HTTP 429, 503, 529 or RESOURCE_EXHAUSTED): the caller waits and continues. */
export class CapacityError extends Error {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "CapacityError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * PMOS AI did not answer for a reason that usually passes by itself: HTTP 500, 502, 504 or a network error (no
 * connection, a reset, a timeout). The caller waits and continues exactly as after a capacity answer. Unlike a capacity
 * answer it has a ceiling: an endpoint that fails many times in a row ends the run (analysis/pacing.ts → EndpointError).
 */
export class TransientError extends CapacityError {
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message, retryAfterMs);
    this.name = "TransientError";
  }
}

/** The endpoint kept failing (transient errors in a row, past the ceiling): the run ends as failed, with what the endpoint said. */
export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

/** The most of an unusable answer's text that is kept as evidence. */
export const RAW_ANSWER_KEPT = 2_000;

/**
 * The text of an unusable answer as it is kept: whole up to RAW_ANSWER_KEPT characters; of a longer one the start
 * and the end (where a cut-off or a second object shows), with how much was left out in between.
 */
export function rawForRecord(text: string, max: number = RAW_ANSWER_KEPT): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 4);
  const head = max - tail;
  return `${text.slice(0, head)} …[${(text.length - max).toLocaleString("en-US")} characters left out]… ${text.slice(-tail)}`;
}

/**
 * The model answered (HTTP 200) but the answer is unusable: invalid JSON, no structured answer, empty, or cut off.
 * The call was made and is billed: `usage` carries its tokens so the run counts them. `raw` is the answer's text as
 * it came (rawForRecord) — the evidence: the run keeps it in its log and as an incident, so the next occurrence can
 * be read instead of guessed (the first real run lost a 75-character "invalid JSON" answer with nothing kept).
 * Null when the provider gave no text at all.
 */
export class AnswerError extends Error {
  usage: Usage;
  raw: string | null;
  constructor(message: string, usage: Usage = NO_USAGE, raw: string | null = null) {
    super(message);
    this.name = "AnswerError";
    this.usage = usage;
    this.raw = raw === null ? null : rawForRecord(raw);
  }
}

export type ThinkingName = ThinkingLevelName;

/**
 * The temperature of every Gemini call: 1, the provider's default (Daniel 2026-11-20: "follow Google's best practice;
 * first get good results, then think how to handle randomness"). It was 0 until then. Google's prompting guide for
 * the Gemini 3 family says to keep the default and that lower values "may lead to unexpected behavior, looping, or
 * degraded performance" on complex reasoning; three answers of 2026-11-20 at temperature 0 were planned in full in
 * the model's thinking and then broke off after one row (finish STOP, valid JSON). With 1 the same request can give
 * different answers: what the analysis does about that is an open point.
 */
export const GEMINI_TEMPERATURE = 1;
export interface CallOptions {
  /** The model that makes the call (models.ts modelFor(role)): the caller decides, nothing here reads an environment variable for it. */
  model: string;
  /** Visible output tokens the answer may take (thinking is on top). */
  maxTokens: number;
  /** The thinking level of the call — the level of its role (models.ts thinkingFor(role)): the caller decides, as for the model. Not given = high. */
  thinking?: ThinkingName;
  /** The sampling temperature of a Gemini call. Not given = GEMINI_TEMPERATURE. A hand run gives it to compare settings. */
  temperature?: number;
  /** TEST KNOB: the raw JSON text the model would have answered. With it no model is ever called. */
  injected?: string;
}

function retryAfterOf(e: unknown): number | null {
  const headers = (e as { headers?: unknown } | null)?.headers;
  let raw: unknown = null;
  if (headers && typeof (headers as { get?: unknown }).get === "function") raw = (headers as { get: (k: string) => unknown }).get("retry-after");
  else if (headers && typeof headers === "object") raw = (headers as Record<string, unknown>)["retry-after"];
  const seconds = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

const NETWORK_CODES = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)\b/;
const NETWORK_WORDS = /fetch failed|socket hang up|network error|connection (error|reset|closed|refused|timed out)|request timed out|timeout/i;

/** The request never got an HTTP answer: no connection, a reset, a timeout. An error that carries an HTTP status is not one. */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (typeof (e as { status?: unknown }).status === "number") return false;
  const cause = (e as { cause?: unknown }).cause;
  const code = (e as { code?: unknown }).code ?? (cause as { code?: unknown } | null | undefined)?.code;
  const text = `${e.name} ${e.message} ${cause instanceof Error ? `${cause.name} ${cause.message}` : ""} ${typeof code === "string" ? code : ""}`;
  return NETWORK_CODES.test(text) || NETWORK_WORDS.test(text);
}

/**
 * A provider error the run waits out: "no capacity" (429, 503, 529, RESOURCE_EXHAUSTED) → CapacityError; a passing
 * failure (500, 502, 504, a network error) → TransientError. Anything else — a refused request, a bad schema, no
 * permission — is returned untouched and stops the run.
 */
/** The most of a provider error's text that a capacity or transient error keeps (300 used to cut the reason off mid-sentence). */
export const ERROR_TEXT_KEPT = 600;

/** Our own runtime gave up on a silent request (Node's fetch: no response headers, or no new piece of the body, within its limit). */
const RUNTIME_CUT = /\bUND_ERR_(HEADERS|BODY)_TIMEOUT\b/;

/**
 * What an error says, with its cause: "fetch failed" alone hides why (a reset, a DNS failure, our own timeout).
 * A request cut by our own runtime is named as such — the provider did not refuse it, and asking again the same way
 * ends the same way.
 */
export function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (!cause || typeof cause !== "object") return message;
  const c = cause as { name?: unknown; code?: unknown; message?: unknown };
  const code = typeof c.code === "string" ? c.code : typeof c.name === "string" ? c.name : "";
  const said = typeof c.message === "string" ? c.message : "";
  const detail = [code, said].filter(Boolean).join(": ");
  if (!detail) return message;
  return RUNTIME_CUT.test(code) ? `${message} (${detail}) — our own runtime cut a silent request; the provider did not refuse it` : `${message} (${detail})`;
}

export function asCapacityError(e: unknown): unknown {
  if (e instanceof CapacityError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  const message = errorText(e);
  if (status === 429 || status === 503 || status === 529 || /RESOURCE_EXHAUSTED/.test(message)) return new CapacityError(message.slice(0, ERROR_TEXT_KEPT), retryAfterOf(e));
  if (status === 500 || status === 502 || status === 504 || isNetworkError(e)) return new TransientError(message.slice(0, ERROR_TEXT_KEPT), retryAfterOf(e));
  return e;
}

/**
 * What a Gemini answer says it used. Gemini reports the visible answer (candidatesTokenCount) and the model's own
 * thinking (thoughtsTokenCount) apart; both are billed as output.
 */
export function geminiUsage(u: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | null | undefined): Usage {
  const thinking = u?.thoughtsTokenCount ?? 0;
  return { input: u?.promptTokenCount ?? 0, output: (u?.candidatesTokenCount ?? 0) + thinking, cached: u?.cachedContentTokenCount ?? 0, thinking };
}

/**
 * The one explicit ceiling of a model call: 60 minutes. No call is cut by a default any more (the first chunked
 * reading test, 2026-11-16, lost a 5-minute answer to Node's 300-second fetch timeout); a call that passes this
 * ceiling is stopped and fails as an unusable answer. Long on purpose: the first request of a big company writes its
 * whole list (tens of thousands of output tokens at ~40 tokens a second).
 */
export const CALL_TIMEOUT_MS = 60 * 60_000;

/** One piece of a streamed answer, as the provider sends it: some text parts (the model's own thoughts are marked), and on the last pieces why it stopped and what it used. */
export interface StreamPiece {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: unknown }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
}

export interface CollectedStream {
  /** The answer's text: every text part of every piece, in order — never a thought part. */
  text: string;
  /** Why the model stopped: the last finish reason a piece carried ("unknown" when none did). */
  finish: string;
  usage: Usage;
  /** How many pieces the stream had, and how many of them carried answer text — said when an answer is unusable, to tell a bad answer from a bad join. */
  pieces: number;
  textPieces: number;
}

/** A streamed answer put together: the text of all pieces in order, the last finish reason, the last usage report. Pure; `onPiece` sees every piece as it comes (the call log). */
export async function collectStream(stream: AsyncIterable<StreamPiece>, onPiece?: (piece: StreamPiece) => void): Promise<CollectedStream> {
  let text = "";
  let finish = "unknown";
  let usage: StreamPiece["usageMetadata"] | undefined;
  let pieces = 0;
  let textPieces = 0;
  for await (const piece of stream) {
    onPiece?.(piece);
    pieces++;
    const candidate = piece.candidates?.[0];
    const before = text.length;
    for (const part of candidate?.content?.parts ?? []) if (typeof part.text === "string" && !part.thought) text += part.text;
    if (text.length > before) textPieces++;
    if (candidate?.finishReason != null) finish = String(candidate.finishReason);
    if (piece.usageMetadata) usage = piece.usageMetadata;
  }
  return { text, finish, usage: geminiUsage(usage), pieces, textPieces };
}

/**
 * One structured call. `shared` goes first (the part that repeats across calls of a run, "" when there is none),
 * `tail` after it.
 *
 * `opts.injected` is the TEST KNOB at the model boundary (settings.ts testAiAnswers, COMPETITORS_TEST_KNOBS=on only):
 * the raw JSON text the model would have answered. It replaces the model call and nothing else — parsing, the quote
 * check and everything the analysis does with the answer run unchanged. With an injected answer no model is ever called.
 *
 * Throws CapacityError (wait and continue; TransientError is the kind with a ceiling), AnswerError (the answer is
 * unusable), or the provider's own error.
 */
export async function callTool<T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, opts: CallOptions): Promise<{ value: T; usage: Usage }> {
  if (opts.injected !== undefined) {
    try {
      return { value: JSON.parse(opts.injected) as T, usage: { ...NO_USAGE } };
    } catch {
      throw new Error(`PMOS AI test answer is not valid JSON (${opts.injected.length} chars)`);
    }
  }
  const model = opts.model;
  const contents = shared ? `${shared}\n\n${tail}` : tail;
  if (getCompetitorsProvider(model) === "gemini") {
    // The answer is STREAMED (Daniel 2026-11-16): a long answer arrives piece by piece. Streaming alone does not
    // protect the call: the model thinks before its first piece, and Node's fetch gives up on a request that is
    // silent for 300 s (no first byte, or 300 s between two pieces). The SDK's httpOptions.timeout only aborts the
    // call when it passes; it does NOT raise the runtime's two limits on Node 24 (found 2026-11-19). So the limits
    // are raised here for model hosts (long-calls.ts), to the one explicit ceiling, CALL_TIMEOUT_MS.
    allowLongCalls(CALL_TIMEOUT_MS);
    const started = Date.now();
    const instruction = `${system}\n\nAnswer with the JSON object described by the response schema and nothing else.`;
    const level = thinkingLevel(opts.thinking);
    const maxOutputTokens = opts.maxTokens + 16000;
    const temperature = opts.temperature ?? GEMINI_TEMPERATURE;
    const responseSchema = toGeminiSchema(tool.input_schema as Record<string, unknown>);
    // The full record of the call, when a developer asked for it (call-log.ts); null otherwise.
    const log = openCallLog({ tool: String(tool.name ?? "call"), model, location: getCompetitorsGeminiLocation(), settings: { temperature, thinkingLevel: String(level), maxOutputTokens, responseMimeType: "application/json", streamed: true }, instruction, contents, schema: responseSchema });
    let collected: CollectedStream;
    try {
      const stream = await getGemini().models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: instruction,
          temperature,
          // Gemini 4 takes a thinking *level*, not a token budget (a budget is rejected). The level is the call's
          // role's (models.ts thinkingFor); thinking is billed against maxOutputTokens, hence the headroom.
          thinkingConfig: { thinkingLevel: level, ...(log?.thoughts ? { includeThoughts: true } : {}) },
          maxOutputTokens,
          responseMimeType: "application/json",
          responseSchema,
          httpOptions: { timeout: CALL_TIMEOUT_MS },
        },
      });
      collected = await collectStream(stream, log ? (piece) => log.piece(piece) : undefined);
    } catch (e) {
      log?.end({ judged: "the call failed", error: e });
      // Our own ceiling passed: the call is not asked again by itself — a call this long is a bug to look at, not a blip.
      if (Date.now() - started >= CALL_TIMEOUT_MS - 1000) throw new AnswerError(`PMOS AI (${model}) did not finish its answer within ${Math.round(CALL_TIMEOUT_MS / 60_000)} minutes — the call was stopped`);
      throw asCapacityError(e);
    }
    const { text, finish, usage } = collected;
    // An unusable answer keeps its text (AnswerError.raw) and says how the stream delivered it.
    const came = `${text.length} chars in ${collected.textPieces} of ${collected.pieces} piece${collected.pieces === 1 ? "" : "s"}`;
    if (!text.trim()) { log?.end({ judged: "empty answer" }); throw new AnswerError(`PMOS AI (${model}) returned an empty answer (finish: ${finish}, ${collected.pieces} piece${collected.pieces === 1 ? "" : "s"})`, usage, text); }
    if (finish !== "STOP") { log?.end({ judged: `not finished (finish: ${finish})` }); throw new AnswerError(`PMOS AI (${model}) did not finish its answer (finish: ${finish}, ${came})`, usage, text); }
    try {
      const value = JSON.parse(text) as T;
      log?.end({ judged: "accepted: finished (STOP) and valid JSON" });
      return { value, usage };
    } catch (e) {
      log?.end({ judged: "invalid JSON" });
      throw new AnswerError(`PMOS AI (${model}) returned invalid JSON (finish: ${finish}, ${came}): ${e instanceof Error ? e.message.slice(0, 120) : "not parseable"}`, usage, text);
    }
  }
  let message;
  try {
    message = await getCompetitorsClient().messages.create({
      model,
      max_tokens: opts.maxTokens,
      system,
      tools: [tool as never],
      tool_choice: { type: "tool", name: tool.name as string },
      messages: prefixedUserMessage(shared, tail),
    });
  } catch (e) {
    throw asCapacityError(e);
  }
  const mu = message.usage;
  const usage: Usage = {
    input: (mu?.input_tokens ?? 0) + (mu?.cache_creation_input_tokens ?? 0) + (mu?.cache_read_input_tokens ?? 0),
    output: mu?.output_tokens ?? 0,
    cached: mu?.cache_read_input_tokens ?? 0,
    // This path asks for no extended thinking, and the provider reports none apart.
    thinking: 0,
  };
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new AnswerError("PMOS AI returned no structured answer", usage);
  if (message.stop_reason === "max_tokens") throw new AnswerError("PMOS AI did not finish its answer (max tokens)", usage);
  return { value: toolUse.input as T, usage };
}

/**
 * An AI string as stored: a leaked `','key':'…` fragment is cut off, a dangling
 * `','` or unbalanced closing quote dropped. Models occasionally splice a piece
 * of the next field into a string even under a response schema.
 */
export function tidy(s: string): string {
  let t = s.replace(/['"]\s*,\s*['"]\w+['"]\s*:[\s\S]*$/, "").replace(/['"]\s*,\s*['"]?\s*$/, "").trim();
  t = t.replace(/[\s,;]+$/, "");
  for (const q of ["'", '"']) if (t.endsWith(q) && (t.split(q).length - 1) % 2 === 1) t = t.slice(0, -1).trimEnd();
  return t;
}
/** Cut at a word boundary (a name cut mid-word reads as a bug: "policy enforcemen"). */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:\-–—(]+$/, "");
}
/** A model's string as stored: tidied, cut at a word boundary; "" for anything that is not a string. */
export const str = (v: unknown, max = 500): string => (typeof v === "string" ? cut(tidy(v), max) : "");
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The level as Gemini takes it. Which level a call gets is decided by its role (models.ts thinkingFor), environment overrides included; not given = HIGH. */
function thinkingLevel(asked?: ThinkingName): ThinkingLevel {
  if (asked === "low") return ThinkingLevel.LOW;
  if (asked === "medium") return ThinkingLevel.MEDIUM;
  if (asked === "minimal") return ThinkingLevel.MINIMAL;
  return ThinkingLevel.HIGH;
}
