import { notFound } from "next/navigation";
import { featureEnabledForCurrentUser } from "@/lib/org-features";

/**
 * Server-side gate for the Chat surface (the page itself is a client
 * component): 404 when the `chat` flag is off for the caller's org.
 * The /api/chat routes carry the same gate.
 */
export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await featureEnabledForCurrentUser("chat"))) notFound();
  return <>{children}</>;
}
