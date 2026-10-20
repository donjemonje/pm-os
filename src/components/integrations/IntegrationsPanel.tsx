"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { formatIntegrationError } from "@/lib/integration-errors";
import { jiraHealthMessage, type JiraHealthStatus } from "@/lib/jira-health-copy";
import { GoogleDriveManagePanel } from "@/components/google-drive/GoogleDriveConnect";

type JiraStatus = {
  connected: boolean;
  siteUrl?: string;
  connectedByName?: string | null;
  connectedByEmail?: string | null;
  authType?: string;
  apiTokenExpiresAt?: string | null;
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
  driveOauthReady: boolean;
  banners?: {
    driveSuccess?: boolean;
    driveError?: string;
  };
  /** Ideas feature flag for the caller's org — shows the write-back target picker. */
  ideasEnabled?: boolean;
  /** The org's Jira project and work type, set by the PM-OS admin (Admin → Ideas). */
  jiraProject?: string;
  jiraIssueType?: string;
  /** Live connection health from the server (see lib/jira.ts getJiraHealth). */
  jiraHealth?: JiraHealthStatus;
  /** False = Drive is off for this org (follows the Docs flag): no card, no banners. */
  driveEnabled?: boolean;
};

function StatusDot({ connected, unavailable = false }: { connected: boolean; unavailable?: boolean }) {
  if (connected && unavailable) return <AlertTriangle size={16} className="shrink-0 text-amber-600" />;
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
  unavailable = false,
  notice,
  headerAction,
  detailHref,
}: {
  name: string;
  connected: boolean;
  detail?: string | null;
  /** The OAuth start URL. Absent = members cannot connect this one themselves (Jira). */
  connectHref?: string;
  connectLabel?: string;
  oauthReady?: boolean;
  unavailableLabel?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  /** One card, no Hide/Manage toggle, children on the right of the header row. */
  flat?: boolean;
  /** Connected but not working: status reads "Unavailable" (amber). */
  unavailable?: boolean;
  /** Full-width amber line under the header (the support message). */
  notice?: string | null;
  /** Extra control on the header row. */
  headerAction?: React.ReactNode;
  /** When set, `detail` renders as a link opening in a new tab. */
  detailHref?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{name}</div>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <StatusDot connected={connected} unavailable={unavailable} />
            <span
              className={
                connected ? (unavailable ? "text-amber-700" : "text-green-800") : "text-muted"
              }
            >
              {connected ? (unavailable ? "Unavailable" : "Connected") : "Not connected"}
            </span>
            {connected && detail && (
              <span className="truncate text-muted">
                ·{" "}
                {detailHref ? (
                  <a
                    href={detailHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {detail}
                  </a>
                ) : (
                  detail
                )}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          {/* Flat card: the connection summary sits on the right, vertically
              centred against the name + status on the left. */}
          {flat && connected && children && <div className="text-right">{children}</div>}
          {connected ? (
            <>
              {headerAction}
              {!flat && (
                <button
                  type="button"
                  onClick={onToggle}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
                >
                  {expanded ? "Hide" : "Manage"}
                </button>
              )}
            </>
          ) : !connectHref ? null : oauthReady ? (
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

      {notice && (
        <div className="border-t border-[#f3dcb0] bg-[#fdf6e7] px-5 py-2.5 text-[13px] text-[#8a5a00]">
          {notice}
        </div>
      )}

      {!flat && expanded && children && (
        <div className="border-t border-border px-5 py-4">{children}</div>
      )}
    </div>
  );
}

export function IntegrationsPanel({
  jiraStatus,
  driveStatus,
  driveOauthReady,
  banners,
  ideasEnabled = false,
  jiraProject = "",
  jiraHealth = "not_connected",
  driveEnabled = true,
}: IntegrationsPanelProps) {
  const [jiraExpanded, setJiraExpanded] = useState(true);
  // Members never connect, reconnect or disconnect Jira: PM-OS support holds
  // the PM-OS user's token. The card only reports; every non-ok state ends
  // in "contact support" (lib/jira-health-copy.ts).
  const jiraNotice = jiraStatus?.connected
    ? jiraHealthMessage(jiraHealth === "not_connected" ? "ok" : jiraHealth)
    : jiraHealthMessage("not_connected");
  const [driveExpanded, setDriveExpanded] = useState(Boolean(driveStatus?.connected));
  const [driveConnected, setDriveConnected] = useState(Boolean(driveStatus?.connected));
  const [driveEmail, setDriveEmail] = useState(driveStatus?.email);

  return (
    <div className="space-y-4">
      {driveEnabled && banners?.driveSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Google Drive connected successfully.
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
        expanded={jiraExpanded}
        onToggle={() => setJiraExpanded((v) => !v)}
        flat
        unavailable={jiraHealth === "unavailable"}
        notice={jiraNotice}
        detailHref={jiraStatus?.siteUrl}
      >
        {jiraStatus?.connected && ideasEnabled && (
          <div className="text-sm leading-6 text-muted">
            <p>
              Connected as{" "}
              <span className="font-medium text-foreground">
                {jiraStatus.connectedByName ?? jiraStatus.connectedByEmail ?? "PM-OS"}
              </span>{" "}
              user
            </p>
            <p>
              Configured Jira-Space:{" "}
              {jiraProject ? <span className="font-mono text-primary">{jiraProject}</span> : "not set yet"}
            </p>
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
