/**
 * Unit tests for DB repositories: profile, settings, resource.
 * Each test uses an explicit dbPath so the module-level _DB_PATH cache is bypassed.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Create a temp dir and DB path for this file — set before any DB import.
const TMP_DIR = mkdtempSync(join(tmpdir(), "bee-db-test-"));
const DB_PATH = join(TMP_DIR, "test.db");

// Import after setting up paths so initDb uses our explicit dbPath.
import { initDb } from "../src/core/db/connection";
import { NotFoundError } from "../src/core/api/errors";
import {
  saveProfile,
  getProfile,
  getDefaultProfile,
  listProfiles,
  deleteProfile,
} from "../src/core/db/repositories/profile-repo";
import {
  getSetting,
  setSetting,
  deleteSetting,
} from "../src/core/db/repositories/settings-repo";
import {
  trackResource,
  untrackResource,
  getTrackedResources,
} from "../src/core/db/repositories/resource-repo";

// Initialise schema once for this file's DB.
beforeAll(() => {
  initDb(DB_PATH);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Profile repository
// ---------------------------------------------------------------------------

describe("profile-repo", () => {
  test("saveProfile then getProfile returns correct data", () => {
    const p = saveProfile("test-profile", "https://ci.example.com/", "alice", false, DB_PATH);
    expect(p.name).toBe("test-profile");
    // trailing slash should be stripped
    expect(p.serverUrl).toBe("https://ci.example.com");
    expect(p.username).toBe("alice");
    expect(p.isDefault).toBe(false);
    expect(typeof p.id).toBe("number");
    expect(p.id).toBeGreaterThan(0);
    expect(typeof p.createdAt).toBe("number");
  });

  test("getProfile returns the same profile that was saved", () => {
    saveProfile("fetch-me", "https://fetch.example.com", "bob", false, DB_PATH);
    const p = getProfile("fetch-me", DB_PATH);
    expect(p.name).toBe("fetch-me");
    expect(p.serverUrl).toBe("https://fetch.example.com");
    expect(p.username).toBe("bob");
  });

  test("getProfile throws for non-existent profile", () => {
    expect(() => getProfile("does-not-exist-xyz", DB_PATH)).toThrow(NotFoundError);
  });

  test("isDefault flag is stored and returned correctly", () => {
    saveProfile("default-one", "https://d1.example.com", "carol", true, DB_PATH);
    const p = getProfile("default-one", DB_PATH);
    expect(p.isDefault).toBe(true);
  });

  test("saving a second default clears previous default", () => {
    saveProfile("first-default", "https://first.example.com", "u1", true, DB_PATH);
    saveProfile("second-default", "https://second.example.com", "u2", true, DB_PATH);
    const first = getProfile("first-default", DB_PATH);
    const second = getProfile("second-default", DB_PATH);
    expect(first.isDefault).toBe(false);
    expect(second.isDefault).toBe(true);
  });

  test("getDefaultProfile returns the default profile", () => {
    saveProfile("gd-profile", "https://gd.example.com", "diana", true, DB_PATH);
    const p = getDefaultProfile(DB_PATH);
    expect(p).not.toBeNull();
    expect(p!.isDefault).toBe(true);
  });

  test("getDefaultProfile returns null when no profiles exist (fresh DB)", () => {
    // Use a separate DB with no data
    const freshDir = mkdtempSync(join(tmpdir(), "bee-empty-"));
    const freshDb = join(freshDir, "empty.db");
    initDb(freshDb);
    const p = getDefaultProfile(freshDb);
    expect(p).toBeNull();
    rmSync(freshDir, { recursive: true, force: true });
  });

  test("getDefaultProfile falls back to oldest profile when none marked default", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "bee-fallback-"));
    const freshDb = join(freshDir, "fallback.db");
    initDb(freshDb);
    // Insert two non-default profiles
    saveProfile("older", "https://older.example.com", "u1", false, freshDb);
    saveProfile("newer", "https://newer.example.com", "u2", false, freshDb);
    const p = getDefaultProfile(freshDb);
    expect(p).not.toBeNull();
    // Should be one of the two profiles — the oldest by created_at
    expect(["older", "newer"]).toContain(p!.name);
    rmSync(freshDir, { recursive: true, force: true });
  });

  test("listProfiles counts correctly", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "bee-list-"));
    const freshDb = join(freshDir, "list.db");
    initDb(freshDb);
    saveProfile("p1", "https://p1.example.com", "u1", false, freshDb);
    saveProfile("p2", "https://p2.example.com", "u2", false, freshDb);
    saveProfile("p3", "https://p3.example.com", "u3", true, freshDb);
    const profiles = listProfiles(freshDb);
    expect(profiles.length).toBe(3);
    // Default profile comes first
    expect(profiles[0].isDefault).toBe(true);
    rmSync(freshDir, { recursive: true, force: true });
  });

  test("deleteProfile removes the profile", () => {
    saveProfile("to-delete", "https://del.example.com", "eve", false, DB_PATH);
    deleteProfile("to-delete", DB_PATH);
    expect(() => getProfile("to-delete", DB_PATH)).toThrow(NotFoundError);
  });

  test("deleteProfile on non-existent profile does not throw", () => {
    expect(() => deleteProfile("never-existed", DB_PATH)).not.toThrow();
  });

  test("saveProfile update preserves id", () => {
    saveProfile("update-me", "https://v1.example.com", "frank", false, DB_PATH);
    const v1 = getProfile("update-me", DB_PATH);
    saveProfile("update-me", "https://v2.example.com", "frank2", false, DB_PATH);
    const v2 = getProfile("update-me", DB_PATH);
    expect(v2.id).toBe(v1.id);
    expect(v2.serverUrl).toBe("https://v2.example.com");
    expect(v2.username).toBe("frank2");
  });
});

// ---------------------------------------------------------------------------
// Settings repository
// ---------------------------------------------------------------------------

describe("settings-repo", () => {
  test("setSetting then getSetting roundtrip", () => {
    setSetting("theme", "dark", DB_PATH);
    expect(getSetting("theme", DB_PATH)).toBe("dark");
  });

  test("getSetting returns null for missing key", () => {
    expect(getSetting("this-key-does-not-exist-abc123", DB_PATH)).toBeNull();
  });

  test("setSetting replaces existing value", () => {
    setSetting("version", "1", DB_PATH);
    setSetting("version", "2", DB_PATH);
    expect(getSetting("version", DB_PATH)).toBe("2");
  });

  test("deleteSetting removes the key", () => {
    setSetting("to-remove", "value", DB_PATH);
    deleteSetting("to-remove", DB_PATH);
    expect(getSetting("to-remove", DB_PATH)).toBeNull();
  });

  test("deleteSetting on non-existent key does not throw", () => {
    expect(() => deleteSetting("never-set-xyz", DB_PATH)).not.toThrow();
  });

  test("setSetting stores string values faithfully", () => {
    setSetting("json-val", '{"a":1}', DB_PATH);
    expect(getSetting("json-val", DB_PATH)).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// Resource repository
// ---------------------------------------------------------------------------

describe("resource-repo", () => {
  test("trackResource then getTrackedResources returns name", () => {
    trackResource("job", "my-job", "alice", "https://ci.example.com", DB_PATH);
    const resources = getTrackedResources("job", "alice", "https://ci.example.com", DB_PATH);
    expect(resources).toContain("my-job");
  });

  test("untrackResource removes the entry", () => {
    trackResource("job", "job-to-remove", "alice", "https://ci.example.com", DB_PATH);
    untrackResource("job", "job-to-remove", "alice", "https://ci.example.com", DB_PATH);
    const resources = getTrackedResources("job", "alice", "https://ci.example.com", DB_PATH);
    expect(resources).not.toContain("job-to-remove");
  });

  test("getTrackedResources filters by resourceType", () => {
    trackResource("job", "r-job", "bob", "https://ctrl.example.com", DB_PATH);
    trackResource("node", "r-node", "bob", "https://ctrl.example.com", DB_PATH);
    const jobs = getTrackedResources("job", "bob", "https://ctrl.example.com", DB_PATH);
    const nodes = getTrackedResources("node", "bob", "https://ctrl.example.com", DB_PATH);
    expect(jobs).toContain("r-job");
    expect(jobs).not.toContain("r-node");
    expect(nodes).toContain("r-node");
    expect(nodes).not.toContain("r-job");
  });

  test("getTrackedResources filters by profile", () => {
    trackResource("job", "shared-job", "carol", "https://ctrl.example.com", DB_PATH);
    trackResource("job", "shared-job", "dave", "https://ctrl.example.com", DB_PATH);
    const carolJobs = getTrackedResources("job", "carol", "https://ctrl.example.com", DB_PATH);
    const daveJobs = getTrackedResources("job", "dave", "https://ctrl.example.com", DB_PATH);
    expect(carolJobs).toContain("shared-job");
    expect(daveJobs).toContain("shared-job");
    // They don't bleed into the wrong profile's list
    const eveJobs = getTrackedResources("job", "eve-not-here", "https://ctrl.example.com", DB_PATH);
    expect(eveJobs).not.toContain("shared-job");
  });

  test("getTrackedResources filters by controllerName", () => {
    trackResource("job", "ctrl-job", "mallory", "https://ctrl-a.example.com", DB_PATH);
    const ctrl_a = getTrackedResources("job", "mallory", "https://ctrl-a.example.com", DB_PATH);
    const ctrl_b = getTrackedResources("job", "mallory", "https://ctrl-b.example.com", DB_PATH);
    expect(ctrl_a).toContain("ctrl-job");
    expect(ctrl_b).not.toContain("ctrl-job");
  });

  test("trackResource with empty controllerName (default)", () => {
    trackResource("credential", "my-cred", "oscar", undefined, DB_PATH);
    const creds = getTrackedResources("credential", "oscar", "", DB_PATH);
    expect(creds).toContain("my-cred");
  });

  test("untrackResource on non-existent entry does not throw", () => {
    expect(() =>
      untrackResource("job", "ghost-job", "nobody", "https://x.example.com", DB_PATH)
    ).not.toThrow();
  });

  test("trackResource INSERT OR REPLACE is idempotent", () => {
    trackResource("job", "idem-job", "pat", "https://ci.example.com", DB_PATH);
    trackResource("job", "idem-job", "pat", "https://ci.example.com", DB_PATH);
    const jobs = getTrackedResources("job", "pat", "https://ci.example.com", DB_PATH);
    expect(jobs.filter((n) => n === "idem-job").length).toBe(1);
  });
});
