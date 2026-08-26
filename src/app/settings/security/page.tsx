import type { Metadata } from "next";
import { TwoFactorPanel } from "@/components/settings/TwoFactorPanel";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Security Settings — PM-OS",
};

export default async function SecuritySettingsPage() {
  const user = await requireUser();
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { totpEnabledAt: true },
  });

  return (
    <div>
      <p className="mb-6 text-sm text-muted">
        Protect your account with an extra sign-in step.
      </p>
      <TwoFactorPanel enabledAt={dbUser?.totpEnabledAt?.toISOString() ?? null} />
    </div>
  );
}
