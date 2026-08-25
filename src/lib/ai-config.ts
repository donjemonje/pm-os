import { isVertexEnabled } from "./vertex-config";

export type AiProvider = "vertex";

export class AiQuotaError extends Error {
  readonly retryAfterSec?: number;

  constructor(message: string, retryAfterSec?: number) {
    super(message);
    this.name = "AiQuotaError";
    this.retryAfterSec = retryAfterSec;
  }
}

export function getAiProvider(): AiProvider {
  // Vertex (Claude or Gemini models) is the only provider.
  return "vertex";
}

export function isAiEnabled(): boolean {
  return isVertexEnabled();
}

export function shouldUseTemplateOnQuota(): boolean {
  return process.env.AI_USE_TEMPLATE_ON_QUOTA !== "false";
}

export function parseRetryAfterSec(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  if (match) return Math.ceil(Number(match[1]));
  return undefined;
}

export function isQuotaExhausted(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("quota exceeded") ||
    message.includes("exceeded your current quota") ||
    message.includes("limit: 0") ||
    message.includes("resource_exhausted") ||
    message.includes("insufficient_quota") ||
    message.includes("credit balance")
  );
}

export function isRateLimitError(error: unknown): boolean {
  if (isQuotaExhausted(error)) return true;
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: number; message?: string };
  if (err.status === 429) return true;
  const message = (err.message ?? "").toLowerCase();
  return message.includes("429") || message.includes("too many requests") || message.includes("rate limit");
}

export function toAiQuotaError(error: unknown, _provider: AiProvider = "vertex"): AiQuotaError {
  const retryAfterSec = parseRetryAfterSec(error);
  const base =
    "Vertex quota or rate limit hit. Check your GCP quotas for the configured model and retry.";
  return new AiQuotaError(
    retryAfterSec ? `${base} Retry in ~${retryAfterSec}s.` : base,
    retryAfterSec
  );
}

export function formatApiAiError(error: unknown): { message: string; status: number } {
  if (error instanceof AiQuotaError) {
    return { message: error.message, status: 429 };
  }
  if (isQuotaExhausted(error)) {
    const q = toAiQuotaError(error, getAiProvider());
    return { message: q.message, status: 429 };
  }
  return {
    message: error instanceof Error ? error.message : "AI request failed",
    status: 500,
  };
}
