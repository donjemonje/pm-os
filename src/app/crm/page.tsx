import { redirect } from "next/navigation";

// Demo leads moved to the marketing site (email-only, no DB) — the CRM's
// remaining job is user/organization management.
export default function CrmDashboardPage() {
  redirect("/crm/users");
}
