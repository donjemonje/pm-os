import { redirect } from "next/navigation";
import { LoginDisabledView } from "@/components/auth/LoginDisabledView";
import { getCurrentUser } from "@/lib/auth";
import { isLoginDisabled, isSignupAllowed } from "@/lib/feature-flags";
import { LoginForm, RegisterForm } from "../login/LoginForm";

// Auth gates (DISABLE_LOGIN / ALLOW_SIGNUP) are runtime env vars, so this page
// must be evaluated per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  // Same server-side session check as /login (see there for why the edge
  // proxy no longer redirects cookie-holders).
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  if (isLoginDisabled()) {
    return <LoginDisabledView />;
  }

  if (!isSignupAllowed()) {
    return <LoginForm signupAllowed={false} />;
  }

  return <RegisterForm signupAllowed />;
}
