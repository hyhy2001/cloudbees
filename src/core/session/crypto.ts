/**
 * Session token encryption — AES-256-GCM with a machine-local secret file.
 *
 * Security model (a dev-tool, not a vault):
 *   - A random 32-byte secret is stored in a file next to the DB (`.bee_secret`),
 *     created with mode 0600 (owner read/write only). The OS file permission is the
 *     real boundary that stops another user on the same host — exactly how SSH keys
 *     and ~/.aws/credentials protect themselves.
 *   - The AES key is derived via scrypt(secretFile || ":" || uid). Mixing the uid in
 *     is defense-in-depth: a secret file copied to another account still derives a
 *     different key there.
 *   - AES-256-GCM gives confidentiality AND integrity (the auth tag detects tampering),
 *     unlike the previous XOR scheme. The secret lives OUTSIDE the DB, so a leaked DB
 *     file alone is useless.
 *
 * Stored ciphertext layout (base64): [ iv(12) | authTag(16) | ciphertext ].
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDbPath } from "../db/connection";
import { CBError } from "../api/errors";

const SECRET_FILENAME = ".bee_secret";
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16; // GCM auth tag length
const KEY_LEN = 32; // AES-256

// scryptSync is deliberately slow (high N). Cache the derived key per dbPath so
// repeated calls within the same process (loadSession, saveSession, etc.) only
// pay the KDF cost once.
const _keyCache = new Map<string, Buffer>();

/** Path of the secret file — lives alongside the DB so they share a directory/perms. */
function secretFilePath(dbPath?: string): string {
  const db = dbPath ?? getDbPath();
  return join(dirname(db), SECRET_FILENAME);
}

/** Current process uid as a string ("0" on platforms without getuid, e.g. Windows). */
function currentUid(): string {
  const fn = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof fn === "function" ? String(fn.call(process)) : "0";
}

/**
 * Return (or lazily create) the per-machine secret bytes.
 * The file is written with mode 0600 — readable only by its owner.
 */
export function getMachineSecret(dbPath?: string): Buffer {
  const path = secretFilePath(dbPath);
  if (existsSync(path)) {
    return readFileSync(path);
  }

  const secret = randomBytes(KEY_LEN);
  mkdirSync(dirname(path), { recursive: true });
  // Write then chmod (writeFileSync mode is pre-umask; chmod makes 0600 explicit).
  writeFileSync(path, secret, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems that don't support chmod
  }
  return secret;
}

/**
 * Derive the 32-byte AES key from the secret file mixed with the current uid.
 * scrypt is deliberately slow, but the secret is high-entropy so cost params stay modest.
 * Result is cached per dbPath so repeated calls within a process pay the KDF cost only once.
 */
export function deriveKey(dbPath?: string): Buffer {
  const cacheKey = dbPath ?? "__default__";
  const cached = _keyCache.get(cacheKey);
  if (cached) return cached;
  const secret = getMachineSecret(dbPath);
  const salt = Buffer.from(`bee:${currentUid()}`, "utf8");
  const key = scryptSync(secret, salt, KEY_LEN);
  _keyCache.set(cacheKey, key);
  return key;
}

/**
 * Encrypt a UTF-8 string. Returns base64( iv | authTag | ciphertext ).
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a base64( iv | authTag | ciphertext ) blob back to UTF-8.
 * Throws if the data was tampered with (GCM tag mismatch) or the key is wrong.
 */
export function decryptToken(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new CBError("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
