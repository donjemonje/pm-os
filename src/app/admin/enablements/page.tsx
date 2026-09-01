import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsWithMembers } from "@/lib/auth";
import {
  envFeatureDefault,
  envSystemFlagDefault,
  ORG_FEATURE_KEYS,
  SYSTEM_FLAG_KEYS,
} from "@/lib/feature-flags";
import { listSystemFlagOverrides } from "@/lib/system-flags";
import { AdminShell } from "../AdminShell";
import { OrgEnablements } from "./OrgEnablements";
import { SystemFlags } from "./SystemFlags";

export default async function AdminEnablementsPage() {
  const admin = await requireAdminPage("/admin/enablements");

  const organizations = await listOrganizationsWithMembers();
  const systemFlags = await listSystemFlagOverrides();

  return (
    <AdminShell
      user={admin}
      title="Enablements"
      description="System-wide switches and per-organization feature flags. Unset flags follow the environment default."
    >
      <div className="space-y-6">
        <SystemFlags
          initialFlags={systemFlags}
          envDefaults={Object.fromEntries(
            SYSTEM_FLAG_KEYS.map((key) => [key, envSystemFlagDefault(key)])
          )}
        />
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
      </div>
    </AdminShell>
  );
}
