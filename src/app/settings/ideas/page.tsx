import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { db } from "@/lib/db";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace } from "@/lib/workspace";

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
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  const [productLines, platforms] = await Promise.all([
    db.productLine.findMany(LIST_QUERY(workspace.id)),
    db.platform.findMany(LIST_QUERY(workspace.id)),
  ]);

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
        <SettingsListPanel
          title="Platforms"
          blurb="The platforms ideas can target, e.g. iOS, Android, Web."
          endpoint="/api/ideas/lists/platforms"
          namePlaceholder="e.g. iOS"
          descriptionPlaceholder="What does this platform cover? (optional)"
          emptyLabel="No platforms yet. Add the first one above."
          initialItems={platforms}
        />
      </div>
    </div>
  );
}
