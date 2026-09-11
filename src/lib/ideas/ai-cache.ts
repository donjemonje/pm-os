import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getVertexProjectId } from "../vertex-config";
import { anthropicUsage, type StageHooks } from "./trace";

/**
 * Prompt caching for the Anthropic stages. Every call of a stage shares a
 * long prefix — tools, system prompt, idea template, catalogs, candidate
 * list — and only the per-ticket tail differs. The prefix is sent as its
 * own content block with a cache breakpoint, so the provider bills it as a
 * cached read on every call but the first.
 *
 * Measured on Vertex (2026-09-11, claude-opus-5): a cache entry becomes
 * readable a few seconds AFTER the writing request completes — ~6s on the
 * "us" multi-region endpoint, ~9s on "eu", ~30s on "global"; single regions
 * have no quota for the model. So the Ideas stages use a multi-region
 * endpoint ("eu" by default — the design partner is in Israel), each prefix
 * is warmed by one tiny request, and a wave only fires once the entry has
 * settled. Prefixes known at import start (template + catalogs) are warmed
 * while the Gemini parse runs, at no latency cost; the match prefix (it
 * includes every unit of the import) can only be warmed after split.
 *
 * IDEAS_PROMPT_CACHE=off sends plain blocks and skips warm-ups (A/B, or if
 * the provider misbehaves); IDEAS_VERTEX_LOCATION overrides the region.
 */

type CreateParams = Parameters<AnthropicVertex["messages"]["create"]>[0];

const EPHEMERAL = { type: "ephemeral" as const };

/** Measured time between a warm-up completing and its entry being readable. */
const SETTLE_MS_BY_REGION: Record<string, number> = { us: 6000, eu: 9000 };
const SETTLE_MS_DEFAULT = 30000;

export function cacheSettleMs(): number {
  return SETTLE_MS_BY_REGION[getIdeasVertexLocation()] ?? SETTLE_MS_DEFAULT;
}

export function promptCacheOn(): boolean {
  const v = process.env.IDEAS_PROMPT_CACHE?.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
}

/** Region for the Ideas stages — a multi-region endpoint with fast cache propagation. */
export function getIdeasVertexLocation(): string {
  return process.env.IDEAS_VERTEX_LOCATION?.trim() || "eu";
}

let client: AnthropicVertex | null = null;
let clientKey = "";
/** One shared Vertex client for the Anthropic stages. */
export function getIdeasClient(): AnthropicVertex {
  const projectId = getVertexProjectId();
  const region = getIdeasVertexLocation();
  const key = `${projectId}|${region}`;
  if (!client || clientKey !== key) {
    client = new AnthropicVertex({ projectId, region });
    clientKey = key;
  }
  return client;
}

/** The user turn as [cached prefix][per-call tail]; the rendered text is `${shared}\n\n${tail}`. */
export function prefixedUserMessage(
  shared: string,
  tail: string,
): CreateParams["messages"] {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: shared,
          ...(promptCacheOn() ? { cache_control: EPHEMERAL } : {}),
        },
        { type: "text", text: `\n\n${tail}` },
      ],
    },
  ];
}

export interface PrefixParams {
  model: string;
  system: string;
  tools: CreateParams["tools"];
  tool_choice: CreateParams["tool_choice"];
  shared: string;
}

/**
 * Warms prefixes and holds a wave until its entry is readable. One per
 * import; stage modules call `ensure` (a no-op when the store warmed the
 * key earlier) and then `ready`.
 */
export class PrefixWarmer {
  /** key → resolves to the time the warm-up completed. */
  private readonly entries = new Map<string, Promise<number>>();

  constructor(private readonly hooks?: StageHooks) {}

  /** Start warming `key` unless already started. Never throws here — `ready` does. */
  ensure(key: string, params: PrefixParams, hooks?: StageHooks): void {
    if (!promptCacheOn() || this.entries.has(key)) return;
    const h = hooks ?? this.hooks;
    const aiStart = performance.now();
    // A few output tokens: a one-token forced-tool request is oddly slow
    // (6s vs 2s measured); the tool_choice must match the real calls or the
    // message cache is keyed differently.
    const p = getIdeasClient()
      .messages.create({
        model: params.model,
        max_tokens: 8,
        system: params.system,
        tools: params.tools,
        tool_choice: params.tool_choice,
        messages: prefixedUserMessage(params.shared, "(cache warm-up)"),
      })
      .then((message) => {
        h?.call({
          aiMs: performance.now() - aiStart,
          tokens: anthropicUsage(message.usage),
          warmup: true,
        });
        return Date.now();
      });
    // Surfaced by `ready`; without this an unawaited rejection would crash.
    p.catch(() => undefined);
    this.entries.set(key, p);
  }

  /** Resolve once `key`'s entry is readable (warm-up done + settle time). */
  async ready(key: string): Promise<void> {
    const p = this.entries.get(key);
    if (!p) return;
    const completedAt = await p;
    const wait = cacheSettleMs() - (Date.now() - completedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
