import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { IdeasView } from "@/components/ideas/IdeasView";
import { db } from "@/lib/db";
import { featureEnabledForCurrentUser, ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";
import { ensureCatalogColors } from "@/lib/ideas/catalog-colors";

export const metadata: Metadata = {
  title: "Ideas — PM-OS",
};

export default async function IdeasPage() {
  const user = await requireUserPage("/ideas");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const undoEnabled = await featureEnabledForCurrentUser("ideasUndo");
  const myLinesEnabled = await featureEnabledForCurrentUser("myProductLines");
  const workspace = await getOrCreateWorkspace();
  await ensureCatalogColors(workspace.id);
  const listArgs = {
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" as const },
    select: { name: true },
  };
  const [productLines, platforms, customers, dbUser] = await Promise.all([
    db.productLine.findMany({
      ...listArgs,
      select: { name: true, color: true },
      orderBy: [{ position: "asc" as const }, { name: "asc" as const }],
    }),
    db.platform.findMany(listArgs),
    db.customer.findMany({ ...listArgs, select: { name: true, color: true } }),
    db.user.findUnique({
      where: { id: user.id },
      select: { defaultProductLines: true },
    }),
  ]);
  // The user's own lines (Settings → Ideas → My Product Lines) pre-filter the
  // screen; names that left the catalog are dropped, not shown as ghosts.
  const defaultProducts = myLinesEnabled
    ? ((dbUser?.defaultProductLines as string[]) ?? []).filter((p) =>
        productLines.some((l) => l.name.toLowerCase() === p.toLowerCase())
      )
    : [];

  return (
    <AppShell>
      <IdeasView
        catalogProducts={productLines.map((l) => l.name)}
        catalogPlatforms={platforms.map((p) => p.name)}
        catalogCustomers={customers.map((c) => c.name)}
        productColors={Object.fromEntries(
          productLines.flatMap((l) => (l.color ? [[l.name, l.color]] : []))
        )}
        customerColors={Object.fromEntries(
          customers.flatMap((c) => (c.color ? [[c.name, c.color]] : []))
        )}
        defaultProducts={defaultProducts}
        undoEnabled={undoEnabled}
      />
    </AppShell>
  );
}
