import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
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
  const [jiraStatus, driveStatus, ideasEnabled] = await Promise.all([
    getJiraConnectionStatus(workspace.id),
    getGoogleDriveConnectionStatus(workspace.id),
    ideasEnabledForCurrentUser(),
  ]);
  const jiraOauthSetup = getJiraOAuthSetupStatus();
  const driveOauthSetup = getGoogleDriveOAuthSetupStatus();
  const params = await searchParams;

  return (
    <div>
      <p className="mb-6 text-sm text-muted">
        Connect Jira and Google Drive to import tickets and PRDs.
      </p>

      <IntegrationsPanel
        jiraStatus={jiraStatus}
        driveStatus={driveStatus}
        ideasEnabled={ideasEnabled}
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
