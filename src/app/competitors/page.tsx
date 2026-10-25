import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { CompetitorsView } from "@/components/competitors/CompetitorsView";
import { db } from "@/lib/db";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Competitors — PM-OS",
};

/**
 * Competitors (story 1, UI layout): the C2 page with zero competitors. Only
 * data the org already holds is shown — its name (the matrix's own column)
 * and its product-line catalog (the Product line filter); everything else
 * renders as an empty state, never sample data.
 */
export default async function CompetitorsPage() {
  const user = await requireUserPage("/competitors");
  if (!(await featureEnabledForCurrentUser("competitors"))) notFound();
  const workspace = await getOrCreateWorkspace();
  const productLines = await db.productLine.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { name: true },
  });

  return (
    <AppShell>
      <CompetitorsView
        orgName={user.organizationName ?? ""}
        catalogProducts={productLines.map((l) => l.name)}
      />
    </AppShell>
  );
}
