import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyProductLinesPanel } from "@/components/ideas/MyProductLinesPanel";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { db } from "@/lib/db";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Ideas Settings — PM-OS",
};

const LIST_SELECT = { id: true, name: true, description: true } as const;
const LIST_QUERY = (workspaceId: string) => ({
  where: { workspaceId },
  orderBy: { name: "asc" as const },
  select: LIST_SELECT,
});

export default async function IdeasSettingsPage() {
  const user = await requireUserPage("/settings/ideas");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  const [productLines, platforms, customers, dbUser] = await Promise.all([
    db.productLine.findMany(LIST_QUERY(workspace.id)),
    db.platform.findMany(LIST_QUERY(workspace.id)),
    db.customer.findMany(LIST_QUERY(workspace.id)),
    db.user.findUnique({
      where: { id: user.id },
      select: { defaultProductLines: true },
    }),
  ]);
  const myProductLines = ((dbUser?.defaultProductLines as string[]) ?? []).filter((p) =>
    productLines.some((l) => l.name.toLowerCase() === p.toLowerCase())
  );

  return (
    <div>
      <p className="mb-6 text-sm text-muted">
        Settings for the Ideas pipeline.
      </p>
      <div className="space-y-8">
        <SettingsListPanel
          title="Product Lines"
          blurb="The products ideas can belong to. Add a short description of what each one covers."
          endpoint="/api/ideas/lists/product-lines"
          namePlaceholder="Name"
          descriptionPlaceholder="What is this product line? (optional)"
          emptyLabel="No product lines yet. Add the first one above."
          initialItems={productLines}
        />
        <MyProductLinesPanel
          options={productLines.map((l) => l.name)}
          initialSelected={myProductLines}
        />
        <SettingsListPanel
          title="Platforms"
          blurb="The platforms ideas can target, e.g. iOS, Android, Web."
          endpoint="/api/ideas/lists/platforms"
          namePlaceholder="e.g. iOS"
          descriptionPlaceholder="What does this platform cover? (optional)"
          emptyLabel="No platforms yet. Add the first one above."
          initialItems={platforms}
        />
        <SettingsListPanel
          title="Customers"
          blurb="The customers tickets can affect. PMOS AI tags ideas with customers from this list and suggests new names it finds in tickets — approving a suggestion adds it here."
          endpoint="/api/ideas/lists/customers"
          namePlaceholder="Customer name"
          descriptionPlaceholder="Anything that helps recognize them in tickets, e.g. aliases or tier (optional)"
          emptyLabel="No customers yet. Add the first one above."
          initialItems={customers}
        />
      </div>
    </div>
  );
}
