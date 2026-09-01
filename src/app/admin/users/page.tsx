import { requireAdminPage } from "@/lib/admin-auth";
import { listOrganizationsWithMembers } from "@/lib/auth";
import { AdminShell } from "../AdminShell";
import { UserManagement } from "./UserManagement";

export default async function AdminUsersPage() {
  const admin = await requireAdminPage("/admin/users");

  const organizations = await listOrganizationsWithMembers();

  return (
    <AdminShell
      user={admin}
      title="User Management"
      description="Add and manage users across organizations."
    >
      <UserManagement initialOrganizations={organizations} />
    </AdminShell>
  );
}
