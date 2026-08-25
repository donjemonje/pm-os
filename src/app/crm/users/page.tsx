import { redirect } from "next/navigation";
import { listOrganizationsWithMembers } from "@/lib/auth";
import { getCurrentCrmUser } from "@/lib/crm-auth";
import { CrmShell } from "../CrmShell";
import { UserManagement } from "./UserManagement";

export default async function CrmUsersPage() {
  const user = await getCurrentCrmUser();
  if (!user) redirect("/crm/login");

  const organizations = await listOrganizationsWithMembers();

  return (
    <CrmShell
      user={user}
      title="User Management"
      description="Add and manage users across organizations."
    >
      <UserManagement initialOrganizations={organizations} />
    </CrmShell>
  );
}
