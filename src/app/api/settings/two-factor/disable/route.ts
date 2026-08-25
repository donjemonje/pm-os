import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-auth";
import { db } from "@/lib/db";
import {
  decryptTotpSecret,
  redeemBackupCode,
  verifyTotpCode,
} from "@/lib/two-factor";

/** Turns 2FA off. Requires a current TOTP code or an unused backup code. */
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
    select: { totpSecretEnc: true, totpEnabledAt: true, totpBackupCodes: true },
  });
  if (!dbUser?.totpEnabledAt || !dbUser.totpSecretEnc) {
    return NextResponse.json(
      { error: "Two-factor authentication is not enabled" },
      { status: 400 }
    );
  }

  const valid =
    verifyTotpCode(decryptTotpSecret(dbUser.totpSecretEnc), code) ||
    redeemBackupCode(code, dbUser.totpBackupCodes) !== null;
  if (!valid) {
    return NextResponse.json(
      { error: "That code didn't match — enter a current code or a backup code" },
      { status: 400 }
    );
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      totpSecretEnc: null,
      totpEnabledAt: null,
      totpBackupCodes: [],
    },
  });

  return NextResponse.json({ ok: true });
}
