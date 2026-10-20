import { db } from "./db";
import { getJiraHealth } from "./jira";
import { mergeIdeasJiraConfig } from "./ideas/jira-mapping";
import { jiraHealthMessage } from "./jira-health-copy";

/**
 * The app-launch Jira check (root layout): the customer-facing message for
 * a connection that is missing, unavailable, or has no project set — or
 * null when everything is fine. Uses the cached probe; imports and syncs
 * ask fresh themselves.
 */
export async function jiraLaunchNotice(workspaceId: string): Promise<string | null> {
  const [health, ws] = await Promise.all([
    getJiraHealth(workspaceId),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { ideasConfig: true } }),
  ]);
  if (health.status !== "ok") return jiraHealthMessage(health.status);
  if (!mergeIdeasJiraConfig(ws?.ideasConfig).jiraProject) return jiraHealthMessage("not_configured");
  return null;
}
