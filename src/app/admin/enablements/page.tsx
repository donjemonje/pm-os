import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsSummary } from "@/lib/auth";
import { getAdminOrg } from "@/lib/admin-org";
import { envFeatureDefault, ORG_FEATURE_KEYS } from "@/lib/feature-flags";
import { AdminShell } from "../AdminShell";
import { EnablementsMatrix } from "./EnablementsMatrix";

export default async function AdminEnablementsPage() {
  const admin = await requireAdminPage("/admin/enablements");

  const org = await getAdminOrg(admin.organizationId);
  const organizations = (await listOrganizationsSummary()).filter((o) => o.id === org.current?.id);

  return (
    <AdminShell
      user={admin}
      title="Enablements"
      description="Feature switches of the selected organization, by area. A cell without an override follows the environment default."
      org={org}
    >
      <EnablementsMatrix
        initialOrganizations={organizations}
        orgEnvDefaults={Object.fromEntries(
          ORG_FEATURE_KEYS.map((key) => [key, envFeatureDefault(key)])
        )}
      />
    </AdminShell>
  );
}
