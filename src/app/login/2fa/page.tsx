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
  if (state.status === "none") redirect("/login");
  if (state.status === "verified") redirect("/dashboard");

  if (state.status === "enroll") {
    const qrDataUrl = await QRCode.toDataURL(
      totpEnrollmentUri(state.secret, state.email),
      { margin: 1, width: 220 }
    );
    return <TwoFactorChallengeForm enrollment={{ qrDataUrl, secret: state.secret }} />;
  }

  return <TwoFactorChallengeForm />;
}
