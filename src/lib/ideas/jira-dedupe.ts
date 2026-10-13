import { db } from "../db";
import { getIdeasClient } from "./ai-cache";
import { IDEA_WRITING_RULES } from "./idea-voice";
import { ledgerKey, recordVerdict } from "./ledger";
import { getMatchModel } from "./match";
import { anthropicUsage, type StageHooks } from "./trace";
import type { JiraSource } from "./types";

/**
 * Jira-to-Jira dedupe (Daniel, 2026-10-13): issues in the customer's backlog
 * that address the same user pain become ONE idea with several Jira
 * sources, so a Zendesk ticket matches one idea, not three (PRDT-28 / 64 / 65:
 * "notes on incidents" filed once per feed).
 *
 * Bar: PMs wrote these, so wording differences are deliberate — only group
 * when a product manager would call them the same item (≈85 %+). A per-screen
 * variant of one capability counts as the same; a prerequisite, complement or
 * neighbouring feature does not.
 *
 * Runs after the pull and before classification, one call per product line
 * (the only place duplicates live). Judged once per input: an identical set
 * of issues reuses the ledger verdict, so groups never flip between imports.
 * A PM who detaches a Jira source on the Merge page records a reject pair
 * (JiraDedupeReject); rejected pairs are never grouped again.
 */

export const JIRA_DEDUPE_PROMPT_VERSION = "jira-dedupe-v2";

export const JIRA_DEDUPE_SYSTEM_PROMPT = `You find duplicate items in a product team's Jira backlog.

You are given the issues of ONE product line, each with a key, title and description, written by the team's own product managers. Group the issues that address the SAME USER PAIN — the problem a user has is the core of an item; the solution each issue proposes is one way to resolve it. Items a product manager would call one problem filed more than once: the same capability written once per screen, feed or module variant, two solutions to one problem, or something re-filed by someone who did not check the backlog.

Rules:
- Same user pain. Different wording, detail level, framing or proposed solution do not matter; the problem does.
- A per-screen or per-feed variant of one capability IS the same pain (e.g. "notes on incidents", "notes on cookie incidents", "notes on market bot incidents"). Two different solutions to one problem ARE the same pain.
- NOT the same: a different pain in the same area, a different user group, a follow-up that only exists once the first is built, or an item that states no user pain of its own (a technical task, a data model, infrastructure) — even when it would enable another issue.
- These were written by product managers — assume the distinction is deliberate unless the texts clearly share one problem. Be strict: when in doubt, do not group.
- Return only groups of two or more keys. Every key at most once. Keys exactly as listed.
- One short sentence of reasoning per group.`;

const DEDUPE_TOOL = {
  name: "group_jira_issues",
  description: "Groups of Jira issue keys that address the same user pain.",
  input_schema: {
    type: "object" as const,
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            keys: { type: "array", items: { type: "string" }, description: "Two or more issue keys, exactly as listed." },
            reason: { type: "string", description: "One short sentence naming the shared user pain." },
          },
          required: ["keys", "reason"],
        },
      },
    },
    required: ["groups"],
  },
};

export const JIRA_MERGE_SYSTEM_PROMPT = `You merge several Jira issues that address the same user pain into one idea for the product team.

You are given the issues (key, title, description — written by the team's own product managers) and the IDEA TEMPLATE. Write product_title (the problem or outcome, not an implementation) and product_summary in markdown following the template — its sections in order with their exact "##" headings, honoring their omission rules; "The Problem" is the anchor, and when the issues propose different solutions, list the distinct asks there as bullets and keep Proposed Solution to what is confidently right (or omit it). Keep every fact, link, key, identifier and constraint from every issue (say it once when several say it); nothing a PM wrote may disappear or change meaning. Writing rules:
${IDEA_WRITING_RULES}`;

const MERGE_TOOL = {
  name: "merge_jira_group",
  description: "The merged idea for a group of Jira issues.",
  input_schema: {
    type: "object" as const,
    properties: {
      product_title: { type: "string" },
      product_summary: { type: "string", description: "Markdown following the idea template." },
    },
    required: ["product_title", "product_summary"],
  },
};

export interface JiraDedupeGroup {
  /** The issue the idea lives in and a sync writes to: the oldest (lowest number). */
  primary: string;
  /** Every key in the group, primary included, oldest first. */
  members: string[];
  title: string;
  details: string;
  reason: string;
}

export interface JiraDedupeResult {
  groups: JiraDedupeGroup[];
  /** Model calls made (ledger hits don't count). */
  called: number;
}

/** Issue number for ordering ("PRDT-28" → 28); keys without a number sort last. */
export function issueNumber(key: string): number {
  const n = Number(key.split("-").pop());
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Oldest issue of a set — the primary of a merged idea. */
export function primaryJiraKey(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return [...keys].sort((a, b) => issueNumber(a) - issueNumber(b) || a.localeCompare(b))[0];
}

/** Order-independent id of a rejected pair. */
export function rejectPairKey(a: string, b: string): string {
  return [a, b].sort((x, y) => issueNumber(x) - issueNumber(y) || x.localeCompare(y)).join("|");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function renderIssues(sources: JiraSource[]): string {
  return sources
    .map((s) => [`[${s.key}] ${s.title}`, clip((s.body || "(no description)").trim(), 900)].join("\n"))
    .join("\n\n");
}

/** Prior verdict for an identical input, so grouping is stable across imports. */
async function priorVerdict<T>(workspaceId: string, key: string): Promise<T | null> {
  const row = await db.ledgerEntry.findFirst({
    where: { workspaceId, key },
    orderBy: { createdAt: "asc" },
    select: { verdict: true },
  });
  return (row?.verdict as T | undefined) ?? null;
}

export async function dedupeJiraSources(
  workspaceId: string,
  sources: JiraSource[],
  opts: { template: string; rejects: Set<string>; hooks?: StageHooks }
): Promise<JiraDedupeResult> {
  const model = getMatchModel();
  let called = 0;
  const byLine = new Map<string, JiraSource[]>();
  for (const s of sources) {
    const line = s.products[0] ?? "Other";
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)!.push(s);
  }
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const groups: JiraDedupeGroup[] = [];

  for (const [line, issues] of byLine) {
    if (issues.length < 2) continue;
    issues.sort((a, b) => issueNumber(a.key) - issueNumber(b.key));
    const keys = new Set(issues.map((i) => i.key));
    const userMessage = `PRODUCT LINE: ${line}\n\nISSUES:\n\n${renderIssues(issues)}`;
    const ledgerInput = { system: JIRA_DEDUPE_SYSTEM_PROMPT, user: userMessage };
    const key = ledgerKey("jira-dedupe", JIRA_DEDUPE_PROMPT_VERSION, model, ledgerInput);

    let raw = await priorVerdict<{ groups?: unknown }>(workspaceId, key);
    if (!raw) {
      called++;
      const aiStart = performance.now();
      const message = await getIdeasClient().messages.create({
        model,
        max_tokens: 1500,
        system: JIRA_DEDUPE_SYSTEM_PROMPT,
        tools: [DEDUPE_TOOL],
        tool_choice: { type: "tool", name: DEDUPE_TOOL.name },
        messages: [{ role: "user", content: userMessage }],
      });
      const toolUse = message.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") throw new Error("Jira dedupe returned no verdict");
      raw = toolUse.input as { groups?: unknown };
      await recordVerdict(workspaceId, key, {
        stage: "jira-dedupe",
        promptVersion: JIRA_DEDUPE_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict: raw,
      });
      opts.hooks?.call({ aiMs: performance.now() - aiStart, tokens: anthropicUsage(message.usage) });
    }

    const used = new Set<string>();
    for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
      const row = (g ?? {}) as { keys?: unknown; reason?: unknown };
      let members = (Array.isArray(row.keys) ? row.keys : [])
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter((k) => keys.has(k) && !used.has(k));
      members = Array.from(new Set(members)).sort((a, b) => issueNumber(a) - issueNumber(b));
      // A PM's earlier "not the same" verdict wins: drop the later key of any rejected pair.
      for (let i = 0; i < members.length; i++) {
        for (let j = members.length - 1; j > i; j--) {
          if (opts.rejects.has(rejectPairKey(members[i], members[j]))) members.splice(j, 1);
        }
      }
      if (members.length < 2) continue;
      for (const m of members) used.add(m);
      const merged = await mergeGroup(workspaceId, members.map((k) => byKey.get(k)!), opts.template, model);
      if (merged.called) {
        called++;
        opts.hooks?.call(merged.hook!);
      }
      groups.push({
        primary: members[0],
        members,
        title: merged.title,
        details: merged.details,
        reason: typeof row.reason === "string" ? row.reason : "",
      });
    }
  }

  return { groups, called };
}

async function mergeGroup(
  workspaceId: string,
  issues: JiraSource[],
  template: string,
  model: string
): Promise<{ title: string; details: string; called: boolean; hook?: Parameters<NonNullable<StageHooks["call"]>>[0] }> {
  const userMessage = `IDEA TEMPLATE:\n\n${template}\n\nISSUES (one capability, filed ${issues.length} times):\n\n${renderIssues(issues)}`;
  const ledgerInput = { system: JIRA_MERGE_SYSTEM_PROMPT, user: userMessage };
  const key = ledgerKey("jira-merge", JIRA_DEDUPE_PROMPT_VERSION, model, ledgerInput);
  const fallback = { title: issues[0].title, details: issues[0].body };

  const prior = await priorVerdict<{ product_title?: unknown; product_summary?: unknown }>(workspaceId, key);
  const pick = (v: { product_title?: unknown; product_summary?: unknown } | null) => {
    const title = typeof v?.product_title === "string" ? v.product_title.trim() : "";
    const details = typeof v?.product_summary === "string" ? v.product_summary.trim() : "";
    return title && details ? { title, details } : null;
  };
  const fromPrior = pick(prior);
  if (fromPrior) return { ...fromPrior, called: false };

  const aiStart = performance.now();
  const message = await getIdeasClient().messages.create({
    model,
    max_tokens: 3000,
    system: JIRA_MERGE_SYSTEM_PROMPT,
    tools: [MERGE_TOOL],
    tool_choice: { type: "tool", name: MERGE_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  const raw = toolUse && toolUse.type === "tool_use" ? (toolUse.input as Record<string, unknown>) : {};
  await recordVerdict(workspaceId, key, {
    stage: "jira-merge",
    promptVersion: JIRA_DEDUPE_PROMPT_VERSION,
    model,
    input: ledgerInput,
    verdict: raw,
  });
  return {
    ...(pick(raw) ?? fallback),
    called: true,
    hook: { aiMs: performance.now() - aiStart, tokens: anthropicUsage(message.usage) },
  };
}
