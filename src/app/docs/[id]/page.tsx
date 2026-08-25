import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { parseJsonArray } from "@/lib/utils";
import { DocumentEditor } from "@/components/documents/DocumentEditor";
import { AppShell } from "@/components/layout/AppShell";
import type { ChatContext } from "@/lib/types";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ release?: string }>;
}) {
  const { id } = await params;
  const { release: releaseId } = await searchParams;

  const user = await getCurrentUser();
  if (!user?.workspaceId) notFound();

  // Scope to the caller's organization workspace so documents from other
  // organizations are never accessible, even with a guessed id.
  const document = await db.document.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: { release: true },
  });

  if (!document) notFound();

  const jiraKeys = parseJsonArray(document.jiraKeys);
  const chatContext: ChatContext = {
    documentId: document.id,
    releaseId: releaseId ?? document.releaseId ?? undefined,
    issueKeys: jiraKeys.length ? jiraKeys : undefined,
    projectKey: document.release?.jiraProjectKey,
  };

  return (
    <AppShell chatContext={chatContext}>
      <div className="flex h-full flex-col">
        <DocumentEditor
          documentId={document.id}
          initialTitle={document.title}
          initialBody={document.body}
          initialStatus={document.status}
          type={document.type as "RN" | "UM"}
          audience={document.audience}
          jiraKeys={jiraKeys}
        />
      </div>
    </AppShell>
  );
}
