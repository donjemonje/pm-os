import { db } from "./db";
import { decryptSecret, encryptSecret } from "./two-factor";
import {
  assertJiraOAuthReady,
  getJiraRedirectUri,
  JIRA_OAUTH_SCOPES,
} from "./jira-oauth-config";
import { adfToMarkdown, markdownToAdf } from "./jira-adf";
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

/** The Atlassian account behind an access token (name + email), for "Connected by". */
export async function getAtlassianMe(accessToken: string): Promise<{ name: string | null; email: string | null }> {
  const response = await fetch(`${ATLASSIAN_API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Failed to read the Atlassian profile: ${await response.text()}`);
  const me = (await response.json()) as { name?: string; email?: string; nickname?: string };
  return { name: me.name ?? me.nickname ?? null, email: me.email ?? null };
}

/**
 * True when a Jira connection exists AND its token is usable (fresh, or
 * refreshable with the configured Atlassian OAuth creds). A configured but
 * dead connection is "not connected" for anything that needs to write.
 */
export type JiraHealth = {
  status: "not_connected" | "ok" | "reconnect";
  /** Why a reconnect is needed, for the UI. */
  detail?: string;
};

/**
 * Connection health for the UI: no row, usable (fresh or refreshed just
 * now), or dead (refresh failed / OAuth creds missing) — the user must go
 * through Settings → Integrations → Reconnect. One refresh call at most.
 */
export async function getJiraHealth(workspaceId: string): Promise<JiraHealth> {
  const row = await db.jiraConnection.findUnique({
    where: { workspaceId },
    select: { id: true, authType: true, expiresAt: true, apiTokenExpiresAt: true },
  });
  if (!row) return { status: "not_connected" };
  if (row.authType === "basic" && row.apiTokenExpiresAt && row.apiTokenExpiresAt.getTime() <= Date.now()) {
    return { status: "reconnect", detail: "The PM-OS user's API token expired — a PM-OS admin pastes a new one in Admin → Ideas." };
  }
  try {
    const ok = await getValidConnection(workspaceId);
    return ok
      ? { status: "ok" }
      : { status: "reconnect", detail: "The token expired and cannot be refreshed here." };
  } catch (err) {
    return {
      status: "reconnect",
      detail: err instanceof Error ? err.message.slice(0, 160) : "Token refresh failed.",
    };
  }
}

export async function hasValidJiraConnection(workspaceId: string): Promise<boolean> {
  try {
    return (await getValidConnection(workspaceId)) !== null;
  } catch {
    return false;
  }
}

type JiraConnectionRow = NonNullable<
  Awaited<ReturnType<typeof db.jiraConnection.findUnique>>
>;

/**
 * Two auth styles share every call below:
 * - "oauth" (product): Bearer token against api.atlassian.com/ex/jira/<cloudId>.
 * - "basic" (QA only): email + API token (stored base64-encoded in
 *   accessToken) against the site URL itself. Lets the e2e suite hold a
 *   connection to the TEST project across DB resets — OAuth refresh tokens
 *   rotate on use, so a seeded one would die after the first refresh.
 */
/**
 * Tokens are sealed at rest (AES-GCM, "enc:" prefix). Rows written before
 * sealing (no prefix) still read as plain text — no migration needed; they
 * are re-sealed on the next refresh or reconnect.
 */
export function sealToken(value: string): string {
  return value ? `enc:${encryptSecret(value)}` : value;
}
export function openToken(stored: string): string {
  return stored.startsWith("enc:") ? decryptSecret(stored.slice(4)) : stored;
}

function authHeader(connection: JiraConnectionRow): string {
  const token = openToken(connection.accessToken);
  return connection.authType === "basic" ? `Basic ${token}` : `Bearer ${token}`;
}

function apiBase(connection: JiraConnectionRow): string {
  return connection.authType === "basic"
    ? connection.siteUrl.replace(/\/+$/, "")
    : `${ATLASSIAN_API_URL}/ex/jira/${connection.cloudId}`;
}

/** Value for JiraConnection.accessToken when authType is "basic". */
export function basicAuthToken(email: string, apiToken: string): string {
  return Buffer.from(`${email.trim()}:${apiToken.trim()}`, "utf8").toString("base64");
}

async function getValidConnection(workspaceId: string) {
  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) return null;

  // API tokens don't expire on a schedule — nothing to refresh.
  if (connection.authType === "basic") return connection;

  if (connection.expiresAt.getTime() <= Date.now() + 60_000) {
    // Without Atlassian OAuth credentials a refresh is impossible; report
    // "not connected" instead of crashing on the missing env.
    if (
      !process.env.ATLASSIAN_CLIENT_ID?.trim() ||
      !process.env.ATLASSIAN_CLIENT_SECRET?.trim()
    ) {
      return null;
    }
    const tokens = await refreshJiraToken(openToken(connection.refreshToken));
    return db.jiraConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: sealToken(tokens.access_token),
        refreshToken: sealToken(tokens.refresh_token),
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

  const url = `${apiBase(connection)}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(connection),
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
  "priority",
  "reporter",
  "assignee",
  "created",
  "labels",
  "components",
  "parent",
  "attachment",
];

interface MapIssueOptions {
  /** Custom field id whose value is the issue's product line (the field
   *  mapped as Product Line in Admin → Ideas, e.g. Kela's Module). */
  productLineFieldId?: string;
  /** Custom text fields holding the reporter / assignee NAME when the
   *  system fields don't (an import on Jira Free can't map users; Kela's
   *  demo keeps the names in P_Reporter / P_Assignee). Unset = system fields. */
  reporterFieldId?: string;
  assigneeFieldId?: string;
}

function userName(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as { displayName?: unknown; name?: unknown };
    if (typeof o.displayName === "string" && o.displayName.trim()) return o.displayName.trim();
    if (typeof o.name === "string" && o.name.trim()) return o.name.trim();
  }
  return undefined;
}

/**
 * Read a product-line value whatever shape Jira stores it in: single-select
 * option ({value}), name-bearing object ({name}), plain string, or an array
 * of those (multi-select / labels-style). Anything else → undefined.
 */
export function readProductLineValue(raw: unknown): string | undefined {
  const one = (v: unknown): string | undefined => {
    if (typeof v === "string") return v.trim() || undefined;
    if (v && typeof v === "object") {
      const o = v as { value?: unknown; name?: unknown };
      if (typeof o.value === "string" && o.value.trim()) return o.value.trim();
      if (typeof o.name === "string" && o.name.trim()) return o.name.trim();
    }
    return undefined;
  };
  if (Array.isArray(raw)) {
    const first = raw.map(one).find(Boolean);
    return first;
  }
  return one(raw);
}

function mapIssue(issue: Record<string, unknown>, opts: MapIssueOptions = {}): JiraIssue {
  const fields = issue.fields as Record<string, unknown>;
  const issueKey = String(issue.key);
  const productLine = opts.productLineFieldId
    ? readProductLineValue(fields[opts.productLineFieldId])
    : undefined;
  const priority = ((fields.priority as { name?: string }) ?? {}).name || undefined;
  const reporter =
    (opts.reporterFieldId ? userName(fields[opts.reporterFieldId]) : undefined) ??
    userName(fields.reporter);
  const assignee =
    (opts.assigneeFieldId ? userName(fields[opts.assigneeFieldId]) : undefined) ??
    userName(fields.assignee);
  const created = typeof fields.created === "string" ? fields.created : undefined;
  const descriptionRaw = fields.description;
  // Markdown, so headings / bold / lists / links survive into PM-OS and the
  // raw Jira issue reads as close to Jira as possible.
  const description =
    typeof descriptionRaw === "string"
      ? descriptionRaw
      : adfToMarkdown(descriptionRaw);

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
    productLine,
    priority,
    reporter,
    assignee,
    created,
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
      Authorization: authHeader(connection),
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

interface SearchOptions extends MapIssueOptions {
  /** Extra field ids to request on top of JIRA_SEARCH_FIELDS. */
  extraFields?: string[];
}

export interface PagedIssues {
  issues: JiraIssue[];
  /** True when the cap stopped the walk while Jira still had more pages —
   *  the caller reports it; nothing is dropped silently. */
  truncated: boolean;
}

/**
 * Walk the JQL search pages (Jira serves at most 100 per page) up to
 * maxResults issues. The cap is a ceiling, never a page size.
 */
async function searchJiraPaged(
  workspaceId: string,
  jql: string,
  maxResults = 100,
  opts: SearchOptions = {}
): Promise<PagedIssues> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let truncated = false;
  const fields = opts.extraFields?.length
    ? Array.from(new Set([...JIRA_SEARCH_FIELDS, ...opts.extraFields]))
    : JIRA_SEARCH_FIELDS;

  while (issues.length < maxResults) {
    const body: Record<string, unknown> = {
      jql,
      maxResults: Math.min(100, maxResults - issues.length),
      fields,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const data = (await jiraFetch(workspaceId, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    })) as JqlSearchPage;

    const page = data.issues ?? [];
    issues.push(...page.map((issue) => mapIssue(issue, opts)));

    if (data.isLast || !data.nextPageToken || page.length === 0) {
      break;
    }
    nextPageToken = data.nextPageToken;
    if (issues.length >= maxResults) truncated = true;
  }

  return { issues: issues.slice(0, maxResults), truncated };
}

async function searchJira(
  workspaceId: string,
  jql: string,
  maxResults = 100,
  opts: SearchOptions = {}
): Promise<JiraIssue[]> {
  return (await searchJiraPaged(workspaceId, jql, maxResults, opts)).issues;
}

/** JQL string literal — Jira's escape is a backslash before quote/backslash. */
function jqlString(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export interface IssueScopeParams {
  projectKey: string;
  versionName?: string;
  epicKey?: string;
  statuses?: string[];
  /** Status names to leave out (`status not in (…)`). */
  excludeStatuses?: string[];
  /** Ceiling on issues returned; default 100 for the legacy callers. */
  maxResults?: number;
  /** Custom field id read as the issue's product line. */
  productLineFieldId?: string;
  /** Custom text field ids read as reporter / assignee names (see MapIssueOptions). */
  reporterFieldId?: string;
  assigneeFieldId?: string;
}

function scopeJql(params: IssueScopeParams): string {
  const clauses: string[] = [`project = ${jqlString(params.projectKey)}`];

  if (params.versionName) {
    clauses.push(`fixVersion = ${jqlString(params.versionName)}`);
  }

  if (params.epicKey) {
    clauses.push(`(parent = ${params.epicKey} OR key = ${params.epicKey})`);
  }

  if (params.statuses?.length) {
    clauses.push(`status in (${params.statuses.map(jqlString).join(", ")})`);
  }

  if (params.excludeStatuses?.length) {
    clauses.push(`status not in (${params.excludeStatuses.map(jqlString).join(", ")})`);
  }

  return `${clauses.join(" AND ")} ORDER BY issuetype ASC, key ASC`;
}

/** Same as fetchIssuesForScope, plus whether the cap cut the result. */
export async function fetchIssuesForScopePaged(
  workspaceId: string,
  params: IssueScopeParams
): Promise<PagedIssues> {
  const fieldId = params.productLineFieldId?.trim() || undefined;
  const reporterFieldId = params.reporterFieldId?.trim() || undefined;
  const assigneeFieldId = params.assigneeFieldId?.trim() || undefined;
  return searchJiraPaged(workspaceId, scopeJql(params), params.maxResults ?? 100, {
    productLineFieldId: fieldId,
    reporterFieldId,
    assigneeFieldId,
    extraFields: [fieldId, reporterFieldId, assigneeFieldId].filter((x): x is string => Boolean(x)),
  });
}

export async function fetchIssuesForScope(
  workspaceId: string,
  params: IssueScopeParams
): Promise<JiraIssue[]> {
  return (await fetchIssuesForScopePaged(workspaceId, params)).issues;
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
 * Markdown → ADF (jira-adf.ts): the idea text PMOS AI writes (## headings,
 * lists, bold, links) lands in Jira as real headings and lists. Deterministic
 * — what the preview shows is exactly what Jira receives.
 */
export function textToAdf(text: string): { type: string; version: number; content: unknown[] } {
  return markdownToAdf(text);
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
 *  Custom fields ("Votes", "P_Components", …) can only be written by id.
 *  Team-managed projects own project-scoped fields that may share a name with
 *  a site-wide one (RoomLens's "P_Votes" vs the global "P_Votes" written on
 *  PRDT) — the global field wins a name clash, since only it can sit on a
 *  company-managed project's screens. */
export async function listAllFields(
  workspaceId: string
): Promise<Map<string, { id: string; name: string }>> {
  const data = (await jiraFetch(workspaceId, "/rest/api/3/field")) as Array<{
    id: string;
    name: string;
    custom?: boolean;
    scope?: { type?: string; project?: { id?: string } };
  }>;
  // Rank on a name clash: site-wide custom field > project-scoped custom
  // field > system field. Only custom fields are mapping targets, and a
  // customer may name theirs "Votes" next to Jira's built-in Votes.
  const rank = (f: { custom?: boolean; scope?: { project?: { id?: string } } }) =>
    !f.custom ? 0 : f.scope?.project ? 1 : 2;
  const byName = new Map<string, { id: string; name: string; rank: number }>();
  for (const f of data ?? []) {
    const key = f.name.toLowerCase();
    const r = rank(f);
    const cur = byName.get(key);
    if (!cur || r > cur.rank) byName.set(key, { id: f.id, name: f.name, rank: r });
  }
  return new Map(Array.from(byName, ([k, v]) => [k, { id: v.id, name: v.name }]));
}

/**
 * Add select options to the mapped field's context that covers `projectKey`
 * (the project-specific context when one exists, else the global one). Needs
 * manage:jira-configuration; a 403 means the connection predates that scope.
 * Returns the values actually added (already-present ones are skipped).
 */
export async function ensureFieldOptions(
  workspaceId: string,
  fieldId: string,
  projectKey: string,
  values: string[]
): Promise<string[]> {
  if (values.length === 0) return [];
  const project = (await jiraFetch(workspaceId, `/rest/api/3/project/${projectKey}`)) as { id: string };
  const mapping = (await jiraFetch(
    workspaceId,
    `/rest/api/3/field/${fieldId}/context/projectmapping?maxResults=100`
  )) as { values?: Array<{ contextId: string; projectId?: string; isGlobalContext?: boolean }> };
  const rows = mapping.values ?? [];
  const ctx =
    rows.find((r) => r.projectId === String(project.id)) ?? rows.find((r) => r.isGlobalContext);
  if (!ctx) throw new Error(`Jira field ${fieldId} has no option context covering ${projectKey}`);
  const existing = (await jiraFetch(
    workspaceId,
    `/rest/api/3/field/${fieldId}/context/${ctx.contextId}/option?maxResults=1000`
  )) as { values?: Array<{ value: string }> };
  const have = new Set((existing.values ?? []).map((o) => o.value.toLowerCase()));
  const toAdd = values.filter((v) => !have.has(v.toLowerCase()));
  if (toAdd.length === 0) return [];
  await jiraFetch(workspaceId, `/rest/api/3/field/${fieldId}/context/${ctx.contextId}/option`, {
    method: "POST",
    body: JSON.stringify({ options: toAdd.map((value) => ({ value, disabled: false })) }),
  });
  return toAdd;
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
  // Jira caps a search page at 100 — more reviewed updates than that must not
  // be reported as "no longer exists".
  const issues: Array<Record<string, unknown>> = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const data = (await jiraFetch(workspaceId, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql: `key in (${chunk.join(",")})`,
        maxResults: 100,
        fields: ["summary", "description", "labels", "components", ...extraFieldIds],
      }),
    })) as JqlSearchPage;
    issues.push(...(data.issues ?? []));
  }

  return issues.map((issue) => {
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
      descriptionText: typeof raw === "string" ? raw : adfToMarkdown(raw),
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
    connectedByName: connection.connectedByName,
    connectedByEmail: connection.connectedByEmail,
    authType: connection.authType,
    apiTokenExpiresAt: connection.apiTokenExpiresAt?.toISOString() ?? null,
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

/**
 * Checks a dedicated-user API token against the site (GET /myself with basic
 * auth) and returns who it is. Throws with Jira's answer when it is refused.
 */
export async function validateBasicCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
): Promise<{ displayName: string; accountId: string; emailAddress: string | null }> {
  const base = siteUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${basicAuthToken(email, apiToken)}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Jira refused the email + token (401). Check both, and that the user is active on this site."
        : `Jira answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const me = (await response.json()) as { displayName?: string; accountId?: string; emailAddress?: string };
  return { displayName: me.displayName ?? email, accountId: me.accountId ?? "", emailAddress: me.emailAddress ?? null };
}
