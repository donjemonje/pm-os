import { LoginDisabledView } from "@/components/auth/LoginDisabledView";
import { isLoginDisabled, isSignupAllowed } from "@/lib/feature-flags";
import { LoginForm, RegisterForm } from "../login/LoginForm";

// Auth gates (DISABLE_LOGIN / ALLOW_SIGNUP) are runtime env vars, so this page
// must be evaluated per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  if (isLoginDisabled()) {
    return <LoginDisabledView />;
  }

  if (!isSignupAllowed()) {
    return <LoginForm signupAllowed={false} />;
  }

  return <RegisterForm signupAllowed />;
}
