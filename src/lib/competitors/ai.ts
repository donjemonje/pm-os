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
 * extractFacts — a competitor's pages → lean-profile facts (closed kinds), each with a URL.
 * The organization itself is never scanned: its catalog and own statuses are entered by its PMs.
 *
 * Pages are sent as text only. The shared prefix (instructions + catalog) is
 * cache-marked; the per-call tail is the page text.
 */

export const COMPETITORS_PROMPT_VERSION = "competitors-v2";

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

/** Keep each call well inside the context window; marketing pages are wordy. */
const MAX_PAGE_CHARS = 6000;
/** Page text per call. Gemini's window is large; Claude's calls stay smaller. */
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

/**
 * Split pages into calls: each chunk fits maxTotalChars after per-page
 * truncation. A website scan of 50 pages is one chunk; an import of a
 * thousand documents is many, run in order.
 */
export function chunkPages(pages: PageText[], limit = maxTotalChars()): PageText[][] {
  const chunks: PageText[][] = [];
  let cur: PageText[] = [];
  let total = 0;
  for (const p of pages) {
    const len = pageBody(p).length + p.url.length + 40;
    if (cur.length && total + len > limit) {
      chunks.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(p);
    total += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function packPages(pages: PageText[]): string {
  return pages
    .map((p) => {
      const meta = [p.kind && p.kind !== "page" ? p.kind : null, p.sourceLabel ?? null, p.observedAt ? `dated ${p.observedAt.slice(0, 10)}` : null].filter(Boolean).join(" · ");
      return `### PAGE ${p.url}\nTitle: ${p.title}${meta ? `\nSource: ${meta}` : ""}\n${pageBody(p)}`;
    })
    .join("\n\n");
}

export interface AiResult<T> {
  value: T;
  usage: unknown;
  /** Model calls made (one per chunk of pages). */
  calls: number;
}

/**
 * `injected` is the TEST KNOB at the model boundary (settings.ts testAiAnswers, COMPETITORS_TEST_KNOBS=on only): the raw
 * JSON text the model would have answered. It replaces the model call and nothing else — chunking, parsing, name
 * matching and everything the scan does with the answer run unchanged. With an injected answer no model is ever called.
 */
async function callTool<T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, maxTokens: number, injected?: string): Promise<AiResult<T>> {
  if (injected !== undefined) {
    try {
      return { value: JSON.parse(injected) as T, usage: null, calls: 1 };
    } catch {
      throw new Error(`PMOS AI test answer is not valid JSON (${injected.length} chars)`);
    }
  }
  const model = getCompetitorsModel();
  if (getCompetitorsProvider(model) === "gemini") {
    const response = await getGemini().models.generateContent({
      model,
      contents: `${shared}\n\n${tail}`,
      config: {
        systemInstruction: `${system}\n\nAnswer with the JSON object described by the response schema and nothing else.`,
        temperature: 0,
        // Gemini 4 takes a thinking *level*, not a token budget (a budget is
        // rejected). HIGH (Daniel, 2026-10-26): the status call weighs 26
        // capabilities against 50 pages and runs once a week per competitor,
        // so accuracy beats speed. Thinking is billed against maxOutputTokens.
        thinkingConfig: { thinkingLevel: thinkingLevel() },
        maxOutputTokens: maxTokens + 16000,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(tool.input_schema as Record<string, unknown>),
      },
    });
    const text = response.text ?? "";
    try {
      return { value: JSON.parse(text) as T, usage: response.usageMetadata, calls: 1 };
    } catch {
      const finish = response.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(`PMOS AI (${model}) returned invalid JSON (finish: ${finish}, ${text.length} chars)`);
    }
  }
  const message = await getCompetitorsClient().messages.create({
    model: getCompetitorsModel(),
    max_tokens: maxTokens,
    system,
    tools: [tool as never],
    tool_choice: { type: "tool", name: tool.name as string },
    messages: prefixedUserMessage(shared, tail),
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("PMOS AI returned no structured answer");
  return { value: toolUse.input as T, usage: message.usage, calls: 1 };
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
const str = (v: unknown, max = 500): string => (typeof v === "string" ? cut(tidy(v), max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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

export async function extractFacts(competitorName: string, known: KnownFact[], pages: PageText[], onChunk?: (done: number, total: number) => void, injected?: string): Promise<AiResult<ExtractedFact[]>> {
  const shared = `Extract facts for the competitor profile.`;
  const knownBlock = known.length ? `KNOWN FACTS (already on the profile):\n${known.slice(0, MAX_KNOWN_FACTS).map((f) => `- ${f.kind}: ${f.value}`).join("\n")}\n\n` : "";
  const seen = new Set<string>();
  const facts: ExtractedFact[] = [];
  const chunks = chunkPages(pages);
  let calls = 0;
  let usage: unknown = null;
  for (const [i, chunk] of chunks.entries()) {
    const tail = `COMPETITOR: ${competitorName}\n\n${knownBlock}PAGES${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ""}:\n\n${packPages(chunk)}`;
    const r = await callTool<Record<string, unknown>>(FACTS_SYSTEM_PROMPT, shared, tail, FACTS_TOOL, 6000, injected);
    calls += r.calls;
    usage = r.usage;
    for (const f of arr(r.value.facts)) {
      const o = (f ?? {}) as Record<string, unknown>;
      const kind = str(o.kind, 20);
      const value = str(o.value, 80);
      if (!(FACT_KINDS as readonly string[]).includes(kind) || !value) continue;
      const key = `${kind}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const date = str(o.date, 10);
      facts.push({ kind: kind as FactKind, value, url: str(o.url, 500), date: factDateOf(date) ? date : null, headline: str(o.headline, 120) || null, summary: str(o.summary, 400) || null });
    }
    onChunk?.(i + 1, chunks.length);
  }
  return { value: facts, usage, calls };
}

/**
 * Gemini thinking level: HIGH by default (accuracy over speed for a weekly
 * scan); COMPETITORS_THINKING=medium|low|minimal trades accuracy for a faster
 * answer (a live demo, a small hand-in).
 */
function thinkingLevel(): ThinkingLevel {
  const v = process.env.COMPETITORS_THINKING?.trim().toLowerCase();
  if (v === "low") return ThinkingLevel.LOW;
  if (v === "medium") return ThinkingLevel.MEDIUM;
  if (v === "minimal") return ThinkingLevel.MINIMAL;
  return ThinkingLevel.HIGH;
}
