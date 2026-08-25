import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { apiUser } from "@/lib/api-auth";
import { db } from "@/lib/db";
import {
  encryptTotpSecret,
  generateTotpSecret,
  totpEnrollmentUri,
} from "@/lib/two-factor";

/**
 * Starts (or restarts) TOTP enrollment: stores a fresh encrypted secret and
 * returns the QR + manual-entry secret. Harmless to call repeatedly — 2FA is
 * only considered on once /verify confirms a code.
 */
export async function POST() {
  const user = await apiUser();
  if (user instanceof NextResponse) return user;

  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { totpEnabledAt: true },
  });
  if (dbUser?.totpEnabledAt) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enabled" },
      { status: 400 }
    );
  }

  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: user.id },
    data: { totpSecretEnc: encryptTotpSecret(secret) },
  });

  const qrDataUrl = await QRCode.toDataURL(
    totpEnrollmentUri(secret, user.email),
    { margin: 1, width: 220 }
  );
  return NextResponse.json({ qrDataUrl, secret });
}
