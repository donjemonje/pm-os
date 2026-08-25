"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { formatIntegrationError } from "@/lib/integration-errors";
import { JiraProjectsPanel } from "@/components/jira/JiraConnect";
import { GoogleDriveManagePanel } from "@/components/google-drive/GoogleDriveConnect";

type JiraStatus = {
  connected: boolean;
  siteUrl?: string;
  projectKeys?: string[];
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
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{name}</div>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <StatusDot connected={connected} />
            <span className={connected ? "text-green-800" : "text-muted"}>
              {connected ? "Connected" : "Not connected"}
            </span>
            {connected && detail && (
              <span className="truncate text-muted">· {detail}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {connected ? (
            <button
              type="button"
              onClick={onToggle}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
            >
              {expanded ? "Hide" : "Manage"}
            </button>
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

      {expanded && children && (
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
}: IntegrationsPanelProps) {
  const [jiraExpanded, setJiraExpanded] = useState(Boolean(jiraStatus?.connected));
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
      {banners?.driveSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Google Drive connected successfully.
        </div>
      )}
      {banners?.jiraError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formatIntegrationError(banners.jiraError)}
        </div>
      )}
      {banners?.driveError && (
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
      >
        {jiraStatus?.connected && (
          <JiraProjectsPanel
            initialProjectKeys={jiraStatus.projectKeys ?? []}
            siteUrl={jiraStatus.siteUrl}
          />
        )}
      </IntegrationRow>

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
