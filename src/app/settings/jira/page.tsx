import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import {
  featureEnabledForCurrentUser,
  ideasEnabledForCurrentUser,
} from "@/lib/org-features";
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
