import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import {
  featureEnabledForCurrentUser,
  ideasEnabledForCurrentUser,
} from "@/lib/org-features";
import { db } from "@/lib/db";
import { getJiraConnectionStatus } from "@/lib/jira";
import { getGoogleDriveConnectionStatus } from "@/lib/google-drive";
import { getJiraOAuthSetupStatus } from "@/lib/jira-oauth-config";
import { getGoogleDriveOAuthSetupStatus } from "@/lib/google-drive-oauth-config";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    drive_connected?: string;
    drive_error?: string;
  }>;
}) {
  await requireUserPage("/settings/jira");
  const workspace = await getOrCreateWorkspace();
  // Google Drive only feeds Docs, so it follows the Docs flag: with Docs off
  // (every client org today) Drive does not exist — no card, no status call.
  const [jiraStatus, ideasEnabled, driveEnabled] = await Promise.all([
    getJiraConnectionStatus(workspace.id),
    ideasEnabledForCurrentUser(),
    featureEnabledForCurrentUser("docs"),
  ]);
  const driveStatus = driveEnabled
    ? await getGoogleDriveConnectionStatus(workspace.id)
    : { connected: false };
  const jiraOauthSetup = getJiraOAuthSetupStatus();
  const driveOauthSetup = getGoogleDriveOAuthSetupStatus();
  const params = await searchParams;
  // Issue types seen in the pulled backlog, per project — one type means the
  // write-back type is obvious and the picker stays hidden.
  const pulledIssueTypes: Record<string, string[]> = {};
  if (jiraStatus?.connected) {
    const rows = await db.jiraIdeaSnapshot.findMany({
      where: { workspaceId: workspace.id },
      select: { key: true, issueType: true },
    });
    for (const r of rows) {
      if (!r.issueType) continue;
      const project = r.key.split("-")[0];
      const list = (pulledIssueTypes[project] ??= []);
      if (!list.includes(r.issueType)) list.push(r.issueType);
    }
  }

  return (
    <div>
      <p className="mb-6 text-sm text-muted">
        {driveEnabled
          ? "Connect Jira and Google Drive to import tickets and PRDs."
          : "Connect Jira to import tickets."}
      </p>

      <IntegrationsPanel
        jiraStatus={jiraStatus}
        driveStatus={driveStatus}
        driveEnabled={driveEnabled}
        ideasEnabled={ideasEnabled}
        pulledIssueTypes={pulledIssueTypes}
        jiraOauthReady={jiraOauthSetup.ready}
        driveOauthReady={driveOauthSetup.ready}
        banners={{
          jiraSuccess: Boolean(params.connected),
          jiraError: params.error,
          driveSuccess: Boolean(params.drive_connected),
          driveError: params.drive_error,
        }}
      />
    </div>
  );
}
