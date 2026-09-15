import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

// The session check reads cookies, so this page must be evaluated per
// request rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Server-side session check (replaces the old edge redirect, which trusted
  // cookie presence and trapped holders of revoked-session cookies): only a
  // genuinely signed-in user is sent to the dashboard; a stale cookie just
  // renders the form, and logging in overwrites it.
  const user = await getCurrentUser();
  if (user) redirect("/");

  return <LoginForm />;
}
