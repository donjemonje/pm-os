import { redirect } from "next/navigation";
import { LoginDisabledView } from "@/components/auth/LoginDisabledView";
import { getCurrentUser } from "@/lib/auth";
import { isLoginDisabled, isSignupAllowed } from "@/lib/feature-flags";
import { LoginForm } from "./LoginForm";

// Auth gates (DISABLE_LOGIN / ALLOW_SIGNUP) are runtime env vars, so this page
// must be evaluated per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Server-side session check (replaces the old edge redirect, which trusted
  // cookie presence and trapped holders of revoked-session cookies): only a
  // genuinely signed-in user is sent to the dashboard; a stale cookie just
  // renders the form, and logging in overwrites it.
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  if (isLoginDisabled()) {
    return <LoginDisabledView />;
  }

  return <LoginForm signupAllowed={isSignupAllowed()} />;
}
