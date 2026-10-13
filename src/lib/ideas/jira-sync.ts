import { db } from "../db";
import { fetchIssuesForScopePaged, getJiraConnectionStatus, listAllFields } from "../jira";
import { mergeIdeasJiraConfig, type JiraPullConfig } from "./jira-mapping";
import { buildProductLineResolver } from "./product-line-key";
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
 * Per-workspace rules (Admin → Ideas):
 * - product line: the Jira field mapped as Product Line in the field mapping
 *   (Kela: "Module"), resolved by name to its id on the site; an issue with
 *   that field empty — or a site without the field — falls back to
 *   Components (RoomLens). Jira field names are editable, so the name is
 *   resolved on every pull, never stored as an id.
 * - every page is walked up to `pull.maxIssues` per project (Jira pages at
 *   100); every status is pulled, Done included, so "already shipped"
 *   matches can surface (the Ideas page hides Done by default).
 */
export async function fetchJiraLiveSources(workspaceId: string): Promise<JiraLiveResult> {
  const [status, wsRow] = await Promise.all([
    getJiraConnectionStatus(workspaceId),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { ideasConfig: true } }),
  ]);
  const config = mergeIdeasJiraConfig(wsRow?.ideasConfig);
  const pull = config.pull;
  if (!status?.connected || status.projectKeys.length === 0) {
    return { connected: false, sources: [], truncatedProjects: [], pull };
  }
  // Module values land under the catalog's spelling ("Platform General" →
  // "Platform" via its alias); unknown values stay verbatim and become rows.
  const resolver = buildProductLineResolver(
    await db.productLine.findMany({ where: { workspaceId }, select: { name: true, aliases: true } })
  );

  // The field mapped as Product Line, by display name → id. Missing on this
  // site = Components only (no warning: RoomLens never had the field).
  let productLineFieldId: string | undefined;
  const mappedName = config.fields.productLine.jiraField.trim().toLowerCase();
  if (mappedName && mappedName !== "components") {
    try {
      productLineFieldId = (await listAllFields(workspaceId)).get(mappedName)?.id;
    } catch (err) {
      console.warn(
        `[ideas:jira] could not read the field list (${err instanceof Error ? err.message : "unknown error"}) — product lines fall back to Components this import.`
      );
    }
  }

  const perProject = await Promise.all(
    status.projectKeys.map(async (projectKey) => ({
      projectKey,
      ...(await fetchIssuesForScopePaged(workspaceId, {
        projectKey,
        maxResults: pull.maxIssues,
        productLineFieldId,
      })),
    }))
  );
  const truncatedProjects = perProject.filter((p) => p.truncated).map((p) => p.projectKey);
  for (const key of truncatedProjects) {
    console.warn(
      `[ideas:jira] ${key}: pull stopped at the ${pull.maxIssues}-issue ceiling — raise it in Admin → Ideas.`
    );
  }

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
      // Mapped field first (Kela: Module); Components when it is empty.
      products: (issue.productLine ? [issue.productLine] : issue.components).map(
        (v) => resolver.resolve(v) ?? v
      ),
    }));
  return { connected: true, sources, truncatedProjects, pull };
}

/**
 * Catalog rows for product-line values the pull brought that PM-OS doesn't
 * know yet (origin "jira"), tagged "from Jira" in Settings → Product Lines so
 * a PM can tell them from hand-made rows. Runs before the stage contexts load so this
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
    select: { name: true, aliases: true, position: true },
    orderBy: { position: "desc" },
  });
  // Names AND aliases count as known — "Platform General" never becomes a row
  // when "Platform" lists it as an alias.
  const resolver = buildProductLineResolver(existing);
  const missing = Array.from(wanted.values())
    .filter((name) => resolver.resolve(name) === undefined)
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
