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

  // Write endpoints (issue PUT) answer 204 with an empty body.
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function adfToText(node: unknown): string {
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

// ————— Ideas write-back (issue create/update) —————

/**
 * Minimal plain-text → ADF: each line becomes a paragraph, blank lines
 * become empty paragraphs. Deterministic on purpose — what the preview
 * shows is exactly what Jira receives.
 */
export function textToAdf(text: string): { type: string; version: number; content: unknown[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const content = lines.map((line) =>
    line.trim().length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph", content: [] }
  );
  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [{ type: "paragraph", content: [] }],
  };
}

export interface JiraComponent {
  id: string;
  name: string;
}

export async function listProjectComponents(
  workspaceId: string,
  projectKey: string
): Promise<JiraComponent[]> {
  const data = (await jiraFetch(
    workspaceId,
    `/rest/api/3/project/${projectKey}/components`
  )) as Array<{ id: string; name: string }> | null;
  return (data ?? []).map((c) => ({ id: String(c.id), name: c.name }));
}

export async function createProjectComponent(
  workspaceId: string,
  projectKey: string,
  name: string
): Promise<JiraComponent> {
  const data = (await jiraFetch(workspaceId, "/rest/api/3/component", {
    method: "POST",
    body: JSON.stringify({ name, project: projectKey }),
  })) as { id: string; name: string };
  return { id: String(data.id), name: data.name };
}

/** Non-subtask issue types available in a project. */
export async function listProjectIssueTypesFull(
  workspaceId: string,
  projectKey: string
): Promise<Array<{ id: string; name: string }>> {
  const data = (await jiraFetch(workspaceId, `/rest/api/3/project/${projectKey}`)) as {
    issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>;
  };
  return (data.issueTypes ?? [])
    .filter((t) => !t.subtask)
    .map((t) => ({ id: String(t.id), name: t.name }));
}

export async function listProjectIssueTypes(
  workspaceId: string,
  projectKey: string
): Promise<string[]> {
  return (await listProjectIssueTypesFull(workspaceId, projectKey)).map((t) => t.name);
}

/** All fields on the site, keyed by lower-cased display name → field id.
 *  Custom fields ("Votes", "P_Components", …) can only be written by id. */
export async function listAllFields(
  workspaceId: string
): Promise<Map<string, { id: string; name: string }>> {
  const data = (await jiraFetch(workspaceId, "/rest/api/3/field")) as Array<{
    id: string;
    name: string;
  }>;
  const byName = new Map<string, { id: string; name: string }>();
  for (const f of data ?? []) byName.set(f.name.toLowerCase(), { id: f.id, name: f.name });
  return byName;
}

export interface JiraFieldMeta {
  /** Option names for select fields; undefined for free-typed fields. */
  allowedValues?: string[];
}

function extractAllowed(field: { allowedValues?: Array<{ value?: string; name?: string }> }) {
  if (!Array.isArray(field.allowedValues)) return undefined;
  return field.allowedValues
    .map((v) => v.value ?? v.name ?? "")
    .filter((v): v is string => Boolean(v));
}

/** Editable fields (with allowed option values) of an existing issue. */
export async function getEditMetaFields(
  workspaceId: string,
  issueKey: string
): Promise<Map<string, JiraFieldMeta>> {
  const data = (await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}/editmeta`)) as {
    fields?: Record<string, { allowedValues?: Array<{ value?: string; name?: string }> }>;
  };
  const out = new Map<string, JiraFieldMeta>();
  for (const [fieldId, meta] of Object.entries(data.fields ?? {})) {
    out.set(fieldId, { allowedValues: extractAllowed(meta) });
  }
  return out;
}

/** Create-screen fields (with allowed option values) for a project + issue type. */
export async function getCreateMetaFields(
  workspaceId: string,
  projectKey: string,
  issueTypeName: string
): Promise<Map<string, JiraFieldMeta>> {
  const types = await listProjectIssueTypesFull(workspaceId, projectKey);
  const type = types.find((t) => t.name.toLowerCase() === issueTypeName.toLowerCase());
  const out = new Map<string, JiraFieldMeta>();
  if (!type) return out;
  const data = (await jiraFetch(
    workspaceId,
    `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${type.id}?maxResults=200`
  )) as {
    fields?: Array<{ fieldId?: string; key?: string; allowedValues?: Array<{ value?: string; name?: string }> }>;
    values?: Array<{ fieldId?: string; key?: string; allowedValues?: Array<{ value?: string; name?: string }> }>;
  };
  for (const f of data.fields ?? data.values ?? []) {
    const id = f.fieldId ?? f.key;
    if (id) out.set(id, { allowedValues: extractAllowed(f) });
  }
  return out;
}

/**
 * Issues with their raw ADF descriptions — the write-back path edits the
 * original ADF (append/replace our section) instead of round-tripping
 * through plain text, so customer formatting is never destroyed.
 */
export interface JiraIssueRaw {
  key: string;
  summary: string;
  labels: string[];
  components: string[];
  descriptionAdf: unknown | null;
  descriptionText: string;
  /** Values of the extra (custom) fields requested, keyed by field id. */
  extra: Record<string, unknown>;
}

export async function fetchIssuesRaw(
  workspaceId: string,
  keys: string[],
  extraFieldIds: string[] = []
): Promise<JiraIssueRaw[]> {
  if (keys.length === 0) return [];
  const data = (await jiraFetch(workspaceId, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql: `key in (${keys.join(",")})`,
      maxResults: Math.max(keys.length, 100),
      fields: ["summary", "description", "labels", "components", ...extraFieldIds],
    }),
  })) as JqlSearchPage;

  return (data.issues ?? []).map((issue) => {
    const fields = issue.fields as Record<string, unknown>;
    const raw = fields.description;
    const extra: Record<string, unknown> = {};
    for (const id of extraFieldIds) extra[id] = fields[id];
    return {
      key: String(issue.key),
      summary: String(fields.summary ?? ""),
      labels: (fields.labels as string[]) ?? [],
      components: (((fields.components as Array<{ name: string }>) ?? []).map((c) => c.name)),
      descriptionAdf: raw && typeof raw === "object" ? raw : null,
      descriptionText: typeof raw === "string" ? raw : adfToText(raw),
      extra,
    };
  });
}

export interface JiraIssueWrite {
  summary?: string;
  /** Plain text, converted line-by-line to ADF. Ignored when descriptionAdf is set. */
  description?: string;
  /** Pre-built ADF document — used for updates that preserve existing formatting. */
  descriptionAdf?: unknown;
  /** Full component name set to write. */
  componentNames?: string[];
  /** Full label set to write. */
  labels?: string[];
  /** Custom fields, keyed by field id, values already in Jira's wire shape
   *  (e.g. number, {value}, [{value}]). */
  extraFields?: Record<string, unknown>;
}

function writeFields(input: JiraIssueWrite): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.descriptionAdf !== undefined) fields.description = input.descriptionAdf;
  else if (input.description !== undefined) fields.description = textToAdf(input.description);
  if (input.componentNames !== undefined)
    fields.components = input.componentNames.map((name) => ({ name }));
  if (input.labels !== undefined) fields.labels = input.labels;
  for (const [id, value] of Object.entries(input.extraFields ?? {})) fields[id] = value;
  return fields;
}

/** Comment with a caller-built ADF body (bullet lists etc.). */
export async function addJiraCommentAdf(
  workspaceId: string,
  issueKey: string,
  body: unknown
): Promise<{ id: string | null }> {
  const data = (await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  })) as { id?: string } | null;
  return { id: data?.id ?? null };
}

/** Permanent — Jira Cloud has no trash for issues. Callers confirm first. */
export async function deleteJiraIssue(workspaceId: string, issueKey: string): Promise<void> {
  await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}`, { method: "DELETE" });
}

export async function deleteJiraComment(
  workspaceId: string,
  issueKey: string,
  commentId: string
): Promise<void> {
  await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}/comment/${commentId}`, {
    method: "DELETE",
  });
}

export async function createJiraIssue(
  workspaceId: string,
  params: { projectKey: string; issueTypeName: string } & JiraIssueWrite
): Promise<{ key: string }> {
  const data = (await jiraFetch(workspaceId, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: params.projectKey },
        issuetype: { name: params.issueTypeName },
        ...writeFields(params),
      },
    }),
  })) as { key: string };
  return { key: data.key };
}

export async function updateJiraIssue(
  workspaceId: string,
  issueKey: string,
  input: JiraIssueWrite
): Promise<void> {
  const fields = writeFields(input);
  if (Object.keys(fields).length === 0) return;
  await jiraFetch(workspaceId, `/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

export async function getJiraConnectionStatus(workspaceId: string) {
  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  return {
    siteUrl: connection.siteUrl,
    projectKeys: parseJsonArray(connection.projectKeys),
    prdSource: connection.prdSource,
    ideasProjectKey: connection.ideasProjectKey,
    ideasIssueType: connection.ideasIssueType,
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
