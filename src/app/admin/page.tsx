import { redirect } from "next/navigation";

// PM-OS Admin — internal console for managing client organizations, users,
// and per-org configuration. Access requires User.role === PMOS_ADMIN;
// each sub-page enforces it server-side.
export default function AdminPage() {
  redirect("/admin/users");
}
