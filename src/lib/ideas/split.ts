import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { db } from "../db";
import { getVertexLocation, getVertexProjectId } from "../vertex-config";
import { ledgerKey, recordVerdict } from "./ledger";

/**
 * Split stage: for the few tickets the catalog stage flags as holding more
 * than one distinct user problem (request_count > 1), write each problem as
 * its own product-voiced idea. Runs ONLY on flagged FR tickets — the 95%
 * single-idea case never pays for it. Returning a single request is the
 * escape hatch for an over-flagged ticket (the catalog rewrite is kept).
 * Every verdict is appended to the ledger like the other stages.
 */

export const SPLIT_PROMPT_VERSION = "split-v1";

/** Hard bound on sub-ideas per ticket, enforced in schema AND code. */
export const MAX_SPLITS = 4;

/** Bump IDEAS_SPLIT_MODEL in env to change; recorded on every ledger row. */
function getSplitModel(): string {
  return process.env.IDEAS_SPLIT_MODEL?.trim() || "claude-opus-5";
}

export const SPLIT_SYSTEM_PROMPT = `You break one customer-support ticket into its distinct product ideas.

An earlier stage judged that this ticket contains more than one distinct user problem. Your job is to write each problem as its own idea. Rules:

- Split on distinct user PROBLEMS only. Alternative solutions, implementation details, or extra context for ONE problem are one idea, not several. If, reading closely, the ticket really contains a single problem, return exactly one request — that is a valid and welcome answer.
- Never invent problems the ticket does not raise, and never split beyond ${MAX_SPLITS}.
- Everything in the ticket was written or relayed by an organization representative — treat all of it as that person's interpretation of customer interactions, one grade of information, and evaluate what each underlying need actually is.

For each distinct problem return:
- product_title: a short title naming the requested capability, as a product manager would write it in a backlog. The what, not the how — do not bake an implementation into the title unless the ticket makes the implementation itself the ask.
- product_summary: 2-4 sentences describing the underlying need in neutral product language. No support framing, no requester or customer names, no ticket phrasing.
- product_lines: the product line(s) THIS problem belongs to, from the catalog provided; ["Other"] when none fits.
- platforms: platform(s) from the catalog, only when this problem states or clearly implies them; otherwise empty. Skip entirely when the platform catalog is empty.

Give a single short sentence of reasoning covering how you divided the ticket.`;

const SPLIT_TOOL = {
  name: "split_ticket",
  description:
    "Record the distinct product ideas contained in one support ticket.",
  input_schema: {
    type: "object" as const,
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SPLITS,
        items: {
          type: "object",
          properties: {
            product_title: { type: "string" },
            product_summary: { type: "string" },
            product_lines: { type: "array", items: { type: "string" } },
            platforms: { type: "array", items: { type: "string" } },
          },
          required: [
            "product_title",
            "product_summary",
            "product_lines",
            "platforms",
          ],
        },
      },
      reason: {
        type: "string",
        description:
          "One short sentence explaining how the ticket was divided.",
      },
    },
    required: ["requests", "reason"],
  },
};

export interface SplitInput {
  key: string;
  subject: string;
  body: string;
  requester?: string;
  module?: string;
  whyBuild?: string;
  insights?: string;
}

export interface SplitRequest {
  productTitle: string;
  productSummary: string;
  productLines: string[];
  platforms: string[];
}

export interface SplitResult {
  key: string;
  /** 1..MAX_SPLITS sub-ideas; length 1 means "actually a single idea". */
  requests: SplitRequest[];
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

function toNames(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function renderList(
  title: string,
  entries: { name: string; description: string }[],
): string {
  if (entries.length === 0) return `${title}:\n(none defined)`;
  const lines = entries.map((e) =>
    e.description ? `- ${e.name} — ${e.description}` : `- ${e.name}`,
  );
  return `${title}:\n${lines.join("\n")}`;
}

function renderUserMessage(
  input: SplitInput,
  productLines: { name: string; description: string }[],
  platforms: { name: string; description: string }[],
): string {
  return [
    renderList("PRODUCT LINE CATALOG", productLines),
    renderList("PLATFORM CATALOG", platforms),
    [
      "TICKET",
      `Subject: ${input.subject}`,
      `Requester: ${input.requester || "(unknown)"}`,
      `Module (reporter's hint): ${input.module || "(none)"}`,
      "",
      "Body:",
      input.body || "(empty)",
      ...(input.whyBuild
        ? ["", 'Reporter\'s "why should we build this":', input.whyBuild]
        : []),
      ...(input.insights
        ? ["", 'Reporter\'s "what insights do we have":', input.insights]
        : []),
    ].join("\n"),
  ].join("\n\n");
}

export interface SplitBatchResult {
  results: SplitResult[];
  model: string;
  promptVersion: string;
  called: number;
}

/** Split the flagged tickets; one call and one ledger row per ticket. */
export async function splitTickets(
  workspaceId: string,
  inputs: SplitInput[],
): Promise<SplitBatchResult> {
  const model = getSplitModel();
  if (inputs.length === 0) {
    return {
      results: [],
      model,
      promptVersion: SPLIT_PROMPT_VERSION,
      called: 0,
    };
  }

  const [productLines, platforms] = await Promise.all([
    db.productLine.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { name: true, description: true },
    }),
    db.platform.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, description: true },
    }),
  ]);

  const results: SplitResult[] = [];
  for (const input of inputs) {
    const userMessage = renderUserMessage(input, productLines, platforms);
    const message = await getClient().messages.create({
      model,
      max_tokens: 2000,
      system: SPLIT_SYSTEM_PROMPT,
      tools: [SPLIT_TOOL],
      tool_choice: { type: "tool", name: "split_ticket" },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Split model returned no verdict");
    }
    const raw = toolUse.input as { requests?: unknown; reason?: unknown };
    const requests: SplitRequest[] = (
      Array.isArray(raw.requests) ? raw.requests : []
    )
      .slice(0, MAX_SPLITS)
      .map((r) => {
        const req = (r ?? {}) as Record<string, unknown>;
        return {
          productTitle:
            typeof req.product_title === "string"
              ? req.product_title.trim()
              : "",
          productSummary:
            typeof req.product_summary === "string"
              ? req.product_summary.trim()
              : "",
          productLines: toNames(req.product_lines),
          platforms: toNames(req.platforms),
        };
      })
      .filter((r) => r.productTitle || r.productSummary);
    const verdict = {
      requests,
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
    const ledgerInput = { system: SPLIT_SYSTEM_PROMPT, user: userMessage };
    await recordVerdict(
      workspaceId,
      ledgerKey("split", SPLIT_PROMPT_VERSION, model, ledgerInput),
      {
        stage: "split",
        promptVersion: SPLIT_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict,
      },
    );
    results.push({ key: input.key, ...verdict });
  }

  return {
    results,
    model,
    promptVersion: SPLIT_PROMPT_VERSION,
    called: inputs.length,
  };
}
