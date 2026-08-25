import { fetchIssuesForScope, getJiraConnectionStatus } from "../jira";
import type { JiraSource } from "./types";

/**
 * Live state of the Jira ideas backlog. Called on every import — per the PRD
 * each batch starts from Jira's current state, never from what PM-OS saw
 * last time, so nothing here is cached.
 */
export async function fetchJiraLiveSources(
  workspaceId: string
): Promise<{ connected: boolean; sources: JiraSource[] }> {
  const status = await getJiraConnectionStatus(workspaceId);
  if (!status?.connected || status.projectKeys.length === 0) {
    return { connected: false, sources: [] };
  }

  const perProject = await Promise.all(
    status.projectKeys.map((projectKey) => fetchIssuesForScope(workspaceId, { projectKey }))
  );
  const sources: JiraSource[] = perProject
    .flat()
    .filter((issue) => !/^sub-?task$/i.test(issue.issueType))
    .map((issue) => ({
      key: issue.key,
      id: issue.key,
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      url: `${status.siteUrl}/browse/${issue.key}`,
      products: issue.components,
    }));
  return { connected: true, sources };
}
