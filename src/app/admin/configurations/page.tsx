import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsWithMembers } from "@/lib/auth";
import { isIdeasEnabled } from "@/lib/feature-flags";
import { AdminShell } from "../AdminShell";
import { OrgConfigurations } from "./OrgConfigurations";

export default async function AdminConfigurationsPage() {
  const admin = await requireAdminPage("/admin/configurations");

  const organizations = await listOrganizationsWithMembers();

  return (
    <AdminShell
      user={admin}
      title="Configurations"
      description="Per-organization feature flags. Unset flags follow the environment default."
    >
      <OrgConfigurations
        initialOrganizations={organizations.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          memberCount: org.memberCount,
          features: org.features,
        }))}
        envDefaults={{ ideas: isIdeasEnabled() }}
      />
    </AdminShell>
  );
}
