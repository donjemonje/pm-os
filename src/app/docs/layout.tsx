import { notFound } from "next/navigation";
import { featureEnabledForCurrentUser } from "@/lib/org-features";

/**
 * Server-side gate for the Docs surface — covers /docs, /docs/new and
 * /docs/[id] (the list page is a client component, so the gate lives in
 * this shared layout): 404 when the `docs` flag is off for the caller's
 * org. The /api/documents routes carry the same gate.
 */
export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await featureEnabledForCurrentUser("docs"))) notFound();
  return <>{children}</>;
}
