import { redirect } from "next/navigation";

/** Legacy route — integrations live on the main settings page. */
export default async function GoogleDriveSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();

  if (params.connected) query.set("drive_connected", params.connected);
  if (params.error) query.set("drive_error", params.error);

  const suffix = query.toString() ? `?${query.toString()}` : "";
  redirect(`/settings/jira${suffix}`);
}
