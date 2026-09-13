import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { db } from "@/lib/db";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { ensureCatalogColors } from "@/lib/ideas/catalog-colors";

export const metadata: Metadata = {
  title: "Customers — PM-OS",
};

export default async function CustomersSettingsPage() {
  await requireUserPage("/settings/ideas/customers");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  await ensureCatalogColors(workspace.id);
  const customers = await db.customer.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, color: true },
  });

  return (
    <SettingsListPanel
      title="Customers"
      blurb="The customers tickets can affect. PMOS AI tags ideas with customers from this list and suggests new names it finds in tickets — approving a suggestion adds it here."
      endpoint="/api/ideas/lists/customers"
      namePlaceholder="Customer name"
      descriptionPlaceholder="Anything that helps recognize them in tickets, e.g. aliases or tier (optional)"
      emptyLabel="No customers yet. Add the first one above."
      initialItems={customers}
    />
  );
}
