import { db } from "../db";
import { fetchIssuesForScopePaged, getJiraConnectionStatus } from "../jira";
import { mergeIdeasJiraConfig, type JiraPullConfig } from "./jira-mapping";
import type { JiraSource } from "./types";

export interface JiraLiveResult {
  connected: boolean;
  sources: JiraSource[];
  /** Project keys whose pull hit the configured ceiling (never silent). */
  truncatedProjects: string[];
  /** The pull config that produced these sources. */
  pull: JiraPullConfig;
}

/**
 * Live state of the Jira ideas backlog. Called on every import — per the PRD
 * each batch starts from Jira's current state, never from what PM-OS saw
 * last time, so nothing here is cached.
 *
 * Per-workspace pull rules (Admin → Ideas → Jira pull, IdeasJiraConfig.pull):
 * - product line comes from the configured field id (Kela: Module) — when
 *   none is configured, from Components (RoomLens);
 * - every page is walked up to `maxIssues` per project (Jira pages at 100);
 * - `excludeStatuses` are left out in JQL; by default every status is pulled,
 *   Done included, so "already shipped" matches can surface.
 */
export async function fetchJiraLiveSources(workspaceId: string): Promise<JiraLiveResult> {
  const [status, wsRow] = await Promise.all([
    getJiraConnectionStatus(workspaceId),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { ideasConfig: true } }),
  ]);
  const pull = mergeIdeasJiraConfig(wsRow?.ideasConfig).pull;
  if (!status?.connected || status.projectKeys.length === 0) {
    return { connected: false, sources: [], truncatedProjects: [], pull };
  }

  const perProject = await Promise.all(
    status.projectKeys.map(async (projectKey) => ({
      projectKey,
      ...(await fetchIssuesForScopePaged(workspaceId, {
        projectKey,
        maxResults: pull.maxIssues,
        excludeStatuses: pull.excludeStatuses,
        productLineFieldId: pull.productLineFieldId || undefined,
      })),
    }))
  );
  const truncatedProjects = perProject.filter((p) => p.truncated).map((p) => p.projectKey);
  for (const key of truncatedProjects) {
    console.warn(
      `[ideas:jira] ${key}: pull stopped at the ${pull.maxIssues}-issue ceiling — raise it in Admin → Ideas or exclude statuses.`
    );
  }

  const useField = Boolean(pull.productLineFieldId);
  const sources: JiraSource[] = perProject
    .flatMap((p) => p.issues)
    .filter((issue) => !/^sub-?task$/i.test(issue.issueType))
    .map((issue) => ({
      key: issue.key,
      id: issue.key,
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      url: `${status.siteUrl}/browse/${issue.key}`,
      // A configured field is the only product-line source: Components are
      // ignored even when present, so one customer's taxonomy never mixes.
      products: useField ? (issue.productLine ? [issue.productLine] : []) : issue.components,
    }));
  return { connected: true, sources, truncatedProjects, pull };
}

/**
 * Catalog rows for product-line values the pull brought that PM-OS doesn't
 * know yet (origin "jira"). Runs before the stage contexts load so this
 * import's catalog/match prompts already list them. Case-insensitive on the
 * name; "Other" is the fallback bucket, never a catalog row.
 */
export async function ensureJiraProductLines(
  workspaceId: string,
  sources: JiraSource[]
): Promise<string[]> {
  const wanted = new Map<string, string>();
  for (const name of sources.flatMap((s) => s.products)) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === "other") continue;
    const k = trimmed.toLowerCase();
    if (!wanted.has(k)) wanted.set(k, trimmed);
  }
  if (wanted.size === 0) return [];

  const existing = await db.productLine.findMany({
    where: { workspaceId },
    select: { name: true, position: true },
    orderBy: { position: "desc" },
  });
  const known = new Set(existing.map((p) => p.name.toLowerCase()));
  const missing = Array.from(wanted.entries())
    .filter(([k]) => !known.has(k))
    .map(([, name]) => name)
    .sort((a, b) => a.localeCompare(b));
  if (missing.length === 0) return [];

  let position = (existing[0]?.position ?? -1) + 1;
  await db.productLine.createMany({
    data: missing.map((name) => ({
      workspaceId,
      name,
      description: "",
      origin: "jira",
      position: position++,
    })),
    skipDuplicates: true,
  });
  return missing;
}
