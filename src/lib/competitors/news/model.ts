import type { ThinkingLevelName } from "../models";

/**
 * The model of the news prompts — the intake (news/intake.ts) and the table step (news/table-prompt-new-intake.ts).
 * Daniel 2026-11-22: the same as the analysis reading — gemini-4-carbon, thinking high. Its own setting, not a
 * borrowed role: the model of a new prompt is decided with Daniel, never inherited silently.
 * COMPETITORS_MODEL_NEWS overrides the model (a hand run comparing models).
 */
export const NEWS_MODEL_DEFAULT = "gemini-4-carbon";
export const NEWS_THINKING: ThinkingLevelName = "high";

export function newsModel(env: Record<string, string | undefined> = process.env): string {
  return env.COMPETITORS_MODEL_NEWS?.trim() || NEWS_MODEL_DEFAULT;
}
