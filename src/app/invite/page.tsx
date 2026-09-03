import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { getCurrentUser } from "@/lib/auth";
import { brand } from "@/lib/brand";
import { isGoogleLoginDisabled, isLoginDisabled } from "@/lib/feature-flags";
import { getOAuthProviderStatuses } from "@/lib/oauth-providers";
import { lookupPasswordToken } from "@/lib/password-tokens";
import { InviteChoices } from "./InviteChoices";

export const metadata: Metadata = {
  title: "Complete your sign-up — PM-OS",
};

// Reads the token and live flags per request.
export const dynamic = "force-dynamic";

/**
 * Invite landing page (the link in the invite email). Verifies the token
 * server-side, then offers two ways to complete the sign-up:
 *   - Google: starts the normal Google flow. The invited email has no
 *     password, so Google links to the existing account and signs in; the
 *     invite token is retired on link (signInWithOAuth).
 *   - Password: the set-password form with the same token.
 * Google is offered whenever Google sign-in is configured and not hidden by
 * env (DISABLE_GOOGLE_LOGIN). The screen always shows — with Google hidden
 * it simply has the one "Sign Up" button.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const { token } = await searchParams;
  const invite = token ? await lookupPasswordToken(token, { inviteOnly: true }) : null;

  const googleAvailable =
    invite !== null &&
    !isLoginDisabled() &&
    !isGoogleLoginDisabled() &&
    getOAuthProviderStatuses().some((p) => p.provider === "google" && p.configured);


  return (
    <AuthNeuralBackground>
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <div className="mb-8 flex items-center justify-center gap-4">
          <BrandLogo height={84} className="shrink-0" priority />
          <h1 className="font-title text-2xl font-bold leading-tight tracking-tight text-brand-text">
            {invite ? "Complete your sign-up" : "Invite not valid"}
          </h1>
        </div>

        {invite ? (
          <InviteChoices
            token={token!}
            name={invite.name}
            email={invite.email}
            organizationName={invite.organizationName}
            googleAvailable={googleAvailable}
          />
        ) : (
          <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            This invite link is missing, expired, or already used. Ask your
            admin to resend the invite.
          </p>
        )}
      </div>
    </AuthNeuralBackground>
  );
}
