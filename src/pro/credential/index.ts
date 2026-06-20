export interface LicenseCredential {
  licenseKey: string;
  refreshToken?: string;
  installationId: string;
  activatedAt: string;
  expiresAt?: string;
}

export interface CredentialStore {
  load(): Promise<LicenseCredential | null>;
  save(credential: LicenseCredential): Promise<void>;
  clear(): Promise<void>;
}

export const CREDENTIAL_FILENAME = ".kevlar-credentials";

const AES_TAG = "kevlar:aes:v1";
const XOR_TAG = "kevlar:v1";
const APP_SEED = "kevlar-credential-store-v2";
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
} from "node:crypto";

/**
 * AES-256-GCM encrypt-then-base64.
 *
 * Not password-based security (seed is public). Prevents casual read
 * and tampering (GCM auth tag). v2 should use OS-level keychain.
 */
export function obfuscate(text: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = pbkdf2Sync(APP_SEED, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([salt, iv, authTag, encrypted]);
  return AES_TAG + payload.toString("base64");
}

export function deobfuscate(encoded: string): string | null {
  if (encoded.startsWith(AES_TAG)) {
    try {
      const raw = Buffer.from(encoded.slice(AES_TAG.length), "base64");
      const salt = raw.subarray(0, SALT_LENGTH);
      const iv = raw.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const authTag = raw.subarray(
        SALT_LENGTH + IV_LENGTH,
        SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
      );
      const encrypted = raw.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
      const key = pbkdf2Sync(APP_SEED, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted) + decipher.final("utf-8");
    } catch {
      return null;
    }
  }

  if (encoded.startsWith(XOR_TAG)) {
    try {
      const raw = Buffer.from(encoded.slice(XOR_TAG.length), "base64");
      const xorKey = createHash("sha256").update("kevlar-credential-store-v1").digest();
      for (let i = 0; i < raw.length; i++) {
        raw[i] ^= xorKey[i % xorKey.length];
      }
      return raw.toString("utf-8");
    } catch {
      return null;
    }
  }

  return null;
}
