import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { IdeasView } from "@/components/ideas/IdeasView";
import { db } from "@/lib/db";
import { isIdeasEnabled } from "@/lib/feature-flags";
import { getOrCreateWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Ideas — PM-OS",
};

export default async function IdeasPage() {
  if (!isIdeasEnabled()) notFound();
  const workspace = await getOrCreateWorkspace();
  const listArgs = {
    where: { workspaceId: workspace.id },
    orderBy: { name: "asc" as const },
    select: { name: true },
  };
  const [productLines, platforms] = await Promise.all([
    db.productLine.findMany(listArgs),
    db.platform.findMany(listArgs),
  ]);

  return (
    <AppShell>
      <IdeasView
        catalogProducts={productLines.map((l) => l.name)}
        catalogPlatforms={platforms.map((p) => p.name)}
      />
    </AppShell>
  );
}
