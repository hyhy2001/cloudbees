/**
 * Session persistence — per-profile encrypted session tokens.
 *
 * Storage (settings table):
 *   active_profile                → name of the profile whose session is "current"
 *   session.<profile>.token       → AES-256-GCM encrypted API token (see crypto.ts)
 *   session.<profile>.url         → that profile's server URL
 *   session.<profile>.user        → that profile's username
 *
 * Multiple profiles can be logged in at once; `active_profile` is the pointer the
 * rest of the app reads through loadSession(). switchProfile() just moves that
 * pointer. The encryption secret lives outside the DB (crypto.ts), so the token
 * columns alone cannot be decrypted.
 *
 * Legacy single-session layout (session_token / session_profile / session_url /
 * session_user) is migrated to the per-profile layout on first loadSession().
 */

import { getConnection } from "../db/connection";
import { deriveKey, encryptToken, decryptToken } from "./crypto";

export interface Session {
  rawToken: string;
  profileName: string;
  serverUrl: string;
  username: string;
}

const ACTIVE_PROFILE_KEY = "active_profile";
const DEFAULT_PROFILE = "default";

/** settings key for one of a profile's session fields. */
function sessKey(profile: string, field: "token" | "url" | "user"): string {
  return `session.${profile}.${field}`;
}

/** Raw (still-encrypted) session row for a profile, or null if absent. */
interface RawSession {
  enc: string;
  url: string;
  user: string;
}

/** Read a single settings value within an open connection. */
function getVal(db: ReturnType<typeof getConnection>, key: string): string | null {
  const row = db.query<{ value: string }, [string]>(
    "SELECT value FROM settings WHERE key = ?",
  ).get(key);
  return row !== null ? row.value : null;
}

/** Read a profile's raw session fields within an open connection. */
function readRaw(db: ReturnType<typeof getConnection>, profile: string): RawSession | null {
  const enc = getVal(db, sessKey(profile, "token"));
  if (enc === null) return null;
  return {
    enc,
    url: getVal(db, sessKey(profile, "url")) ?? "",
    user: getVal(db, sessKey(profile, "user")) ?? "",
  };
}

/** Decrypt a RawSession into a Session, or null if decryption fails. */
function decryptRaw(raw: RawSession, profile: string, dbPath?: string): Session | null {
  try {
    const key = deriveKey(dbPath);
    return {
      rawToken: decryptToken(raw.enc, key),
      profileName: profile,
      serverUrl: raw.url,
      username: raw.user,
    };
  } catch {
    return null;
  }
}

/**
 * Name of the active profile — the one loadSession() resolves to. Falls back to
 * the legacy `session_profile` key, then "default", so a pre-migration DB still
 * resolves to a sensible name for resource-tracking keys.
 */
export function getActiveProfileName(dbPath?: string): string {
  const db = getConnection(dbPath);
  try {
    return getVal(db, ACTIVE_PROFILE_KEY) ?? getVal(db, "session_profile") ?? DEFAULT_PROFILE;
  } finally {
    db.close();
  }
}

/**
 * Encrypt rawToken and store it under the profile's session keys, then mark that
 * profile active. Logging in always makes the just-authenticated profile current
 * (matches the previous single-session behaviour).
 */
export function saveSession(
  rawToken: string,
  profileName: string,
  serverUrl: string,
  username: string,
  dbPath?: string,
): void {
  const key = deriveKey(dbPath);
  const enc = encryptToken(rawToken, key);

  const db = getConnection(dbPath);
  try {
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    stmt.run(sessKey(profileName, "token"), enc);
    stmt.run(sessKey(profileName, "url"), serverUrl);
    stmt.run(sessKey(profileName, "user"), username);
    stmt.run(ACTIVE_PROFILE_KEY, profileName);
  } finally {
    db.close();
  }
}

/** Load and decrypt a specific profile's session. Returns null if none/garbled. */
export function loadSessionFor(profileName: string, dbPath?: string): Session | null {
  const db = getConnection(dbPath);
  let raw: RawSession | null;
  try {
    raw = readRaw(db, profileName);
  } finally {
    db.close();
  }
  if (!raw) return null;
  return decryptRaw(raw, profileName, dbPath);
}

/**
 * Load and decrypt the active profile's session. Returns null if no profile is
 * logged in. Transparently migrates a legacy single-session DB on first call.
 */
export function loadSession(dbPath?: string): Session | null {
  const db = getConnection(dbPath);
  let profile: string;
  let raw: RawSession | null;
  try {
    const active = getVal(db, ACTIVE_PROFILE_KEY);
    if (active !== null) {
      profile = active;
      raw = readRaw(db, profile);
    } else {
      // No active pointer yet → attempt one-time migration from legacy keys.
      const legacyEnc = getVal(db, "session_token");
      if (legacyEnc === null) return null;
      profile = getVal(db, "session_profile") ?? DEFAULT_PROFILE;
      raw = {
        enc: legacyEnc,
        url: getVal(db, "session_url") ?? "",
        user: getVal(db, "session_user") ?? "",
      };
      // Persist under the per-profile layout, set the active pointer, drop legacy.
      const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      stmt.run(sessKey(profile, "token"), raw.enc);
      stmt.run(sessKey(profile, "url"), raw.url);
      stmt.run(sessKey(profile, "user"), raw.user);
      stmt.run(ACTIVE_PROFILE_KEY, profile);
      db.run("DELETE FROM settings WHERE key LIKE 'session\\_%' ESCAPE '\\'");
    }
  } finally {
    db.close();
  }
  if (!raw) return null;
  return decryptRaw(raw, profile, dbPath);
}

/**
 * Move the active pointer to another profile. Returns false (no-op) if that
 * profile has no stored session — you can only switch to a logged-in profile.
 */
export function switchProfile(profileName: string, dbPath?: string): boolean {
  if (loadSessionFor(profileName, dbPath) === null) return false;
  const db = getConnection(dbPath);
  try {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
      ACTIVE_PROFILE_KEY,
      profileName,
    ]);
  } finally {
    db.close();
  }
  return true;
}

/**
 * Remove the stored session for a profile (defaults to the active one). If the
 * cleared profile was active, the active pointer is dropped (logged out) unless
 * another logged-in profile remains, in which case it becomes active.
 */
export function clearSession(profileName?: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    const active = getVal(db, ACTIVE_PROFILE_KEY);
    const target = profileName ?? active ?? DEFAULT_PROFILE;

    const del = db.prepare("DELETE FROM settings WHERE key = ?");
    del.run(sessKey(target, "token"));
    del.run(sessKey(target, "url"));
    del.run(sessKey(target, "user"));
    // Also clear that profile's controller selection.
    del.run(`active_controller.${target}`);
    del.run(`active_controller_url.${target}`);

    if (active === target || active === null) {
      // Find another profile that still has a session token.
      const next = db.query<{ key: string }, []>(
        "SELECT key FROM settings WHERE key LIKE 'session.%.token' LIMIT 1",
      ).get();
      if (next) {
        // key = "session.<profile>.token" → extract <profile>
        const p = next.key.slice("session.".length, -".token".length);
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
          ACTIVE_PROFILE_KEY,
          p,
        ]);
      } else {
        del.run(ACTIVE_PROFILE_KEY);
      }
    }

    // Drop any stale legacy keys so they never resurrect via migration.
    db.run("DELETE FROM settings WHERE key LIKE 'session\\_%' ESCAPE '\\'");
  } finally {
    db.close();
  }
}

/** True if the active profile has a valid (decryptable) session. */
export function isLoggedIn(dbPath?: string): boolean {
  return loadSession(dbPath) !== null;
}
