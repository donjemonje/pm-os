import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getVertexLocation, getVertexProjectId } from "../vertex-config";
import { ledgerKey, recordVerdict } from "./ledger";
import type { JiraSource } from "./types";

/**
 * Match stage: decide, for each cataloged feature request, whether it is the
 * same idea as one already in the Jira ideas backlog (PRD step 3). A matched
 * FR merges into the existing idea as evidence instead of becoming a new
 * idea; the model may also propose an enriched summary when the FR adds real
 * context. Like the catalog stage, every judgment is appended to the ledger —
 * nothing is replayed or forced.
 */

export const MATCH_PROMPT_VERSION = "match-v1";

/** Bump IDEAS_MATCH_MODEL in env to change; recorded on every ledger row. */
function getMatchModel(): string {
  return process.env.IDEAS_MATCH_MODEL?.trim() || "claude-opus-5";
}

const SYSTEM_PROMPT = `You match an incoming feature request against a product team's existing Jira ideas backlog.

You are given ONE feature request (a product-voiced title and summary, plus the original support-ticket text) and the full list of existing backlog ideas, each with a key, title, and description.

Decide whether the request asks for the same capability as one existing idea:
- A match means the same underlying capability and need — a customer voting for something already in the backlog. Different wording, narrower phrasing, or extra detail do not prevent a match when the capability is the same.
- Related is NOT matched: same product area but a different capability, a complement, or a prerequisite is not a match.
- When torn between two ideas, pick the single best one; when no idea clearly fits, return no match. Never force a match.

If (and only if) the request matches, also judge enrichment: does the request add real context the idea's description lacks (a concrete use case, a constraint, a sharper articulation of the need)? If yes, write enriched_summary — 2-4 sentences of neutral product language: the existing idea's description, sharpened with the new context. It replaces the description, so it must stand alone and keep everything still true from the original. If the request adds nothing beyond a vote, return an empty enriched_summary.

Return the matched idea's key EXACTLY as listed, or an empty string for no match. Give a single short sentence of reasoning.`;

const MATCH_TOOL = {
  name: "match_feature_request",
  description: "Record the match verdict for one feature request against the ideas backlog.",
  input_schema: {
    type: "object" as const,
    properties: {
      matched_key: {
        type: "string",
        description:
          "Key of the single backlog idea this request duplicates, exactly as listed. Empty string when no idea matches.",
      },
      enriched_summary: {
        type: "string",
        description:
          "Only when matched AND the request adds real context: 2-4 sentence replacement description in neutral product language. Empty string otherwise.",
      },
      reason: {
        type: "string",
        description: "One short sentence explaining the match or non-match.",
      },
    },
    required: ["matched_key", "enriched_summary", "reason"],
  },
};

export interface MatchInput {
  key: string;
  subject: string;
  body: string;
  /** Product-voiced rewrite from the catalog stage. */
  productTitle: string;
  productSummary: string;
}

export interface MatchResult {
  key: string;
  /** Validated against the provided backlog; null = no match. */
  matchedKey: string | null;
  enrichedSummary: string;
  reason: string;
}

let client: AnthropicVertex | null = null;
let clientKey = "";
function getClient(): AnthropicVertex {
  const projectId = getVertexProjectId();
  const region = getVertexLocation();
  const key = `${projectId}|${region}`;
  if (!client || clientKey !== key) {
    client = new AnthropicVertex({ projectId, region });
    clientKey = key;
  }
  return client;
}

/** Deterministic cap on backlog descriptions so the rendered ask stays stable. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function renderBacklog(ideas: JiraSource[]): string {
  const lines = ideas.map((s) =>
    [`[${s.key}] ${s.title}`, clip(s.body || "(no description)", 800)].join("\n")
  );
  return `EXISTING IDEAS BACKLOG:\n\n${lines.join("\n\n")}`;
}

function renderUserMessage(input: MatchInput, backlog: string): string {
  return [
    backlog,
    [
      "FEATURE REQUEST",
      `Title: ${input.productTitle || input.subject}`,
      `Summary: ${input.productSummary || "(none)"}`,
      "",
      "Original ticket:",
      `Subject: ${input.subject}`,
      `Body: ${input.body || "(empty)"}`,
    ].join("\n"),
  ].join("\n\n");
}

export interface MatchBatchResult {
  results: MatchResult[];
  model: string;
  promptVersion: string;
  called: number;
}

/**
 * Match a batch of feature requests against the live Jira ideas backlog.
 * With an empty backlog no model is called — every FR is a non-match.
 * Backlog order is pinned by key so identical inputs render identical asks.
 */
export async function matchTickets(
  workspaceId: string,
  inputs: MatchInput[],
  backlog: JiraSource[]
): Promise<MatchBatchResult> {
  const model = getMatchModel();
  if (inputs.length === 0 || backlog.length === 0) {
    return {
      results: inputs.map((i) => ({ key: i.key, matchedKey: null, enrichedSummary: "", reason: "" })),
      model,
      promptVersion: MATCH_PROMPT_VERSION,
      called: 0,
    };
  }

  const sorted = [...backlog].sort((a, b) => a.key.localeCompare(b.key));
  const backlogKeys = new Set(sorted.map((s) => s.key));
  const rendered = renderBacklog(sorted);

  const results: MatchResult[] = [];
  for (const input of inputs) {
    const userMessage = renderUserMessage(input, rendered);
    const message = await getClient().messages.create({
      model,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      tools: [MATCH_TOOL],
      tool_choice: { type: "tool", name: "match_feature_request" },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Match model returned no verdict");
    }
    const raw = toolUse.input as {
      matched_key?: unknown;
      enriched_summary?: unknown;
      reason?: unknown;
    };
    const verdict = {
      matchedKey: typeof raw.matched_key === "string" ? raw.matched_key.trim() : "",
      enrichedSummary:
        typeof raw.enriched_summary === "string" ? raw.enriched_summary.trim() : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
    const ledgerInput = { system: SYSTEM_PROMPT, user: userMessage };
    await recordVerdict(
      workspaceId,
      ledgerKey("match", MATCH_PROMPT_VERSION, model, ledgerInput),
      {
        stage: "match",
        promptVersion: MATCH_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict,
      }
    );
    // The ledger keeps the verdict as returned; the pipeline only acts on
    // keys that exist in the backlog it was shown.
    results.push({
      key: input.key,
      matchedKey: backlogKeys.has(verdict.matchedKey) ? verdict.matchedKey : null,
      enrichedSummary: verdict.enrichedSummary,
      reason: verdict.reason,
    });
  }

  return { results, model, promptVersion: MATCH_PROMPT_VERSION, called: inputs.length };
}
