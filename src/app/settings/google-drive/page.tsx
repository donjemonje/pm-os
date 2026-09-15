import { notFound, redirect } from "next/navigation";
import { featureEnabledForCurrentUser } from "@/lib/org-features";

/** Legacy route — integrations live on the main settings page. */
export default async function GoogleDriveSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  // Drive follows the Docs flag: off = this route does not exist.
  if (!(await featureEnabledForCurrentUser("docs"))) notFound();
  const params = await searchParams;
  const query = new URLSearchParams();

  if (params.connected) query.set("drive_connected", params.connected);
  if (params.error) query.set("drive_error", params.error);

  const suffix = query.toString() ? `?${query.toString()}` : "";
  redirect(`/settings/jira${suffix}`);
}
