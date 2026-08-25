import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";
import * as OTPAuth from "otpauth";

/// Shared TOTP 2FA helpers used by both auth surfaces (User and CrmUser).
/// Callers own all DB reads/writes; this module only handles secrets, codes,
/// and crypto so the two user tables can't drift apart in behavior.

const TOTP_ISSUER = "PM-OS";
const BACKUP_CODE_COUNT = 8;
// No 0/1/O/I — backup codes get read off paper and typed back in.
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
    period: 30,
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

/** window: 1 tolerates ±30s of clock drift between phone and server. */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const token = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  return totpFor(secretBase32).validate({ token, window: 1 }) !== null;
}

function hashBackupCode(code: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(code, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyBackupCodeHash(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(code, salt, 64).toString("hex");
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch {
    return false;
  }
}

export type BackupCodes = {
  /** Shown to the user exactly once, at enrollment. */
  plaintext: string[];
  /** What gets persisted (totpBackupCodes column). */
  hashed: string[];
};

export function generateBackupCodes(): BackupCodes {
  const plaintext = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (b) =>
      BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length]
    ).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
  return { plaintext, hashed: plaintext.map(hashBackupCode) };
}

/**
 * Returns the remaining hashed codes with the matched one removed, or null if
 * the code matched nothing. Callers must persist the returned array — codes
 * are one-time by contract, not by storage.
 */
export function redeemBackupCode(
  code: string,
  storedHashes: string[]
): string[] | null {
  const normalized = code.trim().toUpperCase();
  const index = storedHashes.findIndex((h) =>
    verifyBackupCodeHash(normalized, h)
  );
  if (index === -1) return null;
  return storedHashes.filter((_, i) => i !== index);
}
