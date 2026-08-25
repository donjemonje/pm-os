import { generateVertexText } from "./vertex";

export type GenerateTextOptions = {
  systemInstruction?: string;
  cacheTtlMs?: number;
  /**
   * Isolation key for the response cache (typically the organization's
   * workspace id). Responses are only ever reused within the same scope, so
   * one organization can never receive another organization's cached answer.
   */
  cacheScope?: string;
  /**
   * Override the configured model for this call (e.g. a cheaper/faster model
   * for routing steps). Falls back to the provider's configured model.
   */
  model?: string;
};

/** All text generation goes through Vertex (Claude or Gemini models). */
export async function generateText(
  prompt: string,
  options?: GenerateTextOptions
): Promise<string> {
  return generateVertexText(prompt, options);
}

export { generateVertexText } from "./vertex";
