import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { db } from "../db";
import { getVertexLocation, getVertexProjectId } from "../vertex-config";
import { ledgerKey, recordVerdict } from "./ledger";
import type { CatalogKind, CatalogVerdict } from "./types";

/**
 * Catalog stage: classify each raw Zendesk ticket as FR / Bug / Needs-details
 * and, for FRs, assign product line(s) and platform(s) from the workspace
 * catalogs (Settings → Ideas) and rewrite the ticket's subject/body as a
 * product-voiced title and summary for the resulting idea. Every run judges fresh; each judgment is
 * appended to the ledger so behavior can be audited and determinism measured,
 * but nothing is ever replayed or forced.
 */

export const CATALOG_PROMPT_VERSION = "catalog-v3";

/** Reserved product-line value for FRs no catalog line fits. */
export const OTHER_PRODUCT_LINE = "Other";

/** Bump IDEAS_CATALOG_MODEL in env to change; recorded on every ledger row. */
function getCatalogModel(): string {
  return process.env.IDEAS_CATALOG_MODEL?.trim() || "claude-opus-5";
}

const SYSTEM_PROMPT = `You catalog incoming customer-support tickets for a product team's discovery pipeline.

First, classify the ticket into exactly one kind:
- "fr" — a feature request: the customer asks for a capability or behavior the product does not currently offer. Requests for timelines on known planned work also count as feature requests.
- "bug" — the product misbehaves relative to what it is clearly meant to do. Watch for bugs phrased as feature requests: if the described situation is the product doing something wrong (incorrect data shown, broken output, degraded results), it is a bug regardless of how the customer worded the ask.
- "needs_details" — the ticket is too vague or underspecified to act on without going back to the requester.

Second, ONLY if the ticket is a feature request, assign it within the product:
- product_lines: which product line(s) the requested capability belongs to. Choose from the catalog provided in the message. Usually one; use several only when the request genuinely spans lines. If the ticket is a feature request but no catalog line fits, assign exactly ["Other"].
- platforms: which platform(s) the request concerns, chosen from the platform catalog. Assign a platform only when the ticket states or clearly implies it (e.g. "on my phone", "in the browser"); otherwise leave the list empty rather than guessing.

Third, ONLY if the ticket is a feature request, rewrite it in product voice:
- product_title: a short title naming the requested capability, written the way a product manager would put it in a backlog. Name the capability, not the customer's complaint or question.
- product_summary: 2-4 sentences describing the underlying need and the requested capability in neutral product language. No support framing ("customer says...", "user is asking..."), no requester names, no ticket phrasing — it should read as if the product team wrote the idea themselves.

For bugs and needs_details, return empty lists and empty strings for all of the above.

Tickets may carry tags. Tags are entered by support agents and customers — humans who are not product managers and who make mistakes — so treat them as weak hints at most. Base your judgment on the subject and body; never let a tag override what the ticket content itself says.

Judge only from the ticket content and the catalogs provided. Do not consider priority or importance — only what kind of item this is and where it belongs. Give a single short sentence of reasoning covering the classification and, for feature requests, the assignment.`;

const CATALOG_TOOL = {
  name: "catalog_ticket",
  description: "Record the catalog verdict for one support ticket.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["fr", "bug", "needs_details"] },
      product_lines: {
        type: "array",
        items: { type: "string" },
        description:
          'For feature requests: product line names from the catalog, or ["Other"] when none fits. Empty for bugs and needs_details.',
      },
      platforms: {
        type: "array",
        items: { type: "string" },
        description:
          "For feature requests: platform names from the catalog, only when the ticket states or clearly implies them. Empty otherwise.",
      },
      product_title: {
        type: "string",
        description:
          "For feature requests: a short product-voiced title naming the capability, as a PM would write it in a backlog. Empty string for bugs and needs_details.",
      },
      product_summary: {
        type: "string",
        description:
          "For feature requests: 2-4 sentences describing the underlying need in neutral product language, without support framing. Empty string for bugs and needs_details.",
      },
      reason: {
        type: "string",
        description: "One short sentence explaining the classification and assignment.",
      },
    },
    required: ["kind", "product_lines", "platforms", "product_title", "product_summary", "reason"],
  },
};

export interface CatalogInput {
  key: string;
  subject: string;
  body: string;
  tags: string[];
}

export interface CatalogResult extends CatalogVerdict {
  key: string;
  productLines: string[];
  platforms: string[];
  /** Product-voiced rewrite, only for FRs; empty otherwise. */
  productTitle: string;
  productSummary: string;
}

interface CatalogListEntry {
  name: string;
  description: string;
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

function isCatalogKind(v: unknown): v is CatalogKind {
  return v === "fr" || v === "bug" || v === "needs_details";
}

function toNames(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function renderList(title: string, entries: CatalogListEntry[]): string {
  if (entries.length === 0) return `${title}:\n(none defined)`;
  const lines = entries.map((e) =>
    e.description ? `- ${e.name} — ${e.description}` : `- ${e.name}`
  );
  return `${title}:\n${lines.join("\n")}`;
}

function renderUserMessage(
  input: CatalogInput,
  productLines: CatalogListEntry[],
  platforms: CatalogListEntry[]
): string {
  return [
    renderList("PRODUCT LINE CATALOG", productLines),
    renderList("PLATFORM CATALOG", platforms),
    [
      "TICKET",
      `Subject: ${input.subject}`,
      `Tags: ${input.tags.length > 0 ? input.tags.join(", ") : "(none)"}`,
      "",
      "Body:",
      input.body || "(empty)",
    ].join("\n"),
  ].join("\n\n");
}

async function judgeTicket(
  model: string,
  userMessage: string
): Promise<Omit<CatalogResult, "key">> {
  // No temperature: the Claude 5 family rejects the parameter outright
  // (`temperature` is deprecated).
  const message = await getClient().messages.create({
    model,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    tools: [CATALOG_TOOL],
    tool_choice: { type: "tool", name: "catalog_ticket" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Catalog model returned no verdict");
  }
  const raw = toolUse.input as {
    kind?: unknown;
    product_lines?: unknown;
    platforms?: unknown;
    product_title?: unknown;
    product_summary?: unknown;
    reason?: unknown;
  };
  if (!isCatalogKind(raw.kind)) {
    throw new Error(`Catalog model returned invalid kind: ${String(raw.kind)}`);
  }
  // Names are recorded exactly as returned — never dropped or coerced. The
  // review UI flags anything outside the catalog so we can see how the model
  // actually behaves before deciding whether to constrain it.
  return {
    kind: raw.kind,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    productLines: toNames(raw.product_lines),
    platforms: toNames(raw.platforms),
    productTitle: typeof raw.product_title === "string" ? raw.product_title.trim() : "",
    productSummary: typeof raw.product_summary === "string" ? raw.product_summary.trim() : "",
  };
}

export interface CatalogBatchResult {
  results: CatalogResult[];
  model: string;
  promptVersion: string;
  called: number;
}

/**
 * Catalog a batch of tickets for one workspace. Every ticket is judged fresh
 * against the current Settings → Ideas catalogs; each verdict is appended to
 * the ledger as soon as it lands (with the exact rendered input), so a
 * failure mid-batch never loses the judgments already paid for.
 */
export async function catalogTickets(
  workspaceId: string,
  tickets: CatalogInput[]
): Promise<CatalogBatchResult> {
  const model = getCatalogModel();
  const [productLines, platforms] = await Promise.all([
    db.productLine.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, description: true },
    }),
    db.platform.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, description: true },
    }),
  ]);

  const results: CatalogResult[] = [];
  for (const ticket of tickets) {
    const userMessage = renderUserMessage(ticket, productLines, platforms);
    const verdict = await judgeTicket(model, userMessage);
    const input = { system: SYSTEM_PROMPT, user: userMessage };
    await recordVerdict(
      workspaceId,
      ledgerKey("catalog", CATALOG_PROMPT_VERSION, model, input),
      {
        stage: "catalog",
        promptVersion: CATALOG_PROMPT_VERSION,
        model,
        input,
        verdict,
      }
    );
    results.push({ key: ticket.key, ...verdict });
  }

  return { results, model, promptVersion: CATALOG_PROMPT_VERSION, called: tickets.length };
}
