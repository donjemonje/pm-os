import { db } from "../db";
import { getIdeasClient } from "./ai-cache";
import { ledgerKey, recordVerdict } from "./ledger";
import { getMatchModel } from "./match";
import { anthropicUsage } from "./trace";

/**
 * Smart merge of a Jira issue description with the PM-OS idea text
 * (IdeasJiraConfig.descriptionMode = "merge", Kela 2026-10-12).
 *
 * The customer's PM wrote the issue; support tickets then added evidence and
 * PM-OS wrote an idea from them. The push must leave ONE description a PM can
 * read without going back to either source — not the original with a block
 * glued underneath, not a rewrite that drops what the PM wrote.
 *
 * Determinism contract: the Jira Merge preview and the execute that follows
 * must write exactly what was previewed. The model is called once per
 * (current description, idea text, template) and the verdict is kept in the
 * judgment ledger under its content key; the execute re-reads the same key
 * instead of judging again. This is the one place the ledger short-circuits
 * the model — on purpose, see push.ts.
 */

export const DESCRIBE_MERGE_PROMPT_VERSION = "describe-merge-v1";

export const DESCRIBE_MERGE_SYSTEM_PROMPT = `You merge two descriptions of the same product idea into one.

You are given the CURRENT description of a Jira issue, written by the product team, and the PM-OS IDEA text, written from customer support tickets that were matched to this issue. Write ONE merged description.

Rules:
- Keep every fact, requirement, link, example and constraint that is in the current description. Nothing the team wrote may disappear or change meaning. Keep their wording where it is good.
- Fold in what the idea text adds: the customer problem, who it affects, real cases, a proposed solution when the idea text has one. Add, don't repeat — when both say the same thing, say it once.
- Follow the idea template's section order where it fits (## headings). A section with nothing to say is omitted. Do not add sections the template doesn't have, except to keep material from the current description that fits nowhere else — put that under its original heading or under "## Notes".
- Plain text with markdown headings and lists only. No tables, no emphasis, no preamble, no closing remark, no mention of PM-OS, Jira, tickets or this merge. The supporting tickets are listed separately by the system — never list them.
- Same language as the current description.
- Shorter is better than longer. Never pad.`;

const DESCRIBE_MERGE_TOOL = {
  name: "merged_description",
  description: "The single merged description for the Jira issue.",
  input_schema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description:
          "The merged description — markdown headings and lists, plain text otherwise.",
      },
    },
    required: ["description"],
  },
};

export interface DescribeMergeInput {
  /** Current Jira description as plain text, our previous tickets block removed. */
  current: string;
  /** The PM-OS idea text (Idea.details). */
  details: string;
  /** The org's idea template (section order). */
  template: string;
}

interface Stored {
  verdict: { description?: unknown };
}

/**
 * Merged description for one issue. Reads the ledger first; calls the model
 * only when this exact input was never judged. Returns the text and whether
 * the model ran (for the plan's cost note).
 */
export async function mergeDescription(
  workspaceId: string,
  input: DescribeMergeInput
): Promise<{ text: string; model: string; cached: boolean }> {
  const model = getMatchModel();
  const userMessage = renderInput(input);
  const ledgerInput = { system: DESCRIBE_MERGE_SYSTEM_PROMPT, user: userMessage };
  const key = ledgerKey("describe-merge", DESCRIBE_MERGE_PROMPT_VERSION, model, ledgerInput);

  const prior = (await db.ledgerEntry.findFirst({
    where: { workspaceId, key },
    orderBy: { createdAt: "asc" },
    select: { verdict: true },
  })) as Stored | null;
  const priorText =
    prior && typeof prior.verdict?.description === "string" ? prior.verdict.description.trim() : "";
  if (priorText) return { text: priorText, model, cached: true };

  const message = await getIdeasClient().messages.create({
    model,
    max_tokens: 3000,
    system: DESCRIBE_MERGE_SYSTEM_PROMPT,
    tools: [DESCRIBE_MERGE_TOOL],
    tool_choice: { type: "tool", name: DESCRIBE_MERGE_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Description merge returned no text");
  }
  const raw = (toolUse.input as { description?: unknown }).description;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new Error("Description merge returned an empty description");

  await recordVerdict(workspaceId, key, {
    stage: "describe-merge",
    promptVersion: DESCRIBE_MERGE_PROMPT_VERSION,
    model,
    input: ledgerInput,
    verdict: { description: text, usage: anthropicUsage(message.usage) },
  });
  return { text, model, cached: false };
}

function renderInput(input: DescribeMergeInput): string {
  return [
    "IDEA TEMPLATE (section order):",
    input.template.trim(),
    "",
    "CURRENT JIRA DESCRIPTION:",
    input.current.trim() || "(empty)",
    "",
    "PM-OS IDEA TEXT:",
    input.details.trim() || "(empty)",
  ].join("\n");
}

/**
 * The current description minus the tickets block PM-OS appended on an
 * earlier push (everything from the configured heading on). The block is
 * re-appended deterministically after the merge, so the model never sees it
 * and can't duplicate or paraphrase it.
 */
export function stripSupportedTickets(text: string, heading: string): string {
  const h = heading.trim();
  if (!h) return text.trim();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === h.toLowerCase());
  return (idx >= 0 ? lines.slice(0, idx) : lines).join("\n").trim();
}
