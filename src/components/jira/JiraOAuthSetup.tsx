import { AlertCircle, ExternalLink } from "lucide-react";
import type { JiraOAuthSetupStatus } from "@/lib/jira-oauth-config";
import { showIntegrationAdminSetup } from "@/lib/integrations";

const ATLASSIAN_CONSOLE = "https://developer.atlassian.com/console/myapps/";

/** Operator-only: PM-OS app registration on Atlassian (not shown to end users in production). */
export function JiraOAuthSetup({ setup }: { setup: JiraOAuthSetupStatus }) {
  if (!showIntegrationAdminSetup()) {
    if (setup.ready) return null;
    return null;
  }

  if (setup.ready) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted">
        <div className="font-medium text-foreground">Admin: Atlassian OAuth ready</div>
        <p className="mt-1">
          PM-OS Client ID <span className="font-mono">{setup.clientIdHint}</span> — users only
          click Integrate with Jira.
        </p>
        <code className="mt-2 block break-all rounded bg-background px-2 py-1 text-xs">
          {setup.redirectUri}
        </code>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
      <div className="mb-3 flex items-center gap-2 font-semibold text-amber-900">
        <AlertCircle size={18} />
        Admin: register PM-OS on Atlassian (one-time)
      </div>
      <p className="mb-3 text-sm text-amber-800">
        End users never paste Client IDs. Register PM-OS once; store credentials in server{" "}
        <code className="rounded bg-amber-100 px-1">.env</code> only.
      </p>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-amber-900">
        {setup.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
      <ol className="space-y-2 text-sm text-amber-900">
        <li>
          1.{" "}
          <a
            href={ATLASSIAN_CONSOLE}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            developer.atlassian.com
            <ExternalLink size={12} />
          </a>{" "}
          → OAuth 2.0 integration
        </li>
        <li>2. Scopes: read:jira-work, write:jira-work, read:jira-user, offline_access</li>
        <li>
          3. Callback URL:
          <code className="mt-1 block break-all rounded bg-amber-100 px-2 py-1 text-xs">
            {setup.redirectUri ?? "http://localhost:3000/api/auth/jira/callback"}
          </code>
        </li>
        <li>
          4. <code className="rounded bg-amber-100 px-1">ATLASSIAN_CLIENT_ID</code> +{" "}
          <code className="rounded bg-amber-100 px-1">ATLASSIAN_CLIENT_SECRET</code> in .env
        </li>
      </ol>
    </div>
  );
}
