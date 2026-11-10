import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";
import { getVertexProjectId } from "../vertex-config";
import { FACT_KINDS, STATUS_VALUES, type FactKind, type StatusValue } from "./config";
import { getCompetitorsClient, prefixedUserMessage } from "./vertex";

/**
 * PMOS AI for competitors: structured calls, never free text. The model is
 * COMPETITORS_MODEL: a `gemini-*` id runs on Gemini (Vertex, structured
 * output through a response schema — Daniel 2026-10-26: Gemini is covered by
 * the GCP credits, so competitors is where it is tried first); anything else
 * runs on Claude through the Vertex Anthropic client (forced tool use). Both
 * paths validate the answer field by field.
 *
 * 1. classifyCapabilities — a competitor's changed pages × the catalog → status per capability
 *    with a quote + URL, plus capabilities the catalog lacks (suggestions).
 * 2. extractFacts — a competitor's pages → lean-profile facts (closed kinds), each with a URL.
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
const strs = (v: unknown, max = 120): string[] =>
  arr(v).map((x) => str(x, max)).filter(Boolean);

// ————— 1. Status per capability for a competitor —————

export const CLASSIFY_SYSTEM_PROMPT = `You compare a competitor's public sources (its website, datasheets, help center, videos, docs, press — each page says which) against a fixed capability catalog for a product team.

The catalog is grouped by domain; each domain comes with the product team's own definition of it (what belongs there, what does not, typical phrases). Read those definitions first — they are the ground truth for what each capability means.

For EVERY capability in the catalog, decide from the page text whether the competitor:
- "has" it — the site clearly describes offering this capability;
- "partial" — the site describes a limited, beta, add-on, services-only or narrower version of it;
- "missing" — the site describes the surrounding area but this capability is absent, or the site contradicts it; when the pages cover the competitor's whole product catalog or pricing matrix and the capability appears nowhere in it, answer missing, not unknown;
- "unknown" — the pages give no evidence either way.
Give a confidence from 0 to 1, and for has/partial/missing the single strongest quote (≤ 200 characters, verbatim from the pages) and the URL of the page it is on. For unknown, quote and url are empty. When the pages name the competitor's product, module or plan that provides the capability, give it in "product" (their exact name; empty when not stated). When your answer differs from the previous status (or there is none and the value is has/partial), write "summary": one plain sentence for a product manager saying what the competitor now offers for this capability and since when if the page says (≤ 200 characters, no marketing words); otherwise leave summary empty.

Also list capabilities the competitor clearly advertises that are NOT in the catalog but belong to the same industry (suggestions): name, the catalog domain it fits best, a quote and URL. The gate for a suggestion: it would appear as its own line in an RFP, a vendor sells it as a module or named product, and removing it would be noticed. Anything smaller is a FEATURE of an existing catalog capability — do not suggest it (it belongs in that capability's evidence instead). Names are vendor-neutral: never a product, brand or marketing name, always the generic capability (e.g. "MCP server for external AI agents", not "Agent471"). When no catalog domain fits, name a NEW domain instead (short, title case, the kind of name the catalog uses) and give its one-sentence definition in newDomainDescription; otherwise leave newDomainDescription empty. At most 8, one per distinct capability — never several wordings of the same thing; skip marketing claims and product names; skip anything that is a synonym of a catalog capability or of an already-suggested one (listed when there are any).

Judge only from the pages provided. The previous statuses are given for context: keep them when the new pages say nothing new about a capability (answer the previous value with its previous confidence), change them only on evidence.`;

export const CLASSIFY_TOOL = {
  name: "classify_capabilities",
  description: "Record the competitor's status on every catalog capability, plus suggested new capabilities.",
  input_schema: {
    type: "object" as const,
    properties: {
      statuses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            capability: { type: "string", description: "Exact catalog capability name." },
            value: { type: "string", enum: [...STATUS_VALUES] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            quote: { type: "string" },
            url: { type: "string" },
            product: { type: "string", description: "The competitor's product/module that provides it, or empty." },
            summary: { type: "string", description: "One sentence on what they now offer for it, only when the status changed; else empty." },
          },
          required: ["capability", "value", "confidence", "quote", "url", "product", "summary"],
        },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            domain: { type: "string", description: "A catalog domain name, or a new domain name when none fits." },
            newDomainDescription: { type: "string", description: "One sentence defining the new domain; empty when domain is a catalog domain." },
            quote: { type: "string" },
            url: { type: "string" },
          },
          required: ["name", "domain", "newDomainDescription", "quote", "url"],
        },
      },
    },
    required: ["statuses", "suggestions"],
  },
};

export interface CatalogForAi {
  domains: { name: string; description: string; capabilities: { name: string; description: string }[] }[];
}
export interface PreviousStatus { capability: string; value: StatusValue; confidence: number | null }
export interface ClassifiedStatus { capability: string; value: StatusValue; confidence: number; quote: string; url: string; product: string; /** One-sentence digest of the change, when the status moved; "" otherwise. */ summary: string }
/** `newDomain` is set when the domain is not in the catalog: the AI proposes it with a one-sentence definition. */
export interface Suggestion { name: string; domain: string; quote: string; url: string; newDomain: { description: string } | null }
export interface Classification { statuses: ClassifiedStatus[]; suggestions: Suggestion[] }

export function renderCatalog(c: CatalogForAi): string {
  return c.domains
    .map((d) => `DOMAIN: ${d.name}${d.description ? `\n${d.description.trim()}` : ""}\nCAPABILITIES:\n${d.capabilities.map((k) => `- ${k.name}${k.description ? ` — ${k.description}` : ""}`).join("\n")}`)
    .join("\n\n");
}

/** Presence evidence outranks absence evidence; "unknown" never wins over a value. */
const STATUS_RANK: Record<StatusValue, number> = { has: 3, partial: 2, missing: 1, unknown: 0 };

/**
 * Merge two answers about one capability from different chunks of pages:
 * the higher-ranked value wins; on a tie the more confident one. A page that
 * does not mention a capability says nothing about it, so a "missing" from
 * one chunk does not undo a "has" quoted from another.
 */
export function mergeStatus(a: ClassifiedStatus, b: ClassifiedStatus): ClassifiedStatus {
  const ra = STATUS_RANK[a.value];
  const rb = STATUS_RANK[b.value];
  const win = rb > ra || (rb === ra && b.confidence > a.confidence) ? b : a;
  const other = win === a ? b : a;
  return { ...win, product: win.product || other.product };
}

export const MAX_SUGGESTIONS = 20;

export async function classifyCapabilities(
  competitorName: string,
  catalog: CatalogForAi,
  previous: PreviousStatus[],
  /** Suggestions already waiting for the team's review: not to be suggested again, in any wording. */
  alreadySuggested: string[],
  pages: PageText[],
  onChunk?: (done: number, total: number) => void,
  /** TEST KNOB: the model's raw answer, see callTool. */
  injected?: string,
): Promise<AiResult<Classification>> {
  const shared = `CAPABILITY CATALOG:\n\n${renderCatalog(catalog)}`;
  const names = new Map<string, string>();
  for (const d of catalog.domains) for (const k of d.capabilities) names.set(k.name.toLowerCase(), k.name);
  const domainNames = new Map(catalog.domains.map((d) => [d.name.toLowerCase(), d.name]));
  const merged = new Map<string, ClassifiedStatus>();
  const suggestions = new Map<string, Suggestion>();
  const chunks = chunkPages(pages);
  let calls = 0;
  let usage: unknown = null;
  for (const [i, chunk] of chunks.entries()) {
    // Later chunks see what earlier chunks (and the last scan) established.
    const known: PreviousStatus[] = previous.map((p) => merged.get(p.capability) ?? p);
    for (const s of merged.values()) if (!known.some((k) => k.capability === s.capability)) known.push(s);
    const prev = known.length
      ? `PREVIOUS STATUSES (from the last scan and earlier pages of this one):\n${known.map((p) => `- ${p.capability}: ${p.value}${p.confidence != null ? ` (${p.confidence.toFixed(2)})` : ""}`).join("\n")}\n\n`
      : "";
    const pending = [...alreadySuggested, ...[...suggestions.values()].map((s) => s.name)];
    const pendingKeys = new Set(pending.map((n) => n.toLowerCase()));
    const sug = pending.length
      ? `ALREADY SUGGESTED (awaiting the team's review — do not suggest these again, nor rewordings, narrower or broader versions of them):\n${pending.map((n) => `- ${n}`).join("\n")}\n\n`
      : "";
    const tail = `COMPETITOR: ${competitorName}\n\n${prev}${sug}PAGES${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ""}:\n\n${packPages(chunk)}`;
    const r = await callTool<Record<string, unknown>>(CLASSIFY_SYSTEM_PROMPT, shared, tail, CLASSIFY_TOOL, 8000, injected);
    calls += r.calls;
    usage = r.usage;
    const seen = new Set<string>();
    for (const s of arr(r.value.statuses)) {
      const o = (s ?? {}) as Record<string, unknown>;
      const name = names.get(str(o.capability, 120).toLowerCase());
      const value = str(o.value, 20) as StatusValue;
      if (!name || seen.has(name) || !(STATUS_VALUES as readonly string[]).includes(value)) continue;
      seen.add(name);
      const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
      const cur: ClassifiedStatus = { capability: name, value, confidence: conf, quote: value === "unknown" ? "" : str(o.quote, 240), url: value === "unknown" ? "" : str(o.url, 500), product: value === "unknown" ? "" : str(o.product, 80), summary: value === "unknown" ? "" : str(o.summary, 300) };
      const before = merged.get(name);
      merged.set(name, before ? mergeStatus(before, cur) : cur);
    }
    for (const s of arr(r.value.suggestions)) {
      const o = (s ?? {}) as Record<string, unknown>;
      const rawDomain = str(o.domain, 60);
      const known = domainNames.get(rawDomain.toLowerCase());
      const sug: Suggestion = { name: str(o.name, 80), domain: known ?? rawDomain, quote: str(o.quote, 240), url: str(o.url, 500), newDomain: known || !rawDomain ? null : { description: str(o.newDomainDescription, 300) } };
      const key = sug.name.toLowerCase();
      if (!sug.name || !sug.domain || names.has(key) || pendingKeys.has(key)) continue;
      if (!suggestions.has(key) && suggestions.size < MAX_SUGGESTIONS) suggestions.set(key, sug);
    }
    onChunk?.(i + 1, chunks.length);
  }
  return { value: { statuses: [...merged.values()], suggestions: [...suggestions.values()] }, usage, calls };
}

// ————— 2. Lean-profile facts —————

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
