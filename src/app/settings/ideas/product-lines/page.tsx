import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyProductLinesPanel } from "@/components/ideas/MyProductLinesPanel";
import { ProductLinesPanel } from "@/components/settings/ProductLinesPanel";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { isPmosAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { featureEnabledForCurrentUser, ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Product Lines — PM-OS",
};

export default async function ProductLinesSettingsPage() {
  const user = await requireUserPage("/settings/ideas/product-lines");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  const myLinesEnabled = await featureEnabledForCurrentUser("myProductLines");
  // Components (platforms) off in Admin → Ideas hides the whole platforms
  // concept here, not just the Jira mapping.
  const platformsEnabled = mergeIdeasJiraConfig(workspace.ideasConfig).fields.platforms.enabled;
  const [productLines, platforms, dbUser] = await Promise.all([
    db.productLine.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true },
    }),
    db.platform.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, description: true },
    }),
    db.user.findUnique({
      where: { id: user.id },
      select: { defaultProductLines: true },
    }),
  ]);
  const myProductLines = ((dbUser?.defaultProductLines as string[]) ?? []).filter((p) =>
    productLines.some((l) => l.name.toLowerCase() === p.toLowerCase())
  );

  return (
    <div className="space-y-8">
      <ProductLinesPanel initialItems={productLines} canEdit={isPmosAdmin(user)} />
      {myLinesEnabled && productLines.length > 0 && (
        <MyProductLinesPanel
          options={productLines.map((l) => l.name)}
          initialSelected={myProductLines}
        />
      )}
      {platformsEnabled && (
        <SettingsListPanel
          title="Platforms"
          blurb="The platforms ideas can target, e.g. iOS, Android, Web."
          endpoint="/api/ideas/lists/platforms"
          namePlaceholder="e.g. iOS"
          descriptionPlaceholder="What does this platform cover? (optional)"
          emptyLabel="No platforms yet. Add the first one above."
          initialItems={platforms}
        />
      )}
    </div>
  );
}
