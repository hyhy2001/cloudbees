/**
 * Session persistence — save/load/clear encrypted session tokens.
 *
 * Storage: settings table, keys session_token / session_profile / session_url / session_user.
 * Encryption: AES-256-GCM with a machine-local secret file (see crypto.ts). The secret
 * lives outside the DB, so the session_token column alone cannot be decrypted.
 */

import { getConnection } from "../db/connection";
import { deriveKey, encryptToken, decryptToken } from "./crypto";

export interface Session {
  rawToken: string;
  profileName: string;
  serverUrl: string;
  username: string;
}

/**
 * Encrypt rawToken with the machine key and store all session fields.
 * Python: INSERT OR REPLACE for session_token, session_profile, session_url, session_user.
 * Uses standard base64 (not url-safe) — matches Python's base64.b64encode.
 */
export function saveSession(
  rawToken: string,
  profileName: string,
  serverUrl: string,
  username: string,
  dbPath?: string
): void {
  const key = deriveKey(dbPath);
  const enc = encryptToken(rawToken, key);

  const db = getConnection(dbPath);
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
    );
    stmt.run("session_token", enc);
    stmt.run("session_profile", profileName);
    stmt.run("session_url", serverUrl);
    stmt.run("session_user", username);
  } finally {
    db.close();
  }
}

/**
 * Load and decrypt the saved session.
 * Returns null if no session exists or decryption fails.
 * Python: SELECT key, value FROM settings WHERE key LIKE 'session_%'
 */
export function loadSession(dbPath?: string): Session | null {
  interface Row { key: string; value: string }

  const db = getConnection(dbPath);
  let rows: Record<string, string>;
  try {
    const results = db.query<Row, []>(
      "SELECT key, value FROM settings WHERE key LIKE 'session_%'"
    ).all();
    rows = Object.fromEntries(results.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }

  if (!("session_token" in rows)) return null;

  try {
    const key = deriveKey(dbPath);
    const rawToken = decryptToken(rows["session_token"], key);
    return {
      rawToken,
      profileName: rows["session_profile"] ?? "default",
      serverUrl: rows["session_url"] ?? "",
      username: rows["session_user"] ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Delete all session_* keys from settings.
 * Python: DELETE FROM settings WHERE key LIKE 'session_%'
 */
export function clearSession(dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM settings WHERE key LIKE 'session_%'");
  } finally {
    db.close();
  }
}

/**
 * Returns true if a valid session exists.
 */
export function isLoggedIn(dbPath?: string): boolean {
  return loadSession(dbPath) !== null;
}
