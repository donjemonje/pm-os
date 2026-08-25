import type { AggregationResult, Citation, DocumentAudience, GoogleDriveFileContent, JiraIssue } from "./types";
import { AiQuotaError, isAiEnabled } from "./ai-config";
import { generateText } from "./ai-providers";
import { generateReleaseNotesTemplate, generateUserManualTemplate } from "./doc-templates";
import {
  buildUserManualAiContext,
  buildPrettyUserManual,
  injectJiraImagesIntoMarkdown,
} from "./um-builder";

const AGGREGATION_CACHE_TTL_MS = Number(
  process.env.AI_AGGREGATION_CACHE_TTL_MS ?? 30 * 60 * 1000
);

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  return brace?.[0] ?? text;
}

function compactIssueForPrompt(i: JiraIssue): string {
  return `[${i.key}] ${i.summary} (${i.issueType}, ${i.status})
Epic: ${i.epicKey ?? "none"}
Description: ${(i.description || "").slice(0, 500)}
AC: ${(i.acceptanceCriteria ?? "N/A").slice(0, 400)}`;
}

export {
  AiQuotaError,
  isAiEnabled,
  getAiProvider,
  formatApiAiError,
  shouldUseTemplateOnQuota,
} from "./ai-config";
export { generateUserManualTemplate, generateReleaseNotesTemplate } from "./doc-templates";

export async function generateReleaseNotes(
  releaseName: string,
  issues: JiraIssue[],
  options?: { cacheScope?: string }
): Promise<string> {
  const issueSummary = issues
    .map(
      (i) =>
        `- ${i.key}: ${i.summary} (${i.issueType}, ${i.status})${i.description ? `\n  ${i.description.slice(0, 200)}` : ""}`
    )
    .join("\n");

  try {
    return await generateText(
      `You are a product manager writing release notes for "${releaseName}".

Use ONLY the Jira issues below. Do not invent features or issue keys.

Structure the release notes in Markdown with these sections:
## Highlights
## New Features
## Improvements
## Bug Fixes
## Known Issues (only if evident from data, otherwise omit)

Issues:
${issueSummary || "No issues provided."}`,
      { cacheScope: options?.cacheScope }
    );
  } catch (error) {
    if (error instanceof AiQuotaError) {
      return generateReleaseNotesTemplate(releaseName, issues);
    }
    throw error;
  }
}

export async function generateUserManualSection(
  title: string,
  issues: JiraIssue[],
  audience: DocumentAudience = "external",
  driveFiles: GoogleDriveFileContent[] = [],
  options?: { cacheScope?: string }
): Promise<{ body: string; usedTemplate: boolean }> {
  const hasImages = issues.some((i) => (i.images?.length ?? 0) > 0);

  try {
    let body = await generateText(
      buildUserManualAiContext(title, issues, audience, driveFiles),
      { cacheScope: options?.cacheScope }
    );
    body = injectJiraImagesIntoMarkdown(body, issues);
    if (body.length < 200 && (hasImages || driveFiles.length > 0)) {
      body = buildPrettyUserManual(title, issues, audience, driveFiles);
    }
    return { body, usedTemplate: false };
  } catch (error) {
    if (error instanceof AiQuotaError) {
      return {
        body: buildPrettyUserManual(title, issues, audience, driveFiles),
        usedTemplate: true,
      };
    }
    throw error;
  }
}

export async function aggregateTicketsWithAI(
  issues: JiraIssue[]
): Promise<AggregationResult> {
  const compact = issues.map((i) => ({
    key: i.key,
    summary: i.summary,
    type: i.issueType,
    status: i.status,
    epicKey: i.epicKey,
    components: i.components,
  }));

  const raw = await generateText(
    `Group Jira tickets for user-manual documentation. Return JSON only:
{"groups":[{"id":"id","label":"name","reason":"why","issueKeys":["KEY"]}],"suggestedKeys":["KEY"]}

Tickets:
${JSON.stringify(compact)}`,
    { cacheTtlMs: AGGREGATION_CACHE_TTL_MS }
  );

  try {
    const parsed = JSON.parse(extractJsonBlock(raw)) as {
      groups: Array<{
        id: string;
        label: string;
        reason: string;
        issueKeys: string[];
      }>;
      suggestedKeys: string[];
    };

    const validKeys = new Set(issues.map((i) => i.key));
    const groups = (parsed.groups ?? [])
      .map((g) => ({
        ...g,
        issueKeys: g.issueKeys.filter((k) => validKeys.has(k)),
      }))
      .filter((g) => g.issueKeys.length > 0);

    const suggestedKeys = (parsed.suggestedKeys ?? []).filter((k) => validKeys.has(k));

    return {
      issues,
      groups,
      suggestedKeys: suggestedKeys.length > 0 ? suggestedKeys : groups.flatMap((g) => g.issueKeys),
    };
  } catch {
    const allKeys = issues.map((i) => i.key);
    return {
      issues,
      groups: [
        {
          id: "all",
          label: "All tickets in scope",
          reason: "AI grouping unavailable — showing all",
          issueKeys: allKeys,
        },
      ],
      suggestedKeys: allKeys,
    };
  }
}

export async function answerPrdQuestion(
  question: string,
  issues: JiraIssue[],
  documentContext?: string,
  options?: { cacheScope?: string }
): Promise<{ answer: string; citations: Citation[]; confidence: "high" | "medium" | "low" }> {
  const issueContext = issues.map(compactIssueForPrompt).join("\n\n---\n\n");

  try {
    const prompt = `Answer developer PRD questions. Return JSON only:
{"answer":"markdown","citations":[{"issueKey":"KEY","snippet":"quote","field":"summary"}],"confidence":"high|medium|low"}

Question: ${question}

Jira:
${issueContext || "None"}

Doc:
${(documentContext ?? "None").slice(0, 1500)}`;

    const raw = await generateText(prompt, { cacheScope: options?.cacheScope });

    const parsed = JSON.parse(extractJsonBlock(raw)) as {
      answer: string;
      citations: Citation[];
      confidence: "high" | "medium" | "low";
    };
    return {
      answer: parsed.answer ?? "I couldn't find enough information in the PRD.",
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      confidence: parsed.confidence ?? "low",
    };
  } catch (error) {
    if (error instanceof AiQuotaError) {
      const top = issues[0];
      return {
        answer: `AI quota is unavailable right now. Check Jira directly: ${issues.map((i) => `**${i.key}** ${i.summary}`).join("; ") || "no issues in context"}.`,
        citations: top
          ? [{ issueKey: top.key, snippet: top.summary, field: "summary" }]
          : [],
        confidence: "low",
      };
    }
    throw error;
  }
}

export interface OrgAnswerContext {
  issues: JiraIssue[];
  driveFiles: GoogleDriveFileContent[];
  notes?: string[];
}

function sanitizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is Record<string, unknown> =>
        Boolean(c) && typeof c === "object" && typeof (c as Record<string, unknown>).snippet === "string"
    )
    .map((c) => ({
      source: c.source === "drive" ? ("drive" as const) : ("jira" as const),
      issueKey: typeof c.issueKey === "string" ? c.issueKey : undefined,
      driveFileId: typeof c.driveFileId === "string" ? c.driveFileId : undefined,
      driveFileName: typeof c.driveFileName === "string" ? c.driveFileName : undefined,
      snippet: String(c.snippet).slice(0, 300),
      field: typeof c.field === "string" ? c.field : undefined,
    }))
    .slice(0, 10);
}

export async function answerOrgQuestion(
  question: string,
  context: OrgAnswerContext,
  recentTurns: Array<{ role: string; content: string }> = [],
  options?: { cacheScope?: string }
): Promise<{ answer: string; citations: Citation[]; confidence: "high" | "medium" | "low" }> {
  const issueContext = context.issues
    .slice(0, 30)
    .map(compactIssueForPrompt)
    .join("\n\n---\n\n");
  const driveContext = context.driveFiles
    .slice(0, 3)
    .map((f) => `[Doc: ${f.name}] (id: ${f.id})\n${f.text.slice(0, 3000)}`)
    .join("\n\n---\n\n");
  const transcript = recentTurns
    .slice(-4)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`)
    .join("\n");
  const notes = context.notes?.length ? `Notes: ${context.notes.join("; ")}` : "";

  try {
    const prompt = `You are PMOS, a product-management assistant. Answer the question using ONLY the org data below. Return JSON only:
{"answer":"markdown","citations":[{"source":"jira","issueKey":"KEY","snippet":"short quote"},{"source":"drive","driveFileId":"id","driveFileName":"doc name","snippet":"short quote"}],"confidence":"high|medium|low"}
- Cite the tickets/docs that support each part of the answer.
- If the data does not answer the question, say so plainly and set confidence "low". Never invent tickets, docs, or statuses.

Question: ${question}
${notes ? `\n${notes}\n` : ""}
Jira issues:
${issueContext || "None"}

Drive docs:
${driveContext || "None"}

Recent conversation:
${transcript || "None"}`;

    const raw = await generateText(prompt, { cacheScope: options?.cacheScope });
    const parsed = JSON.parse(extractJsonBlock(raw)) as {
      answer?: string;
      citations?: unknown;
      confidence?: "high" | "medium" | "low";
    };

    return {
      answer: parsed.answer ?? "I couldn't find enough information in the connected sources.",
      citations: sanitizeCitations(parsed.citations),
      confidence: parsed.confidence ?? "low",
    };
  } catch (error) {
    if (error instanceof AiQuotaError) {
      const top = context.issues[0];
      return {
        answer: `AI quota is unavailable right now. Closest matches found: ${
          [
            ...context.issues.slice(0, 5).map((i) => `**${i.key}** ${i.summary}`),
            ...context.driveFiles.map((f) => `**${f.name}** (Drive)`),
          ].join("; ") || "none"
        }.`,
        citations: top
          ? [{ source: "jira", issueKey: top.key, snippet: top.summary, field: "summary" }]
          : [],
        confidence: "low",
      };
    }
    throw error;
  }
}

export async function chatAssist(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  systemContext: string,
  options?: { cacheScope?: string }
): Promise<string> {
  const transcript = messages
    .slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 800)}`)
    .join("\n\n");

  const systemInstruction = `You are PMOS. Be concise. Context:\n${systemContext.slice(0, 2000)}`;

  return generateText(transcript, {
    systemInstruction,
    cacheTtlMs: 0,
    cacheScope: options?.cacheScope,
  });
}
