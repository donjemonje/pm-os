import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getVertexProjectId } from "../vertex-config";

/**
 * The Vertex client for the competitors AI step — the same shape the Ideas
 * stages use (multi-region endpoint, cached shared prefix), kept separate so
 * the scanner job can load this module outside Next with Node's native type
 * stripping. Region: COMPETITORS_VERTEX_LOCATION, else the Ideas one, else "eu".
 */

type CreateParams = Parameters<AnthropicVertex["messages"]["create"]>[0];

export function getCompetitorsVertexLocation(): string {
  return process.env.COMPETITORS_VERTEX_LOCATION?.trim() || process.env.IDEAS_VERTEX_LOCATION?.trim() || "eu";
}

let client: AnthropicVertex | null = null;
let clientKey = "";

export function getCompetitorsClient(): AnthropicVertex {
  const projectId = getVertexProjectId();
  const region = getCompetitorsVertexLocation();
  const key = `${projectId}|${region}`;
  if (!client || clientKey !== key) {
    client = new AnthropicVertex({ projectId, region });
    clientKey = key;
  }
  return client;
}

/** The user turn as [cached shared prefix][per-call tail]. */
export function prefixedUserMessage(shared: string, tail: string): CreateParams["messages"] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: shared, cache_control: { type: "ephemeral" } },
        { type: "text", text: `\n\n${tail}` },
      ],
    },
  ];
}
