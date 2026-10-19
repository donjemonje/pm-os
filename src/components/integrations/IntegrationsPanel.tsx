"use client";

import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/ConfirmDialog";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Circle, Loader2, ExternalLink } from "lucide-react";
import { formatIntegrationError } from "@/lib/integration-errors";
import { GoogleDriveManagePanel } from "@/components/google-drive/GoogleDriveConnect";

type JiraStatus = {
  connected: boolean;
  siteUrl?: string;
  projectKeys?: string[];
  ideasProjectKey?: string | null;
  ideasIssueType?: string;
} | null;

type DriveStatus = {
  connected: boolean;
  email?: string | null;
} | null;

type IntegrationsPanelProps = {
  jiraStatus: JiraStatus;
  driveStatus: DriveStatus;
  jiraOauthReady: boolean;
  driveOauthReady: boolean;
  banners?: {
    jiraSuccess?: boolean;
    jiraError?: string;
    driveSuccess?: boolean;
    driveError?: string;
  };
  /** Ideas feature flag for the caller's org — shows the write-back target picker. */
  ideasEnabled?: boolean;
  /** The org's Jira project and work type, set by the PM-OS admin (Admin → Ideas). */
  jiraProject?: string;
  jiraIssueType?: string;
  /** Connected but the token is dead (refresh failed). */
  jiraNeedsReconnect?: boolean;
  /** False = Drive is off for this org (follows the Docs flag): no card, no banners. */
  driveEnabled?: boolean;
};

function StatusDot({ connected }: { connected: boolean }) {
  return connected ? (
    <CheckCircle2 size={16} className="shrink-0 text-green-600" />
  ) : (
    <Circle size={16} className="shrink-0 text-muted" />
  );
}

function IntegrationRow({
  name,
  connected,
  detail,
  connectHref,
  connectLabel,
  oauthReady,
  unavailableLabel,
  expanded,
  onToggle,
  children,
  flat = false,
  needsReconnect = false,
  headerAction,
  onDisconnect,
}: {
  name: string;
  connected: boolean;
  detail?: string | null;
  connectHref: string;
  connectLabel: string;
  oauthReady: boolean;
  unavailableLabel: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  /** One card, no Hide/Manage toggle, children in the same section (no separator). */
  flat?: boolean;
  /** Connected but the token is dead: status reads "Needs reconnecting" and Reconnect shows. */
  needsReconnect?: boolean;
  /** Extra control on the header row (e.g. an Open-in-Jira link). */
  headerAction?: React.ReactNode;
  /** Shown as a Disconnect button when set (asks first). */
  onDisconnect?: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{name}</div>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <StatusDot connected={connected && !needsReconnect} />
            <span className={connected && !needsReconnect ? "text-green-800" : "text-muted"}>
              {connected ? (needsReconnect ? "Needs reconnecting" : "Connected") : "Not connected"}
            </span>
            {connected && detail && (
              <span className="truncate text-muted">· {detail}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {connected ? (
            <>
              {headerAction}
              {oauthReady && (needsReconnect || !flat) && (
                <a
                  href={connectHref}
                  title="Run the authorization again — needed when the token expired or PM-OS asks for a new permission."
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
                >
                  Reconnect
                </a>
              )}
              {!flat && (
                <button
                  type="button"
                  onClick={onToggle}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
                >
                  {expanded ? "Hide" : "Manage"}
                </button>
              )}
              {onDisconnect && (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:border-[#c23767] hover:text-[#c23767]"
                >
                  Disconnect
                </button>
              )}
            </>
          ) : oauthReady ? (
            <a
              href={connectHref}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              {connectLabel}
              <ArrowRight size={14} />
            </a>
          ) : (
            <span className="text-sm text-muted">{unavailableLabel}</span>
          )}
        </div>
      </div>

      {flat && children && <div className="px-5 pb-4">{children}</div>}
      {!flat && expanded && children && (
        <div className="border-t border-border px-5 py-4">{children}</div>
      )}
    </div>
  );
}

export function IntegrationsPanel({
  jiraStatus,
  driveStatus,
  jiraOauthReady,
  driveOauthReady,
  banners,
  ideasEnabled = false,
  jiraProject = "",
  jiraIssueType = "",
  jiraNeedsReconnect = false,
  driveEnabled = true,
}: IntegrationsPanelProps) {
  const [jiraExpanded, setJiraExpanded] = useState(true);
  const router = useRouter();
  const { confirm } = useConfirm();
  const [jiraDisconnectError, setJiraDisconnectError] = useState("");
  async function disconnectJira() {
    if (
      !(await confirm({
        title: "Disconnect Jira?",
        message:
          "Imports stop matching against the Jira backlog and Sync to Jira is off until someone connects again. Ideas already created stay as they are.",
        confirmLabel: "Disconnect",
        tone: "danger",
      }))
    )
      return;
    setJiraDisconnectError("");
    const res = await fetch("/api/jira/settings", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: undefined }));
      setJiraDisconnectError(data.error ?? "Disconnect failed");
      return;
    }
    router.refresh();
  }
  const [driveExpanded, setDriveExpanded] = useState(Boolean(driveStatus?.connected));
  const [driveConnected, setDriveConnected] = useState(Boolean(driveStatus?.connected));
  const [driveEmail, setDriveEmail] = useState(driveStatus?.email);

  return (
    <div className="space-y-4">
      {banners?.jiraSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Jira connected successfully.
        </div>
      )}
      {driveEnabled && banners?.driveSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Google Drive connected successfully.
        </div>
      )}
      {banners?.jiraError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formatIntegrationError(banners.jiraError)}
        </div>
      )}
      {driveEnabled && banners?.driveError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formatIntegrationError(banners.driveError)}
        </div>
      )}

      <IntegrationRow
        name="Jira Integration"
        connected={Boolean(jiraStatus?.connected)}
        detail={jiraStatus?.siteUrl}
        connectHref="/api/auth/jira"
        connectLabel="Connect"
        oauthReady={jiraOauthReady}
        unavailableLabel="Not available"
        expanded={jiraExpanded}
        onToggle={() => setJiraExpanded((v) => !v)}
        flat
        needsReconnect={jiraNeedsReconnect}
        onDisconnect={jiraStatus?.connected ? disconnectJira : undefined}
        headerAction={
          jiraStatus?.connected && jiraStatus.siteUrl ? (
            <a
              href={jiraStatus.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
            >
              Open Jira
              <ExternalLink size={12} />
            </a>
          ) : null
        }
      >
        {jiraDisconnectError && <div className="text-sm text-[#c94266]">{jiraDisconnectError}</div>}
        {jiraStatus?.connected && ideasEnabled && (
          <div className="text-sm">
            {(
              <p className="text-muted">
                {jiraProject ? (
                  <>
                    Ideas are read from and written to{" "}
                    <span className="font-mono text-primary">{jiraProject}</span>
                    {jiraIssueType ? (
                      <>
                        ; new ideas are created as <span className="font-medium text-foreground">{jiraIssueType}</span>
                      </>
                    ) : null}
                    . Set by your PM-OS admin.
                  </>
                ) : (
                  "The Jira project for ideas is not set yet — your PM-OS admin sets it."
                )}
              </p>
            )}
          </div>
        )}
      </IntegrationRow>

      {driveEnabled && (
      <IntegrationRow
        name="Drive Integration"
        connected={driveConnected}
        detail={driveEmail}
        connectHref="/api/auth/google-drive"
        connectLabel="Connect"
        oauthReady={driveOauthReady}
        unavailableLabel="Not available"
        expanded={driveExpanded}
        onToggle={() => setDriveExpanded((v) => !v)}
      >
        {driveConnected && (
          <GoogleDriveManagePanel
            email={driveEmail}
            onDisconnected={() => {
              setDriveConnected(false);
              setDriveEmail(null);
              setDriveExpanded(false);
            }}
          />
        )}
      </IntegrationRow>
      )}
    </div>
  );
}

export function IntegrationRowSkeleton() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <Loader2 size={14} className="animate-spin" />
      Loading…
    </div>
  );
}
