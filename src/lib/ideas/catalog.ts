import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { db } from "../db";
import { mergeIdeasJiraConfig } from "./jira-mapping";
import { getVertexLocation, getVertexProjectId } from "../vertex-config";
import { ledgerKey, recordVerdict } from "./ledger";
import type { CatalogKind, CatalogVerdict } from "./types";

/**
 * Catalog stage: classify each raw Zendesk ticket as FR / Bug / Needs-details
 * and, for FRs, assign product line(s), platform(s) and affected customer(s)
 * from the workspace catalogs (Settings → Ideas) and rewrite the ticket's subject/body as a
 * product-voiced title and summary for the resulting idea. Every run judges fresh; each judgment is
 * appended to the ledger so behavior can be audited and determinism measured,
 * but nothing is ever replayed or forced.
 */

export const CATALOG_PROMPT_VERSION = "catalog-v9";

/** Reserved product-line value for FRs no catalog line fits. */
export const OTHER_PRODUCT_LINE = "Other";

/** Bump IDEAS_CATALOG_MODEL in env to change; recorded on every ledger row. */
function getCatalogModel(): string {
  return process.env.IDEAS_CATALOG_MODEL?.trim() || "claude-opus-5";
}

export const CATALOG_SYSTEM_PROMPT = `You catalog incoming customer-support tickets for a product team's discovery pipeline.

First, classify the ticket into exactly one kind:
- "fr" — a feature request: the customer asks for a capability or behavior the product does not currently offer. Requests for timelines on known planned work also count as feature requests.
- "bug" — the product misbehaves relative to what it is clearly meant to do. Watch for bugs phrased as feature requests: if the described situation is the product doing something wrong (incorrect data shown, broken output, degraded results), it is a bug regardless of how the customer worded the ask.
- "needs_details" — the ticket is too vague or underspecified to act on without going back to the requester.

Second, ONLY if the ticket is a feature request, assign it within the product:
- product_lines: which product line(s) the requested capability belongs to. Choose from the catalog provided in the message. Usually one; use several only when the request genuinely spans lines. If the ticket is a feature request but no catalog line fits, assign exactly ["Other"].
- platforms: which platform(s) the request concerns, chosen from the platform catalog. Platforms are optional: when the platform catalog is empty (none defined), skip this entirely and return an empty list. Otherwise assign a platform only when the ticket states or clearly implies it (e.g. "on my phone", "in the browser"); an empty list is the normal answer, never guess.
- affected_customers: every customer the ticket content says is affected by or asking for this. When a mentioned customer matches an entry in the customer catalog, return the catalog's exact name; when the ticket clearly names a customer that is not in the catalog, return the name as written — it is surfaced to the product team as a suggestion. Only list customers the ticket itself names or clearly references; an empty list is the correct answer when none are mentioned. The requester is whoever filed the ticket — often a support or staff member filing on a customer's behalf — so never treat the requester as an affected customer unless the ticket content itself says they are one.

Third, ONLY if the ticket is a feature request, rewrite it in product voice:
- product_title: a short title naming the requested capability, written the way a product manager would put it in a backlog. Name the capability, not the customer's complaint or question — and the what, not the how: never bake an implementation into the title unless the ticket makes the implementation itself the ask.
- product_summary: markdown that follows the IDEA TEMPLATE provided in the message — its sections, in order, with its exact "##" headings, honoring each section's own rules about when to omit it. Writing rules:
  - The audience is the team's own product managers: never explain what the product or a module does — they know (the rare exception is when the ask itself only makes sense with that context).
  - Short and easy to read. Prefer fewer words wherever nothing important is lost.
  - Frame it as a general product capability that belongs in its product line, not a fix for one customer's situation — features should correlate into a coherent product, not accumulate as standalone patches.
  - No support framing ("customer says...", "user is asking..."), no requester or customer names (captured separately), no ticket phrasing — it should read as if the product team wrote the idea themselves.

For bugs and needs_details, return empty lists and empty strings for all of the above.

Everything in the ticket was written or relayed by an organization representative (support, CS, sales) — including passages quoted as the customer's words and any "why we should build this" or "insights" fields. Treat all of it as that person's interpretation of a customer interaction: one grade of information, read with the same grain of salt. Evaluate what the underlying need actually is rather than inheriting the reporter's framing or justification as fact.

Tickets may carry tags and a reporter-chosen module. Both are entered by humans who are not product managers and who make mistakes — treat them as hints at most: the module usually points at the right product line, but never let it or a tag override what the ticket content itself says.

Tickets sometimes pack several DISTINCT user problems into one message (reporters are busy people). Report request_count: the number of distinct user problems a product manager would file as separate backlog items. It is 1 unless the ticket clearly contains several unrelated asks; alternative solutions or details of ONE problem are still 1. A later stage handles the actual splitting — here you only count, and your product_title/product_summary should cover the ticket as a whole either way.

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
      affected_customers: {
        type: "array",
        items: { type: "string" },
        description:
          "For feature requests: customers the ticket content says are affected or asking — the catalog's exact name when matched, otherwise the name as written in the ticket. Empty when no customer is mentioned, and for bugs and needs_details.",
      },
      product_title: {
        type: "string",
        description:
          "For feature requests: a short product-voiced title naming the capability, as a PM would write it in a backlog. Empty string for bugs and needs_details.",
      },
      product_summary: {
        type: "string",
        description:
          "For feature requests: markdown following the IDEA TEMPLATE sections and rules from the message. Empty string for bugs and needs_details.",
      },
      request_count: {
        type: "integer",
        minimum: 1,
        description:
          "Distinct user problems a PM would file as separate backlog items. 1 unless the ticket clearly contains several.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence explaining the classification and assignment.",
      },
    },
    required: [
      "kind",
      "request_count",
      "product_lines",
      "platforms",
      "affected_customers",
      "product_title",
      "product_summary",
      "reason",
    ],
  },
};

export interface CatalogInput {
  key: string;
  subject: string;
  body: string;
  /** Who filed the ticket — shown to the model so it never confuses the filer with an affected customer. */
  requester?: string;
  tags: string[];
  /** Reporter-chosen module — a hint, never an override. */
  module?: string;
  /** Reporter's "why should we build this" — interpretation, same grain of salt. */
  whyBuild?: string;
  /** Reporter's "what insights do we have" — interpretation. */
  insights?: string;
}

export interface CatalogResult extends CatalogVerdict {
  key: string;
  /** Distinct user problems the model counted; >1 flags the split stage. */
  requestCount: number;
  productLines: string[];
  platforms: string[];
  /** Customers matched from the customer catalog; empty when none are mentioned. */
  affectedCustomers: string[];
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
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function renderList(title: string, entries: CatalogListEntry[]): string {
  if (entries.length === 0) return `${title}:\n(none defined)`;
  const lines = entries.map((e) =>
    e.description ? `- ${e.name} — ${e.description}` : `- ${e.name}`,
  );
  return `${title}:\n${lines.join("\n")}`;
}

function renderUserMessage(
  input: CatalogInput,
  productLines: CatalogListEntry[],
  platforms: CatalogListEntry[],
  customers: CatalogListEntry[],
  ideaTemplate: string,
): string {
  return [
    `IDEA TEMPLATE (product_summary must follow these sections):\n\n${ideaTemplate}`,
    renderList("PRODUCT LINE CATALOG", productLines),
    renderList("PLATFORM CATALOG", platforms),
    renderList("CUSTOMER CATALOG", customers),
    [
      "TICKET",
      `Subject: ${input.subject}`,
      `Requester: ${input.requester || "(unknown)"}`,
      `Tags: ${input.tags.length > 0 ? input.tags.join(", ") : "(none)"}`,
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

async function judgeTicket(
  model: string,
  userMessage: string,
): Promise<Omit<CatalogResult, "key">> {
  // No temperature: the Claude 5 family rejects the parameter outright
  // (`temperature` is deprecated).
  const message = await getClient().messages.create({
    model,
    max_tokens: 1000,
    system: CATALOG_SYSTEM_PROMPT,
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
    request_count?: unknown;
    product_lines?: unknown;
    platforms?: unknown;
    affected_customers?: unknown;
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
    requestCount:
      typeof raw.request_count === "number" &&
      Number.isFinite(raw.request_count)
        ? Math.max(1, Math.floor(raw.request_count))
        : 1,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    productLines: toNames(raw.product_lines),
    platforms: toNames(raw.platforms),
    affectedCustomers: toNames(raw.affected_customers),
    productTitle:
      typeof raw.product_title === "string" ? raw.product_title.trim() : "",
    productSummary:
      typeof raw.product_summary === "string" ? raw.product_summary.trim() : "",
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
  tickets: CatalogInput[],
): Promise<CatalogBatchResult> {
  const model = getCatalogModel();
  const [productLines, platforms, customers, wsRow] = await Promise.all([
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
    db.customer.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, description: true },
    }),
    db.workspace.findUnique({
      where: { id: workspaceId },
      select: { ideasConfig: true },
    }),
  ]);
  const ideaTemplate = mergeIdeasJiraConfig(wsRow?.ideasConfig).ideaTemplate;

  const results: CatalogResult[] = [];
  for (const ticket of tickets) {
    const userMessage = renderUserMessage(
      ticket,
      productLines,
      platforms,
      customers,
      ideaTemplate,
    );
    const verdict = await judgeTicket(model, userMessage);
    const input = { system: CATALOG_SYSTEM_PROMPT, user: userMessage };
    await recordVerdict(
      workspaceId,
      ledgerKey("catalog", CATALOG_PROMPT_VERSION, model, input),
      {
        stage: "catalog",
        promptVersion: CATALOG_PROMPT_VERSION,
        model,
        input,
        verdict,
      },
    );
    results.push({ key: ticket.key, ...verdict });
  }

  return {
    results,
    model,
    promptVersion: CATALOG_PROMPT_VERSION,
    called: tickets.length,
  };
}
