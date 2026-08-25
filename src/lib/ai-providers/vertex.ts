import { createHash } from "crypto";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleGenAI } from "@google/genai";
import {
  getAiProvider,
  isQuotaExhausted,
  isRateLimitError,
  parseRetryAfterSec,
  toAiQuotaError,
} from "../ai-config";
import {
  getVertexLocation,
  getVertexModel,
  getVertexProjectId,
  isVertexEnabled,
} from "../vertex-config";

const REQUEST_GAP_MS = Number(
  process.env.AI_MIN_REQUEST_GAP_MS ?? process.env.VERTEX_MIN_REQUEST_GAP_MS ?? 2500
);
const MAX_RETRIES = Number(
  process.env.AI_MAX_RETRIES ?? process.env.VERTEX_MAX_RETRIES ?? 1
);
const RETRY_BASE_MS = Number(
  process.env.AI_RETRY_BASE_MS ?? process.env.VERTEX_RETRY_BASE_MS ?? 2000
);
const MAX_OUTPUT_TOKENS = Number(process.env.VERTEX_MAX_TOKENS ?? 1400);
// Gemini models (especially the 3.x "thinking" family) can spend output tokens
// on reasoning, so give them a more generous budget to avoid empty responses.
const GEMINI_MAX_OUTPUT_TOKENS = Number(process.env.VERTEX_GEMINI_MAX_TOKENS ?? 8192);

let anthropicClient: AnthropicVertex | null = null;
let anthropicKey = "";
let geminiClient: GoogleGenAI | null = null;
let geminiKey = "";
let serialQueue: Promise<unknown> = Promise.resolve();
let nextAllowedAt = 0;
const responseCache = new Map<string, { expiresAt: number; value: string }>();

/** Whether the configured Vertex model is a Google Gemini model (vs Anthropic Claude). */
function isGeminiModel(model: string): boolean {
  return /^gemini/i.test(model);
}

function getAnthropicClient(): AnthropicVertex {
  const projectId = getVertexProjectId();
  const region = getVertexLocation();
  const key = `${projectId}|${region}`;
  if (!anthropicClient || anthropicKey !== key) {
    anthropicClient = new AnthropicVertex({ projectId, region });
    anthropicKey = key;
  }
  return anthropicClient;
}

function getGeminiClient(): GoogleGenAI {
  const project = getVertexProjectId();
  const location = getVertexLocation();
  const key = `${project}|${location}`;
  if (!geminiClient || geminiKey !== key) {
    geminiClient = new GoogleGenAI({ vertexai: true, project, location });
    geminiKey = key;
  }
  return geminiClient;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCacheKey(
  model: string,
  cacheScope: string | undefined,
  systemInstruction: string | undefined,
  prompt: string
): string {
  const hash = createHash("sha1");
  hash.update("vertex");
  hash.update(model);
  hash.update(cacheScope ?? "global");
  hash.update("\u0000");
  hash.update(systemInstruction ?? "");
  hash.update("\u0000");
  hash.update(prompt);
  return hash.digest("hex");
}

async function withThrottle<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextAllowedAt = Date.now() + REQUEST_GAP_MS;
    return task();
  };
  const next = serialQueue.then(run, run);
  serialQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function generateVertexText(
  prompt: string,
  options?: { systemInstruction?: string; cacheTtlMs?: number; cacheScope?: string; model?: string }
): Promise<string> {
  if (!isVertexEnabled()) {
    throw new Error(
      "Gemini Enterprise Agent Platform (Vertex) is disabled. Set VERTEX_PROJECT_ID and Google credentials, or switch AI_PROVIDER."
    );
  }

  const model = options?.model?.trim() || getVertexModel();
  const cacheTtl = options?.cacheTtlMs ?? Number(process.env.AI_CACHE_TTL_MS ?? 600000);
  const cacheKey = makeCacheKey(model, options?.cacheScope, options?.systemInstruction, prompt);
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await withThrottle(async () => {
        if (isGeminiModel(model)) {
          const response = await getGeminiClient().models.generateContent({
            model,
            contents: prompt,
            config: {
              temperature: 0.2,
              maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
              ...(options?.systemInstruction
                ? { systemInstruction: options.systemInstruction }
                : {}),
            },
          });
          return (response.text ?? "").trim();
        }

        // No temperature: the Claude 5 family rejects the parameter outright
        // ("temperature is deprecated for this model").
        const message = await getAnthropicClient().messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(options?.systemInstruction
            ? { system: options.systemInstruction }
            : {}),
          messages: [{ role: "user", content: prompt }],
        });
        return message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
      });

      if (!text) throw new Error("Vertex returned an empty response");

      if (cacheTtl > 0) {
        responseCache.set(cacheKey, {
          expiresAt: Date.now() + cacheTtl,
          value: text,
        });
      }
      return text;
    } catch (error) {
      lastError = error;
      if (isQuotaExhausted(error)) {
        throw toAiQuotaError(error, getAiProvider());
      }
      if (!isRateLimitError(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      const retryAfter = parseRetryAfterSec(error) ?? RETRY_BASE_MS / 1000;
      await sleep(retryAfter * 1000 + Math.floor(Math.random() * 500));
    }
  }

  throw lastError ?? new Error("Vertex request failed");
}
