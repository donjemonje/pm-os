import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";
import { getVertexProjectId } from "../vertex-config";
import { FACT_KINDS, type FactKind } from "./config";
import { getCompetitorsClient, prefixedUserMessage } from "./vertex";

/**
 * PMOS AI for competitors: structured calls, never free text. The model is
 * COMPETITORS_MODEL: a `gemini-*` id runs on Gemini (Vertex, structured
 * output through a response schema — Daniel 2026-10-26: Gemini is covered by
 * the GCP credits, so competitors is where it is tried first); anything else
 * runs on Claude through the Vertex Anthropic client (forced tool use). Both
 * paths validate the answer field by field.
 *
 * This module is the model boundary: callTool (one structured call, with the tokens it used and typed errors),
 * the string cleaners, and the profile-facts prompt. The four prompts of the capability analysis (research,
 * merge, match, second look) live in analysis/prompts.ts; who calls what, and when, is analysis/steps.ts.
 * The organization itself is never scanned: its catalog and own statuses are entered by its PMs.
 *
 * Pages are sent as text only. A shared prefix (when a prompt has one) goes first so that provider-side
 * caching can apply; the per-call tail follows.
 */

/** Bumping it makes every stored page due for the facts step again (it is part of SourcePage.factsKey). */
export const FACTS_VERSION = "facts-1";

export function getCompetitorsModel(): string {
  return process.env.COMPETITORS_MODEL?.trim() || "gemini-4-argon";
}

export type CompetitorsProvider = "gemini" | "claude";
export function getCompetitorsProvider(model = getCompetitorsModel()): CompetitorsProvider {
  return /^gemini/i.test(model) ? "gemini" : "claude";
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

/** Facts only: a page's text is cut to this in a facts call. The research step of the analysis sends the full text. */
const MAX_PAGE_CHARS = 6000;
/** Facts only: page text per call. Gemini's window is large; Claude's calls stay smaller. */
export function maxTotalChars(provider = getCompetitorsProvider()): number {
  return provider === "gemini" ? 300_000 : 90_000;
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  /** What the text is (page | document | article | transcript | capture | quotes) — shown to the model. */
  kind?: string;
  /** Source type label ("Help center", "Datasheets & documents") — shown to the model. */
  sourceLabel?: string;
  /** Publish/capture date the source states, ISO — shown to the model. */
  observedAt?: string | null;
}

function pageBody(p: PageText): string {
  return p.text.length > MAX_PAGE_CHARS ? p.text.slice(0, MAX_PAGE_CHARS) + "\n[…]" : p.text;
}

/** What a page weighs in a facts call: its text after the per-page cut, plus its header. */
export function packedSize(chars: number, urlLength: number): number {
  return Math.min(chars, MAX_PAGE_CHARS) + (chars > MAX_PAGE_CHARS ? "\n[…]".length : 0) + urlLength + 40;
}

/** Items in order, packed into chunks of at most `limit` (an item larger than the limit goes alone); none is dropped. */
export function chunkBySize<T>(items: T[], sizeOf: (item: T) => number, limit: number): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let total = 0;
  for (const item of items) {
    const len = sizeOf(item);
    if (cur.length && total + len > limit) {
      chunks.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(item);
    total += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Split pages into facts calls: each chunk fits maxTotalChars after per-page
 * truncation. A site of 50 pages is one chunk; a thousand documents are many,
 * run in order.
 */
export function chunkPages(pages: PageText[], limit = maxTotalChars()): PageText[][] {
  return chunkBySize(pages, (p) => packedSize(p.text.length, p.url.length), limit);
}

/** What a page is, in one line for the model: its kind when it is not a web page, its source, its date. "" when there is nothing to say. */
export function pageMeta(p: Pick<PageText, "kind" | "sourceLabel" | "observedAt">): string {
  return [p.kind && p.kind !== "page" ? p.kind : null, p.sourceLabel ?? null, p.observedAt ? `dated ${p.observedAt.slice(0, 10)}` : null].filter(Boolean).join(" · ");
}

export function packPages(pages: PageText[]): string {
  return pages
    .map((p) => {
      const meta = pageMeta(p);
      return `### PAGE ${p.url}\nTitle: ${p.title}${meta ? `\nSource: ${meta}` : ""}\n${pageBody(p)}`;
    })
    .join("\n\n");
}

/** Tokens one call used. `output` includes thinking tokens; `cached` is the part of `input` served from a cache. */
export interface Usage {
  input: number;
  output: number;
  cached: number;
}
export const NO_USAGE: Usage = { input: 0, output: 0, cached: 0 };

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

/** The model answered (HTTP 200) but the answer is unusable: invalid JSON, no structured answer, empty, or cut off. */
export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerError";
  }
}

export type ThinkingName = "minimal" | "low" | "medium" | "high";
export interface CallOptions {
  /** Visible output tokens the answer may take (thinking is on top). */
  maxTokens: number;
  /** The thinking level this prompt asks for; COMPETITORS_THINKING overrides it when set. */
  thinking?: ThinkingName;
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
export function asCapacityError(e: unknown): unknown {
  if (e instanceof CapacityError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 429 || status === 503 || status === 529 || /RESOURCE_EXHAUSTED/.test(message)) return new CapacityError(message.slice(0, 300), retryAfterOf(e));
  if (status === 500 || status === 502 || status === 504 || isNetworkError(e)) return new TransientError(message.slice(0, 300), retryAfterOf(e));
  return e;
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
  const model = getCompetitorsModel();
  const contents = shared ? `${shared}\n\n${tail}` : tail;
  if (getCompetitorsProvider(model) === "gemini") {
    let response;
    try {
      response = await getGemini().models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: `${system}\n\nAnswer with the JSON object described by the response schema and nothing else.`,
          temperature: 0,
          // Gemini 4 takes a thinking *level*, not a token budget (a budget is rejected). Each prompt asks for its
          // own level (analysis/prompts.ts); thinking is billed against maxOutputTokens, hence the headroom.
          thinkingConfig: { thinkingLevel: thinkingLevel(opts.thinking) },
          maxOutputTokens: opts.maxTokens + 16000,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(tool.input_schema as Record<string, unknown>),
        },
      });
    } catch (e) {
      throw asCapacityError(e);
    }
    const u = response.usageMetadata;
    const usage: Usage = { input: u?.promptTokenCount ?? 0, output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), cached: u?.cachedContentTokenCount ?? 0 };
    const text = response.text ?? "";
    const finish = String(response.candidates?.[0]?.finishReason ?? "unknown");
    if (!text.trim()) throw new AnswerError(`PMOS AI (${model}) returned an empty answer (finish: ${finish})`);
    if (finish !== "STOP") throw new AnswerError(`PMOS AI (${model}) did not finish its answer (finish: ${finish}, ${text.length} chars)`);
    try {
      return { value: JSON.parse(text) as T, usage };
    } catch {
      throw new AnswerError(`PMOS AI (${model}) returned invalid JSON (finish: ${finish}, ${text.length} chars)`);
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
  };
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new AnswerError("PMOS AI returned no structured answer");
  if (message.stop_reason === "max_tokens") throw new AnswerError("PMOS AI did not finish its answer (max tokens)");
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

// ————— Lean-profile facts —————

export const FACTS_SYSTEM_PROMPT = `You extract company facts from a competitor's public sources (website, documents, help center, press, jobs — each page says which) for a product team's competitor profile.

Return facts of these kinds only:
- tagline: the one-line positioning statement (at most one).
- product: each named product, module or plan family the company sells.
- pricingTier: each named pricing tier or plan (names only, no prices).
- integration: each named third-party product it integrates with.
- certification: each named certification or compliance standard (SOC 2, ISO 27001, FedRAMP…).
- customer: each named customer company shown as a customer, logo or case study.
- vertical: each industry it says it serves.
- funding: a funding round or acquisition amount as stated ("Series C $40M", "acquired by Mastercard for $2.65B").
- headcount: the company size as stated ("1,000+ employees").
- hiring: an open-roles statement as stated ("49 open positions").
- ownership: public / private / subsidiary of X, as stated.
- hq: the headquarters city and country, as stated.
- founded: the founding year, as stated.
- milestone: a dated company event the pages state — founding, acquisition, launch, rename, new office (one short line each).
Each fact is a short value (≤ 80 characters), the URL of the page it came from, and the date the page states for it when it states one ("YYYY-MM-DD", "YYYY-MM" or "YYYY"; empty otherwise — never the page's own date). For a product, customer, funding, milestone, hiring or ownership fact also write the news for a product manager who will not open the page: "headline" — one line saying what happened (≤ 90 characters, e.g. "Recorded Future released an MCP server for external AI agents"), and "summary" — two plain sentences on what it is and why it matters, from the page only (≤ 300 characters, no marketing words). For the other kinds leave headline and summary empty. Only what the pages state; nothing inferred, no counts you computed, no adjectives. Deduplicate: one fact per thing. When the profile already holds a fact (KNOWN FACTS) and a page restates it, return it with exactly the known wording so it is recognised — never a reworded copy; add its date when the page states one.`;

export const FACTS_TOOL = {
  name: "extract_facts",
  description: "Record the company facts found on the pages.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...FACT_KINDS] },
            value: { type: "string" },
            url: { type: "string" },
            date: { type: "string", description: "Date the page states for the fact: YYYY-MM-DD, YYYY-MM or YYYY; empty when none." },
            headline: { type: "string", description: "One line saying what happened; empty for tagline/pricing/integration/certification/vertical/headcount/hq/founded." },
            summary: { type: "string", description: "Two plain sentences: what it is and why it matters, from the page; empty when headline is empty." },
          },
          required: ["kind", "value", "url", "date", "headline", "summary"],
        },
      },
    },
    required: ["facts"],
  },
};

export interface ExtractedFact {
  kind: FactKind;
  value: string;
  url: string;
  /** "YYYY", "YYYY-MM" or "YYYY-MM-DD"; null when the page states none. */
  date: string | null;
  /** The news in one line and two sentences, for the feed and the email; null for facts that are not news. */
  headline: string | null;
  summary: string | null;
}

/** A stated date → a Date at the start of its period, or null. */
export function factDateOf(v: string | null | undefined): Date | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec((v ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  const day = m[3] ? Number(m[3]) : 1;
  if (y < 1900 || y > new Date().getUTCFullYear() + 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(y, month - 1, day));
  // A day past the month's end rolls over — refuse it rather than invent a date.
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

export interface KnownFact { kind: string; value: string }
/** Known facts shown to the model so restatements keep their wording (and merge on upsert). */
export const MAX_KNOWN_FACTS = 1500;

/** The facts of one answer, field by field; duplicates inside the answer dropped. */
export function parseFacts(value: unknown): ExtractedFact[] {
  const seen = new Set<string>();
  const facts: ExtractedFact[] = [];
  for (const f of arr((value as Record<string, unknown> | null)?.facts)) {
    const o = (f ?? {}) as Record<string, unknown>;
    const kind = str(o.kind, 20);
    const v = str(o.value, 80);
    if (!(FACT_KINDS as readonly string[]).includes(kind) || !v) continue;
    const key = factKey(kind, v);
    if (seen.has(key)) continue;
    seen.add(key);
    const date = str(o.date, 10);
    facts.push({ kind: kind as FactKind, value: v, url: str(o.url, 500), date: factDateOf(date) ? date : null, headline: str(o.headline, 120) || null, summary: str(o.summary, 400) || null });
  }
  return facts;
}

/** One fact = one kind and one value, whatever its letter case. */
export function factKey(kind: string, value: string): string {
  return `${kind}|${value.toLowerCase()}`;
}

/** What one facts call is asked: the known facts (so restatements keep their wording) and one chunk of pages. */
export function renderFactsTail(competitorName: string, known: KnownFact[], chunk: PageText[], part: number, parts: number): string {
  const knownBlock = known.length ? `KNOWN FACTS (already on the profile):\n${known.slice(0, MAX_KNOWN_FACTS).map((f) => `- ${f.kind}: ${f.value}`).join("\n")}\n\n` : "";
  return `COMPETITOR: ${competitorName}\n\n${knownBlock}PAGES${parts > 1 ? ` (part ${part} of ${parts})` : ""}:\n\n${packPages(chunk)}`;
}

/** The shared prefix and the answer size of a facts call. The call itself, the loop over chunks, the pacing and the saving are analysis/facts.ts. */
export const FACTS_SHARED = "Extract facts for the competitor profile.";
export const FACTS_MAX_TOKENS = 6000;

/** A run reads the pages in several chunks: a fact an earlier chunk of the run already returned is not returned again. `seen` is the run's memory (factKey). */
export function dedupeFacts(facts: ExtractedFact[], seen: Set<string>): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const f of facts) {
    const key = factKey(f.kind, f.value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Gemini thinking level: COMPETITORS_THINKING wins when it is set (dev sets "low"), else the level the prompt
 * asks for, else HIGH.
 */
function thinkingLevel(asked?: ThinkingName): ThinkingLevel {
  const env = process.env.COMPETITORS_THINKING?.trim().toLowerCase();
  const v = env === "low" || env === "medium" || env === "minimal" || env === "high" ? env : asked;
  if (v === "low") return ThinkingLevel.LOW;
  if (v === "medium") return ThinkingLevel.MEDIUM;
  if (v === "minimal") return ThinkingLevel.MINIMAL;
  return ThinkingLevel.HIGH;
}
