import { db } from "./db";
import {
  assertJiraOAuthReady,
  getJiraRedirectUri,
  JIRA_OAUTH_SCOPES,
} from "./jira-oauth-config";
import { buildIssueImages, extractAttachmentIdsFromAdf } from "./jira-attachments";
import type { JiraIssue, JiraProject, JiraVersion } from "./types";
import { parseJsonArray } from "./utils";

const ATLASSIAN_AUTH_URL = "https://auth.atlassian.com";
const ATLASSIAN_API_URL = "https://api.atlassian.com";

export function getJiraAuthUrl(state: string): string {
  assertJiraOAuthReady();

  const clientId = process.env.ATLASSIAN_CLIENT_ID!.trim();
  const redirectUri = getJiraRedirectUri()!;
  const scope = JIRA_OAUTH_SCOPES.join(" ");

  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });

  return `${ATLASSIAN_AUTH_URL}/authorize?${params.toString()}`;
}

export async function exchangeJiraCode(code: string) {
  assertJiraOAuthReady();
  const redirectUri = getJiraRedirectUri()!;
  const response = await fetch(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: process.env.ATLASSIAN_CLIENT_ID!.trim(),
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET!.trim(),
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}

export async function refreshJiraToken(refreshToken: string) {
  const response = await fetch(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.ATLASSIAN_CLIENT_ID!.trim(),
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET!.trim(),
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${await response.text()}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}

export async function getAccessibleResources(accessToken: string) {
  const response = await fetch(`${ATLASSIAN_API_URL}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to get accessible resources: ${await response.text()}`);
  }

  return response.json() as Promise<Array<{ id: string; url: string; name: string }>>;
}

async function getValidConnection(workspaceId: string) {
  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  if (connection.expiresAt.getTime() <= Date.now() + 60_000) {
    const tokens = await refreshJiraToken(connection.refreshToken);
    return db.jiraConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });
  }

  return connection;
}

async function jiraFetch(workspaceId: string, path: string, init?: RequestInit) {
  const connection = await getValidConnection(workspaceId);
  if (!connection) {
    throw new Error("Jira not connected");
  }

  const url = `${ATLASSIAN_API_URL}/ex/jira/${connection.cloudId}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Jira API error (${response.status}): ${await response.text()}`);
  }

  return response.json();
}

function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;

  if (n.type === "text" && typeof n.text === "string") {
    return n.text;
  }

  if (Array.isArray(n.content)) {
    return n.content.map(adfToText).join(n.type === "paragraph" ? "\n" : "");
  }

  return "";
}

function extractAcceptanceCriteria(description: string): string | undefined {
  const match = description.match(/acceptance criteria[:\s]*([\s\S]*?)(?:\n\n|$)/i);
  return match?.[1]?.trim();
}

const JIRA_SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "labels",
  "components",
  "parent",
  "attachment",
];

function mapIssue(issue: Record<string, unknown>): JiraIssue {
  const fields = issue.fields as Record<string, unknown>;
  const issueKey = String(issue.key);
  const descriptionRaw = fields.description;
  const description =
    typeof descriptionRaw === "string"
      ? descriptionRaw
      : adfToText(descriptionRaw);

  const attachments =
    (fields.attachment as Array<{ id: string; filename: string; mimeType: string }>) ?? [];
  const adfIds =
    descriptionRaw && typeof descriptionRaw === "object"
      ? extractAttachmentIdsFromAdf(descriptionRaw)
      : [];
  const images = buildIssueImages(issueKey, attachments, adfIds);

  const labels = (fields.labels as string[]) ?? [];
  const components = ((fields.components as Array<{ name: string }>) ?? []).map(
    (c) => c.name
  );
  const issueType = ((fields.issuetype as { name?: string }) ?? {}).name ?? "Unknown";
  const status = ((fields.status as { name?: string }) ?? {}).name ?? "Unknown";

  const parent = fields.parent as
    | {
        key?: string;
        fields?: {
          summary?: string;
          issuetype?: { name?: string };
        };
      }
    | undefined;

  let parentKey: string | undefined;
  let epicKey: string | undefined;
  let epicSummary: string | undefined;

  if (parent?.key) {
    parentKey = parent.key;
    const parentType = parent.fields?.issuetype?.name ?? "";
    if (parentType === "Epic" || issueType === "Story" || issueType === "Task") {
      if (parentType === "Epic") {
        epicKey = parent.key;
        epicSummary = parent.fields?.summary;
      }
    }
  }

  if (issueType === "Epic") {
    epicKey = String(issue.key);
    epicSummary = String(fields.summary ?? "");
  }

  return {
    id: String(issue.id),
    key: String(issue.key),
    summary: String(fields.summary ?? ""),
    description,
    status,
    issueType,
    labels,
    components,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    parentKey,
    epicKey,
    epicSummary,
    images,
  };
}

export async function fetchJiraAttachmentBytes(
  workspaceId: string,
  attachmentId: string
): Promise<{ bytes: ArrayBuffer; mimeType: string; filename: string }> {
  const meta = (await jiraFetch(
    workspaceId,
    `/rest/api/3/attachment/${attachmentId}`
  )) as { content: string; mimeType: string; filename: string };

  const connection = await getValidConnection(workspaceId);
  if (!connection) throw new Error("Jira not connected");

  const response = await fetch(meta.content, {
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment (${response.status})`);
  }

  return {
    bytes: await response.arrayBuffer(),
    mimeType: meta.mimeType ?? "application/octet-stream",
    filename: meta.filename ?? "attachment",
  };
}

export async function listJiraProjects(workspaceId: string): Promise<JiraProject[]> {
  const data = (await jiraFetch(workspaceId, "/rest/api/3/project/search?maxResults=50")) as {
    values: Array<{ id: string; key: string; name: string }>;
  };

  return data.values.map((p) => ({ id: p.id, key: p.key, name: p.name }));
}

export async function listJiraVersions(
  workspaceId: string,
  projectKey: string
): Promise<JiraVersion[]> {
  const data = (await jiraFetch(
    workspaceId,
    `/rest/api/3/project/${projectKey}/versions`
  )) as Array<{ id: string; name: string; released: boolean; releaseDate?: string }>;

  return data.map((v) => ({
    id: v.id,
    name: v.name,
    released: v.released,
    releaseDate: v.releaseDate,
  }));
}

interface JqlSearchPage {
  issues?: Array<Record<string, unknown>>;
  isLast?: boolean;
  nextPageToken?: string;
}

async function searchJira(
  workspaceId: string,
  jql: string,
  maxResults = 100
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  while (issues.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      maxResults: Math.min(100, maxResults - issues.length),
      fields: JIRA_SEARCH_FIELDS,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const data = (await jiraFetch(workspaceId, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    })) as JqlSearchPage;

    const page = data.issues ?? [];
    issues.push(...page.map(mapIssue));

    if (data.isLast || !data.nextPageToken || page.length === 0) {
      break;
    }
    nextPageToken = data.nextPageToken;
  }

  return issues.slice(0, maxResults);
}

export interface IssueScopeParams {
  projectKey: string;
  versionName?: string;
  epicKey?: string;
  statuses?: string[];
}

export async function fetchIssuesForScope(
  workspaceId: string,
  params: IssueScopeParams
): Promise<JiraIssue[]> {
  const clauses: string[] = [`project = "${params.projectKey}"`];

  if (params.versionName) {
    clauses.push(`fixVersion = "${params.versionName}"`);
  }

  if (params.epicKey) {
    clauses.push(`(parent = ${params.epicKey} OR key = ${params.epicKey})`);
  }

  if (params.statuses?.length) {
    const statusList = params.statuses.map((s) => `"${s}"`).join(", ");
    clauses.push(`status in (${statusList})`);
  }

  const jql = `${clauses.join(" AND ")} ORDER BY issuetype ASC, key ASC`;
  return searchJira(workspaceId, jql, 100);
}

export async function fetchEpicsForProject(
  workspaceId: string,
  projectKey: string
): Promise<JiraIssue[]> {
  return searchJira(
    workspaceId,
    `project = "${projectKey}" AND issuetype = Epic ORDER BY updated DESC`,
    50
  );
}

export async function fetchIssuesForVersion(
  workspaceId: string,
  projectKey: string,
  versionName: string
): Promise<JiraIssue[]> {
  return searchJira(
    workspaceId,
    `project = "${projectKey}" AND fixVersion = "${versionName}" ORDER BY issuetype ASC, key ASC`
  );
}

export async function searchIssuesByText(
  workspaceId: string,
  text: string,
  projectKey?: string,
  limit = 25
): Promise<JiraIssue[]> {
  const sanitized = text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!sanitized) return [];

  const clauses: string[] = [];
  if (projectKey) clauses.push(`project = "${projectKey}"`);
  clauses.push(`text ~ "${sanitized}"`);

  return searchJira(workspaceId, `${clauses.join(" AND ")} ORDER BY updated DESC`, limit);
}

export async function fetchEpicsForProjects(
  workspaceId: string,
  projectKeys: string[],
  limit = 100
): Promise<JiraIssue[]> {
  if (projectKeys.length === 0) return [];
  const projectList = projectKeys.map((k) => `"${k}"`).join(", ");
  return searchJira(
    workspaceId,
    `project in (${projectList}) AND issuetype = Epic ORDER BY updated DESC`,
    limit
  );
}

export async function fetchIssuesByKeys(
  workspaceId: string,
  keys: string[]
): Promise<JiraIssue[]> {
  if (keys.length === 0) return [];
  return searchJira(workspaceId, `key in (${keys.join(",")})`);
}

export async function fetchRecentDoneIssues(
  workspaceId: string,
  projectKey: string,
  limit = 30
): Promise<JiraIssue[]> {
  return searchJira(
    workspaceId,
    `project = "${projectKey}" AND status = Done ORDER BY updated DESC`,
    limit
  );
}

export async function addJiraComment(
  workspaceId: string,
  issueKey: string,
  body: string
) {
  await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    }),
  });
}

export async function getJiraConnectionStatus(workspaceId: string) {
  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  return {
    siteUrl: connection.siteUrl,
    projectKeys: parseJsonArray(connection.projectKeys),
    prdSource: connection.prdSource,
    connected: true,
  };
}

export function buildIssueContext(issues: JiraIssue[]): string {
  return issues
    .map((issue) => {
      const parts = [
        `[${issue.key}] ${issue.summary}`,
        `Type: ${issue.issueType} | Status: ${issue.status}`,
        issue.description ? `Description: ${issue.description}` : "",
        issue.acceptanceCriteria
          ? `Acceptance Criteria: ${issue.acceptanceCriteria}`
          : "",
        issue.labels.length ? `Labels: ${issue.labels.join(", ")}` : "",
        issue.components.length ? `Components: ${issue.components.join(", ")}` : "",
      ];
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");
}
