import { db } from "../db";
import { aiThrottleOn } from "./ai-throttle";
import { IDEA_WRITING_RULES } from "./idea-voice";
import { mergeIdeasJiraConfig } from "./jira-mapping";
import { ledgerKey, recordVerdict } from "./ledger";
import { anthropicUsage, type StageHooks } from "./trace";
import {
  getIdeasClient,
  prefixedUserMessage,
  PrefixWarmer,
  type PrefixParams,
} from "./ai-cache";

/** Match reports per-call samples like every stage, plus the phase switch. */
export interface MatchHooks extends StageHooks {
  /** Called once, before the reconciliation calls, with the group count. */
  groupPhase(groups: number, meta: { model: string; promptVersion: string }): void;
}

/**
 * Match stage, v5 — two phases, both parallel:
 *
 * 1. PAIRWISE: every feature-request unit is matched at once against the
 *    candidate pool — existing ideas, live Jira issues not yet represented,
 *    AND every other unit of this same import. Each unit answers "I
 *    duplicate X" or nothing.
 * 2. RESOLVE + RECONCILE: the answers form chains (218→214, 624→218) that
 *    deterministic code folds into groups. Groups of two or more units get
 *    ONE reconciliation call each: confirm the grouping (or split the odd
 *    one out) and write the merged, templated idea. Groups are independent,
 *    so those calls run in parallel too. Single-unit merges into an
 *    existing idea keep their pairwise enrichment; standalone units skip
 *    phase 2 entirely.
 *
 * Same-import consolidation therefore no longer depends on file order —
 * every unit sees every sibling — and the stage costs one wave instead of a
 * serial chain. Every verdict is appended to the ledger.
 *
 * v6: the candidate list is identical for every unit of the wave (each
 * unit is listed too, and told never to match itself) so the list is one
 * cached prefix instead of ~50 near-copies.
 */

export const MATCH_PROMPT_VERSION = "match-v7";

/** Bump IDEAS_MATCH_MODEL in env to change; recorded on every ledger row. */
function getMatchModel(): string {
  return process.env.IDEAS_MATCH_MODEL?.trim() || "claude-opus-5";
}

export const MATCH_SYSTEM_PROMPT = `You match an incoming feature request against a product team's existing ideas list.

You are given ONE feature request (a product-voiced title and summary, plus the original support-ticket text) and the full list of candidates, each with a key, title, and description. The list can contain ideas synced from the team's Jira backlog, ideas created from earlier support tickets, and OTHER REQUESTS FROM THIS SAME IMPORT (keys starting with "unit:") — those are peers being matched at the same time, and claiming one is how two tickets that ask for the same thing get merged. The same list is shown to every request of the import, so it also contains THIS request under its own key (given with the request) — never match a request to itself.

Decide whether the request asks for the same capability as one candidate:
- A match means the same underlying capability and need — a customer voting for something already asked for. Different wording, narrower phrasing, or extra detail do not prevent a match when the capability is the same.
- Related is NOT matched: same product area but a different capability, a complement, or a prerequisite is not a match.
- Prefer an existing idea over a peer request when both fit — existing ideas are the settled record.
- When torn between two candidates, pick the single best one; when none clearly fits, return no match. Never force a match.

If (and only if) the request matches an EXISTING idea (not a peer request), also judge enrichment: does the request add real context the idea's description lacks (a concrete use case, a constraint, a sharper articulation of the need)? If yes, write enriched_summary: the existing idea's description, sharpened with the new context, in neutral product language. It replaces the description, so it must stand alone, keep everything still true from the original, and keep (or adopt) the IDEA TEMPLATE structure provided in the message — sections in order with their exact "##" headings, honoring their omission rules. Writing rules:
${IDEA_WRITING_RULES}
If the request adds nothing beyond a vote, or the match is a peer request, return an empty enriched_summary.

Return the matched candidate's key EXACTLY as listed, or an empty string for no match. Give a single short sentence of reasoning.`;

export const MATCH_GROUP_SYSTEM_PROMPT = `You reconcile a group of support-ticket requests that were each judged to ask for the same thing.

You are given the group's requests (each with a key, product-voiced title and summary, and the original ticket text) and, when the group merges into an existing idea, that idea's current title and description. Your job:
- Confirm which requests truly share ONE underlying capability and need. If a request does not belong (a related-but-different capability, a complement, a prerequisite), split it out into its own group. Requests that were chained together transitively may not all belong together — judge every pair on the same capability, not on topic proximity.
- For every resulting group, write the merged idea: product_title (the what, not the how — no implementation baked in) and product_summary in markdown that follows the IDEA TEMPLATE provided in the message — its sections, in order, with its exact "##" headings, honoring each section's omission rules. The text covers only this group's capability — never fold in asks that belong to other requests of the same tickets (a sibling sub-idea stays its own idea), and never claim a precedent or scope the tickets do not state. Writing rules:
${IDEA_WRITING_RULES}
  When the group merges into an existing idea, product_summary is that idea's description sharpened with everything the group adds (it replaces the description and must stand alone).
- product_lines: the group's product line(s) from the catalog; ["Other"] when none fits. platforms: only when the requests state or clearly imply them; empty when the platform catalog is empty.

Every input key must appear in exactly one group. Give a single short sentence of reasoning.`;

const MATCH_TOOL = {
  name: "match_feature_request",
  description:
    "Record the match verdict for one feature request against the ideas list.",
  input_schema: {
    type: "object" as const,
    properties: {
      matched_key: {
        type: "string",
        description:
          "Key of the single candidate this request duplicates, exactly as listed. Empty string when none matches.",
      },
      enriched_summary: {
        type: "string",
        description:
          "Only when matched to an EXISTING idea AND the request adds real context: replacement description following the idea template. Empty string otherwise.",
      },
      reason: {
        type: "string",
        description: "One short sentence explaining the match or non-match.",
      },
    },
    required: ["matched_key", "enriched_summary", "reason"],
  },
};

const GROUP_TOOL = {
  name: "reconcile_group",
  description:
    "Confirm or split a group of requests judged to be one idea, and write each resulting idea.",
  input_schema: {
    type: "object" as const,
    properties: {
      groups: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            members: { type: "array", minItems: 1, items: { type: "string" } },
            product_title: { type: "string" },
            product_summary: { type: "string" },
            product_lines: { type: "array", items: { type: "string" } },
            platforms: { type: "array", items: { type: "string" } },
          },
          required: [
            "members",
            "product_title",
            "product_summary",
            "product_lines",
            "platforms",
          ],
        },
      },
      reason: { type: "string" },
    },
    required: ["groups", "reason"],
  },
};

export interface MatchInput {
  key: string;
  subject: string;
  body: string;
  /** Product-voiced rewrite from the catalog/split stage. */
  productTitle: string;
  productSummary: string;
}

export interface MatchRewrite {
  productTitle: string;
  productSummary: string;
  productLines: string[];
  platforms: string[];
}

export interface MatchResult {
  key: string;
  /**
   * Resolved target: an existing idea id, "jira:<KEY>", "new:<unit key>"
   * (merge into the idea created for that earlier unit), or null = this unit
   * creates a new idea.
   */
  matchedKey: string | null;
  /** Replacement description for an existing-idea target; empty otherwise. */
  enrichedSummary: string;
  /** Group-reconciled idea text for a unit that creates a group's idea. */
  rewrite?: MatchRewrite;
  reason: string;
}

export interface MatchCandidate {
  /** Opaque key the model echoes back — an idea id or "jira:<KEY>". */
  key: string;
  title: string;
  body: string;
}

/** Deterministic cap on descriptions so the rendered ask stays stable. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function toNames(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function renderCandidates(ideas: MatchCandidate[]): string {
  const lines = ideas.map((s) =>
    [`[${s.key}] ${s.title}`, clip(s.body || "(no description)", 800)].join(
      "\n",
    ),
  );
  return `CANDIDATES:\n\n${lines.join("\n\n")}`;
}

function renderRequest(input: MatchInput, ownKey?: string): string {
  return [
    "FEATURE REQUEST",
    ...(ownKey ? [`Own key in the candidate list (never a match): ${ownKey}`] : []),
    `Title: ${input.productTitle || input.subject}`,
    `Summary: ${input.productSummary || "(none)"}`,
    "",
    "Original ticket:",
    `Subject: ${input.subject}`,
    `Body: ${input.body || "(empty)"}`,
  ].join("\n");
}

/** Bounded worker pool; ordering of results is by index, not completion. */
async function runPool<T>(
  items: T[],
  size: number,
  fn: (item: T, i: number) => Promise<void>,
) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker),
  );
}

export interface MatchBatchResult {
  results: MatchResult[];
  model: string;
  promptVersion: string;
  called: number;
}

const MATCH_TOOL_CHOICE = {
  type: "tool" as const,
  name: "match_feature_request",
};
const GROUP_TOOL_CHOICE = { type: "tool" as const, name: "reconcile_group" };

/** What both match phases share: model, template, catalogs, group prefix. */
export interface MatchContext {
  model: string;
  templateBlock: string;
  catalogsBlock: string;
  /** Reconciliation prefix — known at import start, warmed early. */
  groupPrefix: PrefixParams;
}

export const MATCH_PREFIX_KEY = "match";
export const MATCH_GROUP_PREFIX_KEY = "match-group";

/** Template + catalogs once; called at import start so the group prefix warms early. */
export async function prepareMatch(workspaceId: string): Promise<MatchContext> {
  const model = getMatchModel();
  const [wsRow, productLines, platforms] = await Promise.all([
    db.workspace.findUnique({
      where: { id: workspaceId },
      select: { ideasConfig: true },
    }),
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
  const ideaTemplate = mergeIdeasJiraConfig(wsRow?.ideasConfig).ideaTemplate;
  const templateBlock = `IDEA TEMPLATE (any summary you write must follow these sections):\n\n${ideaTemplate}`;
  const renderList = (
    title: string,
    entries: { name: string; description: string }[],
  ) =>
    entries.length === 0
      ? `${title}:\n(none defined)`
      : `${title}:\n${entries.map((e) => (e.description ? `- ${e.name} — ${e.description}` : `- ${e.name}`)).join("\n")}`;
  const catalogsBlock = [
    renderList("PRODUCT LINE CATALOG", productLines),
    renderList("PLATFORM CATALOG", platforms),
  ].join("\n\n");
  return {
    model,
    templateBlock,
    catalogsBlock,
    groupPrefix: {
      model,
      system: MATCH_GROUP_SYSTEM_PROMPT,
      tools: [GROUP_TOOL],
      tool_choice: GROUP_TOOL_CHOICE,
      shared: [templateBlock, catalogsBlock].join("\n\n"),
    },
  };
}

export interface MatchRunOptions {
  hooks?: MatchHooks;
  warmer?: PrefixWarmer;
  ctx?: MatchContext;
}

export async function matchTickets(
  workspaceId: string,
  inputs: MatchInput[],
  initialCandidates: MatchCandidate[],
  options: MatchRunOptions = {},
): Promise<MatchBatchResult> {
  const { hooks } = options;
  const model = options.ctx?.model ?? getMatchModel();
  if (inputs.length === 0) {
    return {
      results: [],
      model,
      promptVersion: MATCH_PROMPT_VERSION,
      called: 0,
    };
  }
  const ctx = options.ctx ?? (await prepareMatch(workspaceId));
  const { templateBlock } = ctx;
  const warmer = options.warmer ?? new PrefixWarmer(hooks);

  const poolSize = aiThrottleOn() ? 1 : inputs.length;
  let called = 0;

  // ——— Phase 1: pairwise, every unit against the pool + all peers ———
  const anchors = [...initialCandidates].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const anchorKeys = new Set(anchors.map((c) => c.key));
  const peerKey = (u: MatchInput) => `unit:${u.key}`;
  const inputByPeerKey = new Map(inputs.map((u) => [peerKey(u), u]));

  // One candidate list for the whole wave (every unit included) — the
  // cached prefix; each call adds only its own request.
  const peers: MatchCandidate[] = inputs.map((u) => ({
    key: peerKey(u),
    title: u.productTitle || u.subject,
    body: u.productSummary || u.body,
  }));
  const candidates = [...anchors, ...peers];
  const candidateKeys = new Set(candidates.map((c) => c.key));
  const pairwiseShared = [templateBlock, renderCandidates(candidates)].join(
    "\n\n",
  );
  // This prefix depends on every unit, so it can only be warmed now.
  if (inputs.length > 1) {
    warmer.ensure(
      MATCH_PREFIX_KEY,
      {
        model,
        system: MATCH_SYSTEM_PROMPT,
        tools: [MATCH_TOOL],
        tool_choice: MATCH_TOOL_CHOICE,
        shared: pairwiseShared,
      },
      hooks,
    );
    await warmer.ready(MATCH_PREFIX_KEY);
  }

  const pairwise: {
    target: string | null;
    enrichedSummary: string;
    reason: string;
  }[] = new Array(inputs.length);
  await runPool(inputs, poolSize, async (input, i) => {
    const requestBlock = renderRequest(input, peerKey(input));
    const userMessage = `${pairwiseShared}\n\n${requestBlock}`;
    called++;
    const aiStart = performance.now();
    const message = await getIdeasClient().messages.create({
      model,
      max_tokens: 1500,
      system: MATCH_SYSTEM_PROMPT,
      tools: [MATCH_TOOL],
      tool_choice: MATCH_TOOL_CHOICE,
      messages: prefixedUserMessage(pairwiseShared, requestBlock),
    });
    const aiMs = performance.now() - aiStart;
    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use")
      throw new Error("Match model returned no verdict");
    const raw = toolUse.input as {
      matched_key?: unknown;
      enriched_summary?: unknown;
      reason?: unknown;
    };
    const verdict = {
      matchedKey:
        typeof raw.matched_key === "string" ? raw.matched_key.trim() : "",
      enrichedSummary:
        typeof raw.enriched_summary === "string"
          ? raw.enriched_summary.trim()
          : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
    const ledgerInput = { system: MATCH_SYSTEM_PROMPT, user: userMessage };
    const dbStart = performance.now();
    await recordVerdict(
      workspaceId,
      ledgerKey("match", MATCH_PROMPT_VERSION, model, ledgerInput),
      {
        stage: "match",
        promptVersion: MATCH_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict,
      },
    );
    hooks?.call({
      aiMs,
      dbMs: performance.now() - dbStart,
      tokens: anthropicUsage(message.usage),
    });
    // The ledger keeps the verdict as returned; the pipeline only acts on
    // keys that were actually offered — and never on the unit's own key.
    pairwise[i] = {
      target:
        candidateKeys.has(verdict.matchedKey) &&
        verdict.matchedKey !== peerKey(input)
          ? verdict.matchedKey
          : null,
      enrichedSummary: verdict.enrichedSummary,
      reason: verdict.reason,
    };
  });

  // ——— Resolve: follow peer chains to a terminal anchor or a peer cycle ———
  const indexOf = new Map(inputs.map((u, i) => [peerKey(u), i]));
  /** Terminal for a unit: an anchor key, or the peer key of the cycle/chain root. */
  const terminal = new Map<number, string>();
  const resolve = (i: number, trail: number[]): string => {
    if (terminal.has(i)) return terminal.get(i)!;
    const t = pairwise[i].target;
    let result: string;
    if (t === null) result = peerKey(inputs[i]);
    else if (anchorKeys.has(t)) result = t;
    else {
      const j = indexOf.get(t);
      if (j === undefined) result = peerKey(inputs[i]);
      else if (trail.includes(j)) {
        // Cycle: the root is the earliest unit in file order among the cycle.
        const cycle = trail.slice(trail.indexOf(j)).concat(i);
        result = peerKey(inputs[Math.min(...cycle)]);
      } else result = resolve(j, [...trail, i]);
    }
    terminal.set(i, result);
    return result;
  };
  const groupsByTerminal = new Map<string, number[]>();
  inputs.forEach((_, i) => {
    const t = resolve(i, []);
    const list = groupsByTerminal.get(t) ?? [];
    list.push(i);
    groupsByTerminal.set(t, list);
  });

  // ——— Phase 2: reconcile groups of two or more units (parallel) ———
  const results: MatchResult[] = inputs.map((u, i) => ({
    key: u.key,
    matchedKey: null,
    enrichedSummary: "",
    reason: pairwise[i].reason,
  }));
  const groupJobs: { terminal: string; members: number[] }[] = [];
  for (const [t, members] of groupsByTerminal) {
    members.sort((a, b) => a - b);
    if (members.length === 1) {
      const i = members[0];
      // Standalone, or a single unit merging into an existing idea.
      results[i].matchedKey = anchorKeys.has(t) ? t : null;
      results[i].enrichedSummary = anchorKeys.has(t)
        ? pairwise[i].enrichedSummary
        : "";
      continue;
    }
    groupJobs.push({ terminal: t, members });
  }

  hooks?.groupPhase(groupJobs.length, {
    model,
    promptVersion: MATCH_PROMPT_VERSION,
  });
  const groupShared = ctx.groupPrefix.shared;
  if (groupJobs.length > 1) {
    warmer.ensure(MATCH_GROUP_PREFIX_KEY, ctx.groupPrefix, hooks);
    await warmer.ready(MATCH_GROUP_PREFIX_KEY);
  }
  await runPool(groupJobs, poolSize, async (job) => {
    const anchor = anchorKeys.has(job.terminal)
      ? (anchors.find((a) => a.key === job.terminal) ?? null)
      : null;
    const memberInputs = job.members.map((i) => inputs[i]);
    const groupBlock = [
      anchor
        ? `EXISTING IDEA (the group merges into it):\n[${anchor.key}] ${anchor.title}\n${clip(anchor.body || "(no description)", 1500)}`
        : "EXISTING IDEA: none — the group becomes a new idea.",
      `GROUP REQUESTS:\n\n${memberInputs
        .map((u) => [`[${peerKey(u)}]`, renderRequest(u)].join("\n"))
        .join("\n\n")}`,
    ].join("\n\n");
    const userMessage = `${groupShared}\n\n${groupBlock}`;
    called++;
    const aiStart = performance.now();
    const message = await getIdeasClient().messages.create({
      model,
      max_tokens: 3000,
      system: MATCH_GROUP_SYSTEM_PROMPT,
      tools: [GROUP_TOOL],
      tool_choice: GROUP_TOOL_CHOICE,
      messages: prefixedUserMessage(groupShared, groupBlock),
    });
    const aiMs = performance.now() - aiStart;
    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use")
      throw new Error("Group model returned no verdict");
    const raw = toolUse.input as { groups?: unknown; reason?: unknown };
    const groups: { members: string[]; rewrite: MatchRewrite | null }[] = (
      Array.isArray(raw.groups) ? raw.groups : []
    ).map((g) => {
      const row = (g ?? {}) as Record<string, unknown>;
      return {
        members: toNames(row.members).filter((k) => inputByPeerKey.has(k)),
        rewrite: {
          productTitle:
            typeof row.product_title === "string"
              ? row.product_title.trim()
              : "",
          productSummary:
            typeof row.product_summary === "string"
              ? row.product_summary.trim()
              : "",
          productLines: toNames(row.product_lines),
          platforms: toNames(row.platforms),
        },
      };
    });
    const ledgerInput = {
      system: MATCH_GROUP_SYSTEM_PROMPT,
      user: userMessage,
    };
    const dbStart = performance.now();
    await recordVerdict(
      workspaceId,
      ledgerKey("match-group", MATCH_PROMPT_VERSION, model, ledgerInput),
      {
        stage: "match-group",
        promptVersion: MATCH_PROMPT_VERSION,
        model,
        input: ledgerInput,
        verdict: {
          groups,
          reason: typeof raw.reason === "string" ? raw.reason : "",
        },
      },
    );
    hooks?.call({
      aiMs,
      dbMs: performance.now() - dbStart,
      tokens: anthropicUsage(message.usage),
    });

    // Members the model dropped stay with the first group that has the
    // anchor (or the first group) — nothing is ever lost.
    const placed = new Set<string>();
    const finalGroups = groups.filter((g) => g.members.length > 0);
    if (finalGroups.length === 0) {
      // No usable verdict: keep the resolved group as-is with the catalog text.
      finalGroups.push({
        members: job.members.map((i) => peerKey(inputs[i])),
        rewrite: null,
      });
    }
    for (const g of finalGroups) g.members.forEach((k) => placed.add(k));
    for (const i of job.members) {
      const k = peerKey(inputs[i]);
      if (!placed.has(k)) {
        finalGroups[0].members.push(k);
        placed.add(k);
      }
    }

    finalGroups.forEach((g, gi) => {
      const idxs = g.members
        .map((k) => indexOf.get(k)!)
        .filter((i) => i !== undefined)
        .sort((a, b) => a - b);
      const rep = idxs[0];
      // The first group keeps the anchor (when there is one); split-out
      // groups become new ideas of their own.
      const groupAnchor = gi === 0 ? anchor : null;
      idxs.forEach((i, pos) => {
        if (groupAnchor) {
          results[i].matchedKey = groupAnchor.key;
          results[i].enrichedSummary =
            pos === 0 && g.rewrite ? g.rewrite.productSummary : "";
        } else if (pos === 0) {
          results[i].matchedKey = null;
          if (
            g.rewrite &&
            (g.rewrite.productTitle || g.rewrite.productSummary)
          ) {
            results[i].rewrite = g.rewrite;
          }
        } else {
          results[i].matchedKey = `new:${inputs[rep].key}`;
        }
      });
    });
  });

  return { results, model, promptVersion: MATCH_PROMPT_VERSION, called };
}
