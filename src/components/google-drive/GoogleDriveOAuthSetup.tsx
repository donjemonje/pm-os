import { AlertCircle, ExternalLink } from "lucide-react";
import type { GoogleDriveOAuthSetupStatus } from "@/lib/google-drive-oauth-config";
import { showIntegrationAdminSetup } from "@/lib/integrations";

const GOOGLE_CONSOLE = "https://console.cloud.google.com/apis/credentials";

/** Operator-only: PM-OS app on Google Cloud (not shown to end users in production). */
export function GoogleDriveOAuthSetup({ setup }: { setup: GoogleDriveOAuthSetupStatus }) {
  if (!showIntegrationAdminSetup()) {
    return null;
  }

  if (setup.ready) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted">
        <div className="font-medium text-foreground">Admin: Google OAuth ready</div>
        <p className="mt-1">
          Same app as Sign in with Google — users click Integrate with Google Drive only.
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
        Admin: register PM-OS on Google Cloud (one-time)
      </div>
      <p className="mb-3 text-sm text-amber-800">
        End users never paste secrets. Enable APIs on the PM-OS OAuth client; store credentials in
        server .env only.
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
            href={GOOGLE_CONSOLE}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Google Cloud Console
            <ExternalLink size={12} />
          </a>
        </li>
        <li>2. Enable Drive, Docs, and Slides APIs</li>
        <li>
          3. Redirect URI (same as Google Sign-In):
          <code className="mt-1 block break-all rounded bg-amber-100 px-2 py-1 text-xs">
            {setup.redirectUri ?? "http://localhost:3000/api/auth/oauth/google/callback"}
          </code>
        </li>
        <li>
          4. <code className="rounded bg-amber-100 px-1">GOOGLE_CLIENT_ID</code> +{" "}
          <code className="rounded bg-amber-100 px-1">GOOGLE_CLIENT_SECRET</code> in .env
        </li>
      </ol>
    </div>
  );
}
