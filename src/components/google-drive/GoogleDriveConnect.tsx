"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";

export function GoogleDriveManagePanel({
  email,
  onDisconnected,
}: {
  email?: string | null;
  onDisconnected?: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);

  async function disconnect() {
    setDisconnecting(true);
    try {
      await fetch("/api/google-drive/settings", { method: "DELETE" });
      onDisconnected?.();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      {email && <p className="text-sm text-muted">Signed in as {email}</p>}

      <div className="text-sm text-muted">
        <p className="mb-2 font-medium text-foreground">What gets imported</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Google Docs — product specs, PRDs, requirements</li>
          <li>Combined with Jira tickets when generating user manuals</li>
        </ul>
      </div>

      <div className="flex items-center gap-3">
        <a
          href="https://drive.google.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Open Google Drive
          <ExternalLink size={12} />
        </a>
        <button
          type="button"
          onClick={disconnect}
          disabled={disconnecting}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50"
        >
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </div>
  );
}
