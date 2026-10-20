import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { db } from "@/lib/db";
import { PageView } from "@/lib/analytics/PageView";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { ensureCatalogColors } from "@/lib/ideas/catalog-colors";
import { isAllCustomers } from "@/lib/ideas/customer-key";
import { catalogUsage, usageOf } from "@/lib/ideas/catalog-usage";

export const metadata: Metadata = {
  title: "Customers — PM-OS",
};

export default async function CustomersSettingsPage() {
  await requireUserPage("/settings/ideas/customers");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  await ensureCatalogColors(workspace.id);
  const usage = await catalogUsage(workspace.id);
  const customers = await db.customer.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, color: true, aliases: true },
  });

  return (
    <>
    <PageView name="settings_customers" />
    <SettingsListPanel
      title="Customers"
      blurb="PMOS tags ideas with customers from this list and suggests new names it finds in tickets — approving a suggestion adds it here."
      endpoint="/api/ideas/lists/customers"
      mergeEndpoint="/api/ideas/lists/customers/merge"
      namePlaceholder="Customer name"
      aliasesPlaceholder="Aliases, comma-separated (optional)"
      emptyLabel="No customers yet. Add the first one with the button above."
      initialItems={customers.map((c) => ({
        ...c,
        aliases: (c.aliases as string[]) ?? [],
        builtIn: isAllCustomers(c.name),
        usage: usageOf(usage.customers, c.name),
      }))}
    />
    </>
  );
}
