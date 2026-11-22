import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The full record of one model call, for looking into a call that misbehaved. OFF unless COMPETITORS_CALL_LOG_DIR
 * names a folder (a developer's machine, a hand run): then every Gemini call writes two files there —
 *   <time>-<tool>.request.txt   exactly what was sent: the instruction, then the content
 *   <time>-<tool>.json          the settings of the call, every piece of the stream with its time, why it stopped,
 *                               what it used (as the provider reports it, untouched), the answer text as it came,
 *                               and the error with its cause when the call failed.
 * COMPETITORS_CALL_LOG_THOUGHTS=1 also asks the provider for the model's thought summaries and keeps them. That is a
 * change of the request (includeThoughts), so it is its own switch.
 *
 * Nothing secret is written: no credentials, no request headers. The request text is the organization's own pages
 * and catalog, so the folder belongs outside the repository.
 */

export interface CallLog {
  /** Ask the provider for thought summaries (COMPETITORS_CALL_LOG_THOUGHTS=1). */
  thoughts: boolean;
  /** One piece of the stream, as the provider sent it. */
  piece(piece: unknown): void;
  /** The call ended: with an answer (how it was judged) or with an error. Writes the record. */
  end(outcome: { judged: string; error?: unknown }): void;
}

interface Part { text?: string; thought?: boolean }
interface Piece {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: unknown; finishMessage?: unknown; safetyRatings?: unknown }>;
  usageMetadata?: unknown; modelVersion?: unknown; responseId?: unknown; createTime?: unknown; promptFeedback?: unknown;
  sdkHttpResponse?: { headers?: unknown };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** What an error says, as deep as it goes: name, message, status, code, and the same of its cause. */
export function describeError(e: unknown, depth = 0): unknown {
  if (!(e instanceof Error)) return e === undefined ? undefined : String(e);
  const x = e as Error & { status?: unknown; code?: unknown; cause?: unknown };
  return { name: x.name, message: x.message, status: x.status, code: x.code, cause: depth < 3 && x.cause !== undefined ? describeError(x.cause, depth + 1) : undefined };
}

/** The log of one call, or null when logging is off. `request` is what is about to be sent. */
export function openCallLog(request: { tool: string; model: string; location: string; settings: Record<string, unknown>; instruction: string; contents: string; schema: unknown }, dir = process.env.COMPETITORS_CALL_LOG_DIR): CallLog | null {
  if (!dir) return null;
  const started = Date.now();
  const base = join(dir, `${stamp()}-${request.tool.replace(/[^a-z0-9_-]/gi, "_")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${base}.request.txt`, `${request.instruction}\n\n===== CONTENT =====\n\n${request.contents}`);
  const pieces: unknown[] = [];
  let answer = "";
  let thoughtText = "";
  let finish: unknown = null;
  let finishMessage: unknown = null;
  let usage: unknown = null;
  let firstPieceMs: number | null = null;
  let firstAnswerMs: number | null = null;
  let headers: unknown = null;
  /** Requests the answer took: 1, plus one for every time the provider stopped at its per-request limit and the SDK went on (finish CONTINUATION). */
  let continued = 0;
  const meta: Record<string, unknown> = {};
  return {
    thoughts: process.env.COMPETITORS_CALL_LOG_THOUGHTS === "1",
    piece(raw) {
      const p = (raw ?? {}) as Piece;
      const ms = Date.now() - started;
      if (firstPieceMs === null) firstPieceMs = ms;
      const c = p.candidates?.[0];
      let text = 0;
      let thought = 0;
      for (const part of c?.content?.parts ?? []) {
        if (typeof part.text !== "string") continue;
        if (part.thought) { thoughtText += part.text; thought += part.text.length; } else { answer += part.text; text += part.text.length; }
      }
      if (text && firstAnswerMs === null) firstAnswerMs = ms;
      if (c?.finishReason != null) finish = c.finishReason;
      if (String(c?.finishReason ?? "") === "CONTINUATION") continued++;
      if (c?.finishMessage != null) finishMessage = c.finishMessage;
      if (p.usageMetadata) usage = p.usageMetadata;
      if (p.sdkHttpResponse?.headers && !headers) headers = p.sdkHttpResponse.headers;
      for (const k of ["modelVersion", "responseId", "createTime", "promptFeedback"] as const) if (p[k] != null) meta[k] = p[k];
      pieces.push({ ms, answerChars: text, thoughtChars: thought, finishReason: c?.finishReason ?? undefined, finishMessage: c?.finishMessage ?? undefined, safetyRatings: c?.safetyRatings ?? undefined, usageMetadata: p.usageMetadata ?? undefined });
    },
    end(outcome) {
      writeFileSync(`${base}.json`, JSON.stringify({
        tool: request.tool, model: request.model, location: request.location, settings: request.settings,
        sent: { instructionChars: request.instruction.length, contentChars: request.contents.length, schema: request.schema },
        timing: { startedAt: new Date(started).toISOString(), totalMs: Date.now() - started, firstPieceMs, firstAnswerMs },
        judged: outcome.judged, error: outcome.error === undefined ? undefined : describeError(outcome.error),
        finishReason: finish, finishMessage, requests: 1 + continued, usageMetadata: usage, ...meta, responseHeaders: headers,
        answerChars: answer.length, thoughtChars: thoughtText.length, pieces,
        answer, thoughts: thoughtText || undefined,
      }, null, 1));
    },
  };
}
