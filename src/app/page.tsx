import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { landingPathForCurrentUser } from "@/lib/landing";

// The marketing site lives in the pmos-website repo (pm-os.io). The app root
// is the single entry point into the app: signed-out visitors go to login,
// signed-in users to their landing page (first ON surface in menu order).
export const dynamic = "force-dynamic";

export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(await landingPathForCurrentUser());
}
