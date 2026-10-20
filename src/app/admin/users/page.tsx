import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsWithMembers } from "@/lib/auth";
import { getAdminOrg } from "@/lib/admin-org";
import { AdminShell } from "../AdminShell";
import { UserManagement } from "./UserManagement";

export default async function AdminUsersPage() {
  const admin = await requireAdminPage("/admin/users");

  const org = await getAdminOrg(admin.organizationId);
  const organizations = (await listOrganizationsWithMembers()).filter((o) => o.id === org.current?.id);

  return (
    <AdminShell
      user={admin}
      title="User Management"
      description="Add and manage the selected organization's users."
      org={org}
    >
      <UserManagement initialOrganizations={organizations} />
    </AdminShell>
  );
}
