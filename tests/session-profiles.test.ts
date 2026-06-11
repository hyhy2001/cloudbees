/**
 * Per-profile session tests — save/load/switch/clear + legacy migration.
 * Uses an explicit dbPath (and the matching .bee_secret next to it) so the
 * module-level _DB_PATH cache is bypassed and crypto derives a stable key.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bee-session-test-"));
const DB_PATH = join(TMP_DIR, "test.db");

import { initDb, getConnection } from "../src/core/db/connection";
import {
  saveSession,
  loadSession,
  loadSessionFor,
  switchProfile,
  clearSession,
  getActiveProfileName,
  isLoggedIn,
} from "../src/core/session/session";
import { encryptToken, deriveKey } from "../src/core/session/crypto";

beforeAll(() => {
  initDb(DB_PATH);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Wipe all session.* / active_profile / legacy keys between tests. */
function reset(): void {
  const db = getConnection(DB_PATH);
  try {
    db.run("DELETE FROM settings WHERE key LIKE 'session%' OR key = 'active_profile'");
    db.run("DELETE FROM settings WHERE key LIKE 'active_controller%'");
  } finally {
    db.close();
  }
}

describe("per-profile session", () => {
  test("save + load round-trips the active profile", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    const s = loadSession(DB_PATH);
    expect(s).not.toBeNull();
    expect(s!.profileName).toBe("alpha");
    expect(s!.rawToken).toBe("tok-a");
    expect(s!.serverUrl).toBe("https://a.example.com");
    expect(s!.username).toBe("alice");
    expect(getActiveProfileName(DB_PATH)).toBe("alpha");
    expect(isLoggedIn(DB_PATH)).toBe(true);
  });

  test("logging in a second profile keeps the first and makes the new one active", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    saveSession("tok-b", "beta", "https://b.example.com", "bob", DB_PATH);

    // Active is the most recent login.
    expect(getActiveProfileName(DB_PATH)).toBe("beta");
    expect(loadSession(DB_PATH)!.rawToken).toBe("tok-b");

    // The first profile's session still exists, independently loadable.
    const a = loadSessionFor("alpha", DB_PATH);
    expect(a).not.toBeNull();
    expect(a!.rawToken).toBe("tok-a");
    expect(a!.username).toBe("alice");
  });

  test("switchProfile moves the active pointer to a logged-in profile", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    saveSession("tok-b", "beta", "https://b.example.com", "bob", DB_PATH);

    expect(switchProfile("alpha", DB_PATH)).toBe(true);
    expect(getActiveProfileName(DB_PATH)).toBe("alpha");
    expect(loadSession(DB_PATH)!.rawToken).toBe("tok-a");
  });

  test("switchProfile to an unknown profile is a no-op returning false", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    expect(switchProfile("ghost", DB_PATH)).toBe(false);
    expect(getActiveProfileName(DB_PATH)).toBe("alpha");
  });

  test("clearSession on active falls over to a remaining profile", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    saveSession("tok-b", "beta", "https://b.example.com", "bob", DB_PATH);
    // beta is active; clear it → should fall back to alpha.
    clearSession("beta", DB_PATH);
    expect(loadSessionFor("beta", DB_PATH)).toBeNull();
    expect(getActiveProfileName(DB_PATH)).toBe("alpha");
    expect(loadSession(DB_PATH)!.rawToken).toBe("tok-a");
  });

  test("clearSession on the last profile logs out completely", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    clearSession("alpha", DB_PATH);
    expect(loadSession(DB_PATH)).toBeNull();
    expect(isLoggedIn(DB_PATH)).toBe(false);
  });

  test("clearSession defaults to the active profile when no name given", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    clearSession(undefined, DB_PATH);
    expect(loadSessionFor("alpha", DB_PATH)).toBeNull();
  });
});

describe("legacy single-session migration", () => {
  test("loadSession migrates legacy session_* keys to the per-profile layout", () => {
    reset();
    // Simulate a pre-migration DB: write legacy keys directly.
    const enc = encryptToken("legacy-tok", deriveKey(DB_PATH));
    const db = getConnection(DB_PATH);
    try {
      const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      stmt.run("session_token", enc);
      stmt.run("session_profile", "default");
      stmt.run("session_url", "https://legacy.example.com");
      stmt.run("session_user", "carol");
    } finally {
      db.close();
    }

    const s = loadSession(DB_PATH);
    expect(s).not.toBeNull();
    expect(s!.rawToken).toBe("legacy-tok");
    expect(s!.profileName).toBe("default");
    expect(s!.username).toBe("carol");

    // Legacy keys should be gone, new layout present + active pointer set.
    const db2 = getConnection(DB_PATH);
    try {
      const legacy = db2.query("SELECT value FROM settings WHERE key = 'session_token'").get();
      expect(legacy).toBeNull();
      const active = db2
        .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'active_profile'")
        .get();
      expect(active!.value).toBe("default");
    } finally {
      db2.close();
    }

    // A second load reads purely from the migrated layout.
    expect(loadSession(DB_PATH)!.rawToken).toBe("legacy-tok");
  });
});
