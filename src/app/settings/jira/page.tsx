import { PageView } from "@/lib/analytics/PageView";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import {
  featureEnabledForCurrentUser,
  ideasEnabledForCurrentUser,
} from "@/lib/org-features";
import { getJiraConnectionStatus, getJiraHealth } from "@/lib/jira";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { getGoogleDriveConnectionStatus } from "@/lib/google-drive";
import { getGoogleDriveOAuthSetupStatus } from "@/lib/google-drive-oauth-config";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
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
  const driveOauthSetup = getGoogleDriveOAuthSetupStatus();
  const params = await searchParams;
  const jiraCfg = mergeIdeasJiraConfig(workspace.ideasConfig);
  // Live probe (cached a few minutes) — the card says "Unavailable" with the
  // support message when the PM-OS user's token stopped working.
  const jiraHealth = jiraStatus?.connected
    ? (await getJiraHealth(workspace.id)).status
    : "not_connected";
  return (
    <>
    <PageView name="settings_integrations" />
    <div>
      <IntegrationsPanel
        jiraStatus={jiraStatus}
        driveStatus={driveStatus}
        driveEnabled={driveEnabled}
        ideasEnabled={ideasEnabled}
        jiraProject={jiraCfg.jiraProject}
        jiraIssueType={jiraCfg.jiraIssueType}
        jiraHealth={jiraHealth}
        driveOauthReady={driveOauthSetup.ready}
        banners={{
          driveSuccess: Boolean(params.drive_connected),
          driveError: params.drive_error,
        }}
      />
    </div>
    </>
  );
}
