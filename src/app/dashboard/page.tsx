import Link from "next/link";
import { ArrowRight, FileText, MessageSquare, Package, Plug } from "lucide-react";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { db } from "@/lib/db";
import { getJiraConnectionStatus } from "@/lib/jira";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { AppShell } from "@/components/layout/AppShell";

export default async function DashboardPage() {
  await requireUserPage("/dashboard");
  const [docsEnabled, chatEnabled] = await Promise.all([
    featureEnabledForCurrentUser("docs"),
    featureEnabledForCurrentUser("chat"),
  ]);
  const workspace = await getOrCreateWorkspace();
  const jira = await getJiraConnectionStatus(workspace.id);

  const [releases, documents, qaCount] = await Promise.all([
    db.release.count({ where: { workspaceId: workspace.id } }),
    db.document.count({ where: { workspaceId: workspace.id } }),
    db.qALog.count({ where: { workspaceId: workspace.id } }),
  ]);

  const recentDocs = await db.document.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });

  return (
    <AppShell>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="mt-1 text-foreground/75">
            Release notes, user manuals, and PRD answers — connected to Jira.
          </p>
        </div>

        {!jira?.connected && (
          <div className="mb-8 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-3">
              <Plug className="text-amber-600" size={20} />
              <div>
                <div className="text-sm font-medium text-amber-900">Connect Jira to get started</div>
                <div className="text-xs text-amber-700">
                  Required for release notes, user manuals, and PRD Q&A.
                </div>
              </div>
            </div>
            <Link
              href="/settings/jira"
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700"
            >
              Connect
            </Link>
          </div>
        )}

        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          {[
            { label: "Releases", value: releases, icon: Package, href: "/releases" },
            ...(docsEnabled
              ? [{ label: "Documents", value: documents, icon: FileText, href: "/docs" }]
              : []),
            ...(chatEnabled
              ? [{ label: "PRD Q&A", value: qaCount, icon: MessageSquare, href: "/chat" }]
              : []),
          ].map(({ label, value, icon: Icon, href }) => (
            <Link
              key={label}
              href={href}
              className="rounded-xl border border-border bg-card p-5 transition hover:border-primary/30 hover:shadow-sm"
            >
              <div className="mb-3 flex items-center justify-between">
                <Icon size={18} className="text-primary" />
                <ArrowRight size={14} className="text-muted" />
              </div>
              <div className="text-2xl font-bold text-foreground">{value}</div>
              <div className="text-sm font-medium text-foreground/70">{label}</div>
            </Link>
          ))}
        </div>

        {docsEnabled && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Recent documents</h2>
          {recentDocs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
              No documents yet.{" "}
              <Link href="/docs/new" className="text-primary hover:underline">
                Create a user manual
              </Link>{" "}
              or{" "}
              <Link href="/releases" className="text-primary hover:underline">
                a release
              </Link>{" "}
              for release notes.
            </div>
          ) : (
            <div className="space-y-2">
              {recentDocs.map((doc) => (
                <Link
                  key={doc.id}
                  href={`/docs/${doc.id}`}
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-sm hover:bg-background"
                >
                  <div className="text-foreground">
                    <span className="mr-2 rounded bg-background px-1.5 py-0.5 font-mono text-xs text-primary">
                      {doc.type}
                    </span>
                    {doc.title}
                  </div>
                  <span className="text-xs font-medium capitalize text-foreground/65">{doc.status}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </AppShell>
  );
}
