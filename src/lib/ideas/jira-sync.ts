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
  /** Module values no catalog row or alias matched — their issues landed in
   *  "Other". Listed in the import run so a PM can add a line or an alias. */
  unresolvedProductLines: string[];
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
 *   resolved on every pull, never stored as an id. The value maps to the
 *   catalog by name or alias (product-line-key.ts); no match = "Other".
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
    return { connected: false, sources: [], truncatedProjects: [], unresolvedProductLines: [], pull };
  }
  // Module values land under the catalog's spelling ("Platform General" →
  // "Platform" via its alias); a value no row or alias matches is "Other"
  // (Daniel 2026-10-13: the catalog is curated by hand, never grown by a pull).
  const resolver = buildProductLineResolver(
    await db.productLine.findMany({ where: { workspaceId }, select: { name: true, aliases: true } })
  );

  // The field mapped as Product Line, by display name → id. Missing on this
  // site = Components only (no warning: RoomLens never had the field).
  // Field names → ids, resolved on every pull (names are editable in Jira).
  // Product line: the field mapped as Product Line ("Components" = built-in).
  // Reporter / assignee: a custom text field when mapped to one, else the
  // system user fields.
  let productLineFieldId: string | undefined;
  let reporterFieldId: string | undefined;
  let assigneeFieldId: string | undefined;
  const mappedName = config.fields.productLine.jiraField.trim().toLowerCase();
  const reporterName = config.fields.reporter.jiraField.trim().toLowerCase();
  const assigneeName = config.fields.assignee.jiraField.trim().toLowerCase();
  const needLookup =
    (mappedName && mappedName !== "components") ||
    (reporterName && reporterName !== "reporter") ||
    (assigneeName && assigneeName !== "assignee");
  if (needLookup) {
    try {
      const all = await listAllFields(workspaceId);
      if (mappedName && mappedName !== "components") productLineFieldId = all.get(mappedName)?.id;
      const custom = (id?: string) => (id && id.startsWith("customfield_") ? id : undefined);
      if (reporterName && reporterName !== "reporter") reporterFieldId = custom(all.get(reporterName)?.id);
      if (assigneeName && assigneeName !== "assignee") assigneeFieldId = custom(all.get(assigneeName)?.id);
    } catch (err) {
      // Silently falling back to Components would move every issue to "Other"
      // and the resync would rewrite every idea's product line — fail loudly.
      throw new Error(
        `Could not read Jira's field list (${err instanceof Error ? err.message : "unknown error"}) — the import stopped before touching any idea. Retry; if it persists, reconnect Jira in Settings → Integrations.`
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
        reporterFieldId,
        assigneeFieldId,
      })),
    }))
  );
  const truncatedProjects = perProject.filter((p) => p.truncated).map((p) => p.projectKey);
  for (const key of truncatedProjects) {
    console.warn(
      `[ideas:jira] ${key}: pull stopped at the ${pull.maxIssues}-issue ceiling — raise it in Admin → Ideas.`
    );
  }

  const unresolved = new Map<string, string>();
  const sources: JiraSource[] = perProject
    .flatMap((p) => p.issues)
    // Sub-tasks belong to their parent; bugs are not product ideas (a Zendesk
    // bug is parked the same way) — neither enters the backlog PM-OS reads.
    .filter((issue) => !/^(sub-?task|bug)$/i.test(issue.issueType))
    .map((issue) => ({
      key: issue.key,
      id: issue.key,
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      issueType: issue.issueType,
      priority: issue.priority,
      reporter: issue.reporter,
      assignee: issue.assignee,
      createdAt: issue.created,
      url: `${status.siteUrl}/browse/${issue.key}`,
      // Mapped field first (Kela: Module); Components when it is empty.
      products: (issue.productLine ? [issue.productLine] : issue.components).map((v) => {
        const hit = resolver.resolve(v);
        if (!hit) unresolved.set(v.trim().toLowerCase(), v.trim());
        return hit ?? "Other";
      }),
    }));
  return {
    connected: true,
    sources,
    truncatedProjects,
    unresolvedProductLines: Array.from(unresolved.values()).sort((a, b) => a.localeCompare(b)),
    pull,
  };
}
