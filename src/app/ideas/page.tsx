import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { IdeasView } from "@/components/ideas/IdeasView";
import { db } from "@/lib/db";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Ideas — PM-OS",
};

export default async function IdeasPage() {
  await requireUserPage("/ideas");
  if (!(await ideasEnabledForCurrentUser())) notFound();
  const workspace = await getOrCreateWorkspace();
  const listArgs = {
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" as const },
    select: { name: true },
  };
  const [productLines, platforms, customers] = await Promise.all([
    db.productLine.findMany(listArgs),
    db.platform.findMany(listArgs),
    db.customer.findMany(listArgs),
  ]);

  return (
    <AppShell>
      <IdeasView
        catalogProducts={productLines.map((l) => l.name)}
        catalogPlatforms={platforms.map((p) => p.name)}
        catalogCustomers={customers.map((c) => c.name)}
      />
    </AppShell>
  );
}
