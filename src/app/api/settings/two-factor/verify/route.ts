import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-auth";
import { markCurrentSessionTwoFactorVerified } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  decryptTotpSecret,
  generateBackupCodes,
  verifyTotpCode,
} from "@/lib/two-factor";

/**
 * Completes enrollment: the user proves the authenticator works by submitting
 * one code. Only then does 2FA turn on; backup codes are returned exactly once.
 */
export async function POST(request: Request) {
  const user = await apiUser();
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { totpSecretEnc: true, totpEnabledAt: true },
  });
  if (dbUser?.totpEnabledAt) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enabled" },
      { status: 400 }
    );
  }
  if (!dbUser?.totpSecretEnc) {
    return NextResponse.json(
      { error: "Start setup first" },
      { status: 400 }
    );
  }

  if (!verifyTotpCode(decryptTotpSecret(dbUser.totpSecretEnc), code)) {
    return NextResponse.json(
      { error: "That code didn't match — check your authenticator app and try again" },
      { status: 400 }
    );
  }

  const backupCodes = generateBackupCodes();
  await db.user.update({
    where: { id: user.id },
    data: {
      totpEnabledAt: new Date(),
      totpBackupCodes: backupCodes.hashed,
    },
  });
  await markCurrentSessionTwoFactorVerified();

  return NextResponse.json({ backupCodes: backupCodes.plaintext });
}
