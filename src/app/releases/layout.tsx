import { notFound } from "next/navigation";
import { featureEnabledForCurrentUser } from "@/lib/org-features";

/**
 * Releases exist to hold release-notes documents, so the surface rides the
 * `docs` flag: 404 when docs is off for the caller's org (same gate as
 * /docs; the /api/releases routes carry it too).
 */
export default async function ReleasesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await featureEnabledForCurrentUser("docs"))) notFound();
  return <>{children}</>;
}
