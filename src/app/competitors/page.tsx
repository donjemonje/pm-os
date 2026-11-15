import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { CompetitorsView } from "@/components/competitors/CompetitorsView";
import { canManageOrgSettings } from "@/lib/admin-auth";
import { PageView } from "@/lib/analytics/PageView";
import { getCompetitorsState } from "@/lib/competitors/store";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Competitors — PM-OS",
};

/**
 * Competitors: the C2 full-screen matrix fed by the org's competitors,
 * catalog, scanned statuses and facts (story 2). Server-rendered with the
 * whole state, so the first paint needs no spinner.
 */
export default async function CompetitorsPage() {
  const user = await requireUserPage("/competitors");
  if (!(await featureEnabledForCurrentUser("competitors"))) notFound();
  const workspace = await getOrCreateWorkspace();
  const state = await getCompetitorsState(workspace.id, user.organizationName ?? "", user.id);

  return (
    <AppShell>
      <PageView name="competitors" />
      <CompetitorsView initialState={state} canEdit={canManageOrgSettings(user)} />
    </AppShell>
  );
}
