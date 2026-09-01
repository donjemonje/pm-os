import { requireAdminPage } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { AdminShell } from "../AdminShell";
import { IdeasOutputConfig } from "./IdeasOutputConfig";

export default async function AdminIdeasPage() {
  const admin = await requireAdminPage("/admin/ideas");

  const organizations = await db.organization.findMany({
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { id: true, ideasConfig: true } } },
  });

  return (
    <AdminShell
      user={admin}
      title="Ideas"
      description="How review results land in each customer's Jira: field mapping, write policies, description format. Changes apply to the next merge."
    >
      <IdeasOutputConfig
        organizations={organizations
          .filter((org) => org.workspace)
          .map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            config: mergeIdeasJiraConfig(org.workspace?.ideasConfig),
          }))}
      />
    </AdminShell>
  );
}
