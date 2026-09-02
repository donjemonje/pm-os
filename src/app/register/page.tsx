import { redirect } from "next/navigation";
import { LoginDisabledView } from "@/components/auth/LoginDisabledView";
import { getCurrentUser } from "@/lib/auth";
import { isLoginDisabled } from "@/lib/feature-flags";
import { isSelfSignupEnabled } from "@/lib/system-flags";
import { LoginForm, RegisterForm } from "../login/LoginForm";

// Auth gates (DISABLE_LOGIN env, selfSignup system flag) resolve per request, so this page
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

  if (!(await isSelfSignupEnabled())) {
    return <LoginForm signupAllowed={false} />;
  }

  return <RegisterForm signupAllowed />;
}
