import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyProductLinesPanel } from "@/components/ideas/MyProductLinesPanel";
import { ProductLinesPanel } from "@/components/settings/ProductLinesPanel";
import { SettingsListPanel } from "@/components/settings/SettingsListPanel";
import { canManageOrgSettings } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { PageView } from "@/lib/analytics/PageView";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { featureEnabledForCurrentUser, ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { ensureCatalogColors } from "@/lib/ideas/catalog-colors";
import { catalogUsage, usageOf } from "@/lib/ideas/catalog-usage";

export const metadata: Metadata = {
  title: "Product Lines — PM-OS",
};

export default async function ProductLinesSettingsPage() {
  const user = await requireUserPage("/settings/ideas/product-lines");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  await ensureCatalogColors(workspace.id);
  const myLinesEnabled = await featureEnabledForCurrentUser("myProductLines");
  // Components (platforms) off in Admin → Ideas hides the whole platforms
  // concept here, not just the Jira mapping.
  const platformsEnabled = mergeIdeasJiraConfig(workspace.ideasConfig).fields.platforms.enabled;
  const usage = await catalogUsage(workspace.id);
  const [productLines, platforms, dbUser] = await Promise.all([
    db.productLine.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true, color: true, origin: true, aliases: true },
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
    <>
    <PageView name="settings_product_lines" />
    <div className="space-y-8">
      <ProductLinesPanel
        initialItems={productLines.map((l) => ({
          ...l,
          aliases: Array.isArray(l.aliases)
            ? l.aliases.filter((a): a is string => typeof a === "string")
            : [],
          usage: usageOf(usage.products, l.name),
        }))}
        canEdit={canManageOrgSettings(user)}
      />
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
          emptyLabel="No platforms yet. Add the first one with the button above."
          initialItems={platforms}
        />
      )}
    </div>
    </>
  );
}
