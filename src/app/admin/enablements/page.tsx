import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsWithMembers } from "@/lib/auth";
import { envFeatureDefault, ORG_FEATURE_KEYS } from "@/lib/feature-flags";
import { AdminShell } from "../AdminShell";
import { OrgEnablements } from "./OrgEnablements";

export default async function AdminEnablementsPage() {
  const admin = await requireAdminPage("/admin/enablements");

  const organizations = await listOrganizationsWithMembers();

  return (
    <AdminShell
      user={admin}
      title="Enablements"
      description="Per-organization feature flags. Unset flags follow the environment default."
    >
      <OrgEnablements
        initialOrganizations={organizations.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          memberCount: org.memberCount,
          features: org.features,
        }))}
        envDefaults={Object.fromEntries(
          ORG_FEATURE_KEYS.map((key) => [key, envFeatureDefault(key)])
        )}
      />
    </AdminShell>
  );
}
