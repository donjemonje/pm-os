import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsSummary } from "@/lib/auth";
import {
  envFeatureDefault,
  envSystemFlagDefault,
  ORG_FEATURE_KEYS,
  SYSTEM_FLAG_KEYS,
} from "@/lib/feature-flags";
import { listSystemFlagOverrides } from "@/lib/system-flags";
import { AdminShell } from "../AdminShell";
import { EnablementsMatrix } from "./EnablementsMatrix";

export default async function AdminEnablementsPage() {
  const admin = await requireAdminPage("/admin/enablements");

  const organizations = await listOrganizationsSummary();
  const systemFlags = await listSystemFlagOverrides();

  return (
    <AdminShell
      user={admin}
      title="Enablements"
      description="Feature switches by area. System-wide switches apply before sign-in; per-organization switches override the environment default."
    >
      <EnablementsMatrix
        initialOrganizations={organizations}
        orgEnvDefaults={Object.fromEntries(
          ORG_FEATURE_KEYS.map((key) => [key, envFeatureDefault(key)])
        )}
        initialSystemFlags={systemFlags}
        systemEnvDefaults={Object.fromEntries(
          SYSTEM_FLAG_KEYS.map((key) => [key, envSystemFlagDefault(key)])
        )}
      />
    </AdminShell>
  );
}
