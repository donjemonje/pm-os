import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsSummary } from "@/lib/auth";
import { envFeatureDefault, ORG_FEATURE_KEYS } from "@/lib/feature-flags";
import { AdminShell } from "../AdminShell";
import { EnablementsMatrix } from "./EnablementsMatrix";

export default async function AdminEnablementsPage() {
  const admin = await requireAdminPage("/admin/enablements");

  const organizations = await listOrganizationsSummary();

  return (
    <AdminShell
      user={admin}
      title="Enablements"
      description="Per-organization feature switches by area. A cell without an override follows the environment default."
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
