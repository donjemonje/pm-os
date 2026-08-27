import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import * as OTPAuth from "otpauth";

/// Shared TOTP 2FA helpers. Callers own all DB reads/writes; this module only
/// handles secrets and code verification so auth surfaces can't drift apart.
/// No backup codes by design — recovery is an admin clearing the totp fields.

const TOTP_ISSUER = "PM-OS";
const TOTP_PERIOD_SECONDS = 30;

function encryptionKey(): Buffer {
  const raw = process.env.TOTP_ENC_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOTP_ENC_KEY must be set in production");
    }
    return scryptSync("dev-totp-key", "pmos-dev", 32);
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("TOTP_ENC_KEY must be 64 hex characters (32 bytes)");
  }
  return key;
}

// Stored format: iv:ciphertext:authTag, all hex.
export function encryptTotpSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secretBase32, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("hex"),
    encrypted.toString("hex"),
    cipher.getAuthTag().toString("hex"),
  ].join(":");
}

export function decryptTotpSecret(stored: string): string {
  const [ivHex, dataHex, tagHex] = stored.split(":");
  if (!ivHex || !dataHex || !tagHex) {
    throw new Error("Malformed encrypted TOTP secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string, accountEmail?: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: accountEmail ?? TOTP_ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** otpauth:// URI for the enrollment QR code. */
export function totpEnrollmentUri(
  secretBase32: string,
  accountEmail: string
): string {
  return totpFor(secretBase32, accountEmail).toString();
}

/**
 * Strict verification: only the current 30-second window is accepted (no
 * drift tolerance), and the caller must enforce single use by persisting the
 * returned time-step and rejecting any step <= the stored one.
 *
 * Returns the time-step the code belongs to, or null when the code is wrong.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string
): number | null {
  const token = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totpFor(secretBase32).validate({ token, window: 0 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta;
}

/** True when `step` hasn't been consumed yet (single-use guard). */
export function isFreshTotpStep(
  step: number,
  lastUsedStep: number | null
): boolean {
  return lastUsedStep === null || step > lastUsedStep;
}
