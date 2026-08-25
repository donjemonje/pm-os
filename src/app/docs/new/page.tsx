import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { UserManualWizard } from "@/components/documents/UserManualWizard";

export default function NewUserManualPage() {
  return (
    <AppShell>
      <div className="p-8">
        <Link
          href="/docs"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to documents
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-bold">Create user manual</h1>
          <p className="mt-1 text-sm text-muted">
            Build from Jira tickets or Google Drive PRDs, refine the selection, then generate
            documentation.
          </p>
        </div>

        <UserManualWizard />
      </div>
    </AppShell>
  );
}
