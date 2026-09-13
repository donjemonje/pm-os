import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiLocation, getVertexProjectId } from "../vertex-config";
import { ledgerKey, recordVerdict } from "./ledger";
import { geminiUsage, type StageHooks } from "./trace";

/**
 * AI field parsing (Gemini): the customer columns of a support export are
 * free text typed by humans — lists, qualifiers ("submitted by X", "and
 * prospect Y", "Solvantis and more"), and all-customers markers. Instead of
 * trusting separator splits, the raw cell values of an import are parsed in
 * ONE cheap Gemini call into clean customer names plus an "affects all
 * customers" flag. Gated per org by ideasConfig.fieldParsing.customers
 * (default ON); off = the legacy deterministic split. Every call is
 * appended to the ledger like the Anthropic stages.
 */

export const PARSE_PROMPT_VERSION = "parse-v1";

/** IDEAS_PARSE_MODEL > GEMINI_MODEL > a known-good Flash default. */
function getParseModel(): string {
  return (
    process.env.IDEAS_PARSE_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-2.5-flash"
  );
}

export const PARSE_SYSTEM_PROMPT = `You clean values that humans typed into the customer-name fields of support tickets.

Each input value may contain: one customer name, several names in one string, qualifiers around a name, or a marker meaning "all customers". For each value return:
- names: the actual customer names contained in the value, exactly as written (keep original casing and punctuation). Strip surrounding prose and qualifiers — "submitted by The Whitfield Group" is the customer "The Whitfield Group"; "and prospect EnerSul" is "EnerSul"; "Solvantis and more" is "Solvantis". Company names can look odd ("84Shield", "RiverMark Inc.") — oddness alone never disqualifies a name. Never invent a name that is not present in the value; when a value contains no actual name (e.g. "various", "unknown"), return an empty list.
- all: true when the value says or clearly means that all customers are affected ("All customers", "everyone", "all clients"). It is OK — and common — for a value to be all=true with an empty names list, or all=true alongside specific names ("All customers; submitted by The Whitfield Group" → all=true, names=["The Whitfield Group"]).

Return one result per input value, in the same order, with raw echoed exactly.`;

export interface ParsedCell {
  raw: string;
  names: string[];
  all: boolean;
}

export interface ParseBatchResult {
  /** Keyed by the raw value, lowercased. */
  byRaw: Map<string, ParsedCell>;
  model: string;
  promptVersion: string;
  called: number;
}

let client: GoogleGenAI | null = null;
let clientKey = "";
function getClient(): GoogleGenAI {
  const project = getVertexProjectId();
  const location = getGeminiLocation();
  const key = `${project}|${location}`;
  if (!client || clientKey !== key) {
    client = new GoogleGenAI({ vertexai: true, project, location });
    clientKey = key;
  }
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          raw: { type: Type.STRING },
          names: { type: Type.ARRAY, items: { type: Type.STRING } },
          all: { type: Type.BOOLEAN },
        },
        required: ["raw", "names", "all"],
      },
    },
  },
  required: ["results"],
};

/**
 * Parse the unique customer-field values of one import in a single call.
 * Returns an empty map (zero calls) when there is nothing to parse.
 */
export async function parseCustomerCells(
  workspaceId: string,
  cells: string[],
  hooks?: StageHooks,
): Promise<ParseBatchResult> {
  const model = getParseModel();
  const unique = Array.from(
    new Map(cells.map((c) => [c.trim().toLowerCase(), c.trim()])).entries(),
  )
    .filter(([k]) => k)
    .map(([, v]) => v)
    .sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) {
    return {
      byRaw: new Map(),
      model,
      promptVersion: PARSE_PROMPT_VERSION,
      called: 0,
    };
  }

  const userMessage = `VALUES:\n${unique.map((v, i) => `${i + 1}. ${v}`).join("\n")}`;
  const aiStart = performance.now();
  const response = await getClient().models.generateContent({
    model,
    contents: userMessage,
    config: {
      systemInstruction: PARSE_SYSTEM_PROMPT,
      temperature: 0,
      // Gemini bills thinking against maxOutputTokens, so the two budgets
      // are sized together: thinking is kept (Daniel's call) but bounded,
      // and the output limit leaves room for the answer after it — a
      // truncated JSON array is what a 4000-token limit produced once.
      thinkingConfig: { thinkingBudget: 2048 },
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  const aiMs = performance.now() - aiStart;
  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(response.text ?? "");
  } catch {
    const text = response.text ?? "";
    const finish = response.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(
      `Field-parse model returned invalid JSON (finish: ${finish}, ${text.length} chars: ${JSON.stringify(text.slice(-120))})`,
    );
  }
  const results: ParsedCell[] = (
    Array.isArray(parsed.results) ? parsed.results : []
  ).map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      raw: typeof row.raw === "string" ? row.raw : "",
      names: Array.isArray(row.names)
        ? row.names.filter(
            (n): n is string => typeof n === "string" && !!n.trim(),
          )
        : [],
      all: row.all === true,
    };
  });

  const ledgerInput = { system: PARSE_SYSTEM_PROMPT, user: userMessage };
  const dbStart = performance.now();
  await recordVerdict(
    workspaceId,
    ledgerKey("parse", PARSE_PROMPT_VERSION, model, ledgerInput),
    {
      stage: "parse",
      promptVersion: PARSE_PROMPT_VERSION,
      model,
      input: ledgerInput,
      verdict: { results },
    },
  );
  hooks?.call({
    aiMs,
    dbMs: performance.now() - dbStart,
    tokens: geminiUsage(response.usageMetadata),
  });

  const byRaw = new Map<string, ParsedCell>();
  for (const r of results) {
    if (r.raw) byRaw.set(r.raw.trim().toLowerCase(), r);
  }
  // A value the model failed to echo falls back to itself as a single name —
  // same trust level as the legacy split, never silently dropped.
  for (const v of unique) {
    const k = v.toLowerCase();
    if (!byRaw.has(k)) byRaw.set(k, { raw: v, names: [v], all: false });
  }
  return { byRaw, model, promptVersion: PARSE_PROMPT_VERSION, called: 1 };
}
