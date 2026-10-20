import { requireAdminPage } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { getAdminOrg } from "@/lib/admin-org";
import { AdminShell } from "../AdminShell";
import { AnalyticsView } from "./AnalyticsView";

export default async function AdminAnalyticsPage() {
  const admin = await requireAdminPage("/admin/analytics");
  const org = await getAdminOrg(admin.organizationId);
  const organizations = await db.organization.findMany({
    where: { workspace: { isNot: null }, id: org.current?.id ?? "" },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true },
  });
  return (
    <AdminShell
      user={admin}
      org={org}
      title="Analytics"
      description="What users do in PM-OS, per organization: every decision and edit (what they changed, before → after), behaviour (pages, searches, filters, sessions), imports, and how often PMOS AI's output needed a correction. The man-in-the-middle view until the learning is automatic."
    >
      <AnalyticsView key={org.current?.id ?? "none"} organizations={organizations} />
    </AdminShell>
  );
}
