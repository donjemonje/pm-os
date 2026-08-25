import type { GoogleDriveFileContent, JiraIssue } from "./types";
import { generateText } from "./ai-providers";
import {
  fetchIssuesByKeys,
  fetchIssuesForScope,
  searchIssuesByText,
} from "./jira";
import {
  fetchGoogleDriveFileContents,
  searchGoogleDriveFullText,
} from "./google-drive";
import type { OrgCatalog } from "./org-catalog";

export interface RetrievalPlan {
  jira?: {
    issueKeys?: string[];
    projectKey?: string;
    epicKey?: string;
    text?: string;
  };
  drive?: {
    fileIds?: string[];
    search?: string;
  };
}

export interface RetrievedContext {
  issues: JiraIssue[];
  driveFiles: GoogleDriveFileContent[];
  /** Human-readable notes about sources that were skipped or failed. */
  notes: string[];
  /** False when the plan called for no retrieval at all (general chat). */
  used: boolean;
}

const MAX_ISSUES = 30;
const MAX_ISSUE_KEYS = 10;
const MAX_DRIVE_FILES = 3;

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PROJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const FILE_ID_RE = /^[\w-]+$/;

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  return brace?.[0] ?? text;
}

function sanitizePlan(raw: unknown, catalog: OrgCatalog): RetrievalPlan {
  const plan: RetrievalPlan = {};
  if (!raw || typeof raw !== "object") return plan;
  const r = raw as { jira?: Record<string, unknown>; drive?: Record<string, unknown> };

  if (catalog.jiraConnected && r.jira && typeof r.jira === "object") {
    const issueKeys = Array.isArray(r.jira.issueKeys)
      ? r.jira.issueKeys
          .filter((k): k is string => typeof k === "string" && ISSUE_KEY_RE.test(k.trim()))
          .map((k) => k.trim().toUpperCase())
          .slice(0, MAX_ISSUE_KEYS)
      : [];
    const projectKey =
      typeof r.jira.projectKey === "string" && PROJECT_KEY_RE.test(r.jira.projectKey.trim())
        ? r.jira.projectKey.trim().toUpperCase()
        : undefined;
    const epicKey =
      typeof r.jira.epicKey === "string" && ISSUE_KEY_RE.test(r.jira.epicKey.trim())
        ? r.jira.epicKey.trim().toUpperCase()
        : undefined;
    const text =
      typeof r.jira.text === "string" && r.jira.text.trim()
        ? r.jira.text.trim().slice(0, 200)
        : undefined;

    if (issueKeys.length || projectKey || epicKey || text) {
      plan.jira = { issueKeys, projectKey, epicKey, text };
    }
  }

  if (catalog.driveConnected && r.drive && typeof r.drive === "object") {
    const fileIds = Array.isArray(r.drive.fileIds)
      ? r.drive.fileIds
          .filter((id): id is string => typeof id === "string" && FILE_ID_RE.test(id.trim()))
          .map((id) => id.trim())
          .slice(0, MAX_DRIVE_FILES)
      : [];
    const search =
      typeof r.drive.search === "string" && r.drive.search.trim()
        ? r.drive.search.trim().slice(0, 200)
        : undefined;

    if (fileIds.length || search) {
      plan.drive = { fileIds, search };
    }
  }

  return plan;
}

export async function routeChatQuestion(
  question: string,
  catalog: OrgCatalog,
  recentTurns: Array<{ role: string; content: string }>,
  options?: { cacheScope?: string }
): Promise<RetrievalPlan> {
  const transcript = recentTurns
    .slice(-4)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `You route a product-management question to data sources. Return JSON only:
{"jira":{"issueKeys":["KEY-1"],"projectKey":"KEY","epicKey":"KEY-5","text":"free-text search"},"drive":{"fileIds":["driveFileId"],"search":"free-text search"}}

Rules:
- Include "jira" only if Jira tickets/epics would help answer, "drive" only if docs would help. Return {} for small talk or generic questions needing no org data.
- Prefer exact issueKeys / epicKey / fileIds when the catalog below contains an obvious match for what the user mentioned; copy ids EXACTLY from the catalog.
- Otherwise use "text" (Jira) or "search" (Drive) with 2-5 concrete search words, not the whole question.
- Omit any field you don't need.

Catalog of available data:
${catalog.text}

Recent conversation:
${transcript || "None"}

Question: ${question}`;

  const raw = await generateText(prompt, {
    cacheScope: options?.cacheScope,
    model: process.env.AI_ROUTER_MODEL?.trim() || undefined,
  });

  try {
    return sanitizePlan(JSON.parse(extractJsonBlock(raw)), catalog);
  } catch {
    // Router output was unusable — fall back to searching both connected
    // sources with the raw question so the user still gets an answer.
    const fallbackText = question.slice(0, 150);
    const plan: RetrievalPlan = {};
    if (catalog.jiraConnected) plan.jira = { text: fallbackText };
    if (catalog.driveConnected) plan.drive = { search: fallbackText };
    return plan;
  }
}

export async function executeRetrievalPlan(
  workspaceId: string,
  plan: RetrievalPlan
): Promise<RetrievedContext> {
  const result: RetrievedContext = {
    issues: [],
    driveFiles: [],
    notes: [],
    used: Boolean(plan.jira || plan.drive),
  };

  if (plan.jira) {
    try {
      const seen = new Set<string>();
      const collect = (issues: JiraIssue[]) => {
        for (const issue of issues) {
          if (!seen.has(issue.key) && result.issues.length < MAX_ISSUES) {
            seen.add(issue.key);
            result.issues.push(issue);
          }
        }
      };

      if (plan.jira.issueKeys?.length) {
        collect(await fetchIssuesByKeys(workspaceId, plan.jira.issueKeys));
      }
      if (plan.jira.epicKey) {
        const projectKey = plan.jira.projectKey ?? plan.jira.epicKey.split("-")[0];
        collect(await fetchIssuesForScope(workspaceId, { projectKey, epicKey: plan.jira.epicKey }));
      }
      if (plan.jira.text) {
        collect(await searchIssuesByText(workspaceId, plan.jira.text, plan.jira.projectKey));
      }
      if (
        !plan.jira.issueKeys?.length &&
        !plan.jira.epicKey &&
        !plan.jira.text &&
        plan.jira.projectKey
      ) {
        collect(await fetchIssuesForScope(workspaceId, { projectKey: plan.jira.projectKey }));
      }
    } catch (error) {
      result.notes.push(
        `Jira lookup failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`
      );
    }
  }

  if (plan.drive) {
    try {
      const fileIds = [...(plan.drive.fileIds ?? [])];
      if (plan.drive.search && fileIds.length < MAX_DRIVE_FILES) {
        const found = await searchGoogleDriveFullText(workspaceId, plan.drive.search);
        for (const file of found) {
          if (fileIds.length >= MAX_DRIVE_FILES) break;
          if (!fileIds.includes(file.id)) fileIds.push(file.id);
        }
      }
      if (fileIds.length > 0) {
        result.driveFiles = await fetchGoogleDriveFileContents(
          workspaceId,
          fileIds.slice(0, MAX_DRIVE_FILES)
        );
      }
    } catch (error) {
      result.notes.push(
        `Google Drive lookup failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`
      );
    }
  }

  return result;
}
