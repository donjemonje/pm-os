import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompetitorsSettings } from "@/components/competitors/CompetitorsSettings";
import { canManageOrgSettings, isPmosAdmin } from "@/lib/admin-auth";
import { PageView } from "@/lib/analytics/PageView";
import { getCompetitorsState } from "@/lib/competitors/store";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { getOrCreateWorkspace, requireUserPage } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Competitors — Settings — PM-OS",
};

/** Settings → Competitors: own site, competitors, catalog, schedule, scan logs. */
export default async function CompetitorsSettingsPage() {
  const user = await requireUserPage("/settings/competitors");
  if (!(await featureEnabledForCurrentUser("competitors"))) notFound();
  const workspace = await getOrCreateWorkspace();
  const state = await getCompetitorsState(workspace.id, user.organizationName ?? "", user.id);
  return (
    <>
      <PageView name="settings_competitors" />
      <CompetitorsSettings initialState={state} canEdit={canManageOrgSettings(user)} isPmosAdmin={isPmosAdmin(user)} />
    </>
  );
}
