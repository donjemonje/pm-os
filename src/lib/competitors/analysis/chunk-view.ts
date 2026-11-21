import { READ_ORDER } from "./sections";
import type { Unexplained } from "./reading";

/**
 * A reading request as Administration → Competitors shows it (the record is CompetitorChunk, written by
 * analysis/read-step.ts): which pages it held, what it cost, what its answer did.
 *
 * Pure: no database, no network.
 */

export interface ChunkView {
  id: string;
  /** The run that made the request. */
  analysisId: string;
  /** 1 … — its place among the requests of that run for the company. */
  position: number;
  /** "list" (the company's whole list) | "changes" (what its pages change in the list so far). */
  kind: string;
  pages: number;
  /** "40 release notes, 210 help" — its pages by kind, in reading order. */
  kinds: string;
  /** Tokens of its text as estimated before the call (characters / 4). */
  tokens: number;
  firstUrl: string;
  lastUrl: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  seconds: number;
  /** "the list: 42 capabilities, 180 features" or "+2 capabilities, +27 features, 3 corrections, 0 removed → 44 / 207". */
  did: string;
  incidents: number;
  unexplained: number;
  at: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const s = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;

/** "40 release notes, 210 help, 12 pricing" — pages per kind, in the "where a PM looks" order; kinds outside it last. */
export function kindsText(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const counts = raw as Record<string, unknown>;
  const order = [...READ_ORDER.map(String), ...Object.keys(counts).filter((k) => !(READ_ORDER as readonly string[]).includes(k)).sort()];
  return order.filter((k) => num(counts[k]) > 0).map((k) => `${num(counts[k]).toLocaleString("en-US")} ${k.replace(/_/g, " ")}`).join(", ");
}

/** What a request's answer did, in one line. */
export function resultText(kind: string, raw: unknown): string {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const size = `${s(num(r.capabilities), "capability", "capabilities")}, ${s(num(r.features), "feature")}`;
  if (kind === "list") return `the list: ${size}`;
  return `+${s(num(r.newCapabilities), "capability", "capabilities")}, +${s(num(r.newFeatures), "feature")}, ${s(num(r.corrections), "correction")}, ${num(r.removed).toLocaleString("en-US")} removed → ${size}`;
}

/** The labels a request reported as seen but not explained (a Json column), checked entry by entry. */
export function readUnexplained(raw: unknown): Unexplained[] {
  if (!Array.isArray(raw)) return [];
  const out: Unexplained[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.label !== "string" || !o.label.trim()) continue;
    out.push({ label: o.label, url: typeof o.url === "string" && o.url ? o.url : null });
  }
  return out;
}

export interface ChunkRow {
  id: string;
  analysisId: string;
  position: number;
  kind: string;
  pages: number;
  tokens: number;
  kinds: unknown;
  firstUrl: string;
  lastUrl: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  ms: number;
  result: unknown;
  unexplained: unknown;
  createdAt: Date;
}

export function chunkView(c: ChunkRow): ChunkView {
  const r = (c.result && typeof c.result === "object" && !Array.isArray(c.result) ? c.result : {}) as Record<string, unknown>;
  return {
    id: c.id, analysisId: c.analysisId, position: c.position, kind: c.kind, pages: c.pages, kinds: kindsText(c.kinds), tokens: c.tokens, firstUrl: c.firstUrl, lastUrl: c.lastUrl, model: c.model,
    inputTokens: c.inputTokens, outputTokens: c.outputTokens, thinkingTokens: c.thinkingTokens, seconds: Math.round(c.ms / 1000), did: resultText(c.kind, c.result), incidents: num(r.incidents), unexplained: readUnexplained(c.unexplained).length, at: c.createdAt.toISOString(),
  };
}

/** The select of a CompetitorChunk row a view needs. */
export const CHUNK_SELECT = { id: true, analysisId: true, position: true, kind: true, pages: true, tokens: true, kinds: true, firstUrl: true, lastUrl: true, model: true, inputTokens: true, outputTokens: true, thinkingTokens: true, ms: true, result: true, unexplained: true, createdAt: true } as const;
