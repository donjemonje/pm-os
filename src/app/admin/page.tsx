import { redirect } from "next/navigation";

// PM-OS Admin — internal console for managing client organizations, users,
// and per-org configuration. Access is restricted to the ADMIN_EMAILS
// allowlist; each sub-page enforces it server-side.
export default function AdminPage() {
  redirect("/admin/users");
}
