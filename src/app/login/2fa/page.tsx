import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/auth";
import { TwoFactorChallengeForm } from "./TwoFactorChallengeForm";

export const metadata: Metadata = {
  title: "Two-Factor Check — PM-OS",
};

export default async function TwoFactorChallengePage() {
  // No session at all means there's nothing to challenge — start over.
  if (!(await getSessionToken())) redirect("/login");
  return <TwoFactorChallengeForm />;
}
