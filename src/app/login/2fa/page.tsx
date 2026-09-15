import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getTwoFactorState } from "@/lib/auth";
import { totpEnrollmentUri } from "@/lib/two-factor";
import { TwoFactorChallengeForm } from "./TwoFactorChallengeForm";

export const metadata: Metadata = {
  title: "Two-Factor Check — PM-OS",
};

/**
 * The mandatory 2FA step after every login: enrolled users enter their
 * current code; first-time users scan the QR and confirm one code, which
 * completes enrollment.
 */
export default async function TwoFactorChallengePage() {
  const state = await getTwoFactorState();
  // "none" covers a dead session cookie too (e.g. revoked by deactivation):
  // exit through the ramp that clears stale cookies, otherwise the pending-2FA
  // cookie would bounce /login straight back here in a loop.
  if (state.status === "none") redirect("/api/auth/session-expired");
  if (state.status === "verified") redirect("/");

  if (state.status === "enroll") {
    const qrDataUrl = await QRCode.toDataURL(
      totpEnrollmentUri(state.secret, state.email),
      { margin: 1, width: 220 }
    );
    return <TwoFactorChallengeForm enrollment={{ qrDataUrl, secret: state.secret }} />;
  }

  return <TwoFactorChallengeForm />;
}
