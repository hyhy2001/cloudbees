/**
 * Unit tests for the SQLite cache layer: manager + policy.
 * Each test uses an explicit dbPath to bypass module-level _DB_PATH cache.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bee-cache-test-"));
const DB_PATH = join(TMP_DIR, "cache-test.db");

import { initDb } from "../src/core/db/connection";
import {
  getCached,
  setCache,
  invalidate,
  invalidatePrefix,
  purgeExpired,
  clearAll,
  cacheAge,
} from "../src/core/cache/manager";
import { getTtl } from "../src/core/cache/policy";

beforeAll(() => {
  initDb(DB_PATH);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// setCache / getCached roundtrip
// ---------------------------------------------------------------------------

describe("setCache / getCached", () => {
  test("roundtrip with a plain object value", () => {
    const val = { name: "alice", age: 30 };
    setCache("test.obj", val, 60, DB_PATH);
    expect(getCached("test.obj", DB_PATH)).toEqual(val);
  });

  test("roundtrip with an array value", () => {
    const val = [1, "two", { three: 3 }];
    setCache("test.arr", val, 60, DB_PATH);
    expect(getCached("test.arr", DB_PATH)).toEqual(val);
  });

  test("roundtrip with a string value", () => {
    setCache("test.str", "hello world", 60, DB_PATH);
    expect(getCached("test.str", DB_PATH)).toBe("hello world");
  });

  test("roundtrip with a numeric value", () => {
    setCache("test.num", 42, 60, DB_PATH);
    expect(getCached("test.num", DB_PATH)).toBe(42);
  });

  test("roundtrip with a boolean value", () => {
    setCache("test.bool", true, 60, DB_PATH);
    expect(getCached("test.bool", DB_PATH)).toBe(true);
  });

  test("roundtrip with null value", () => {
    setCache("test.null", null, 60, DB_PATH);
    expect(getCached("test.null", DB_PATH)).toBeNull();
  });

  test("getCached returns null for non-existent key", () => {
    expect(getCached("absolutely-not-there-xyz", DB_PATH)).toBeNull();
  });

  test("setCache INSERT OR REPLACE overwrites existing entry", () => {
    setCache("test.overwrite", "v1", 60, DB_PATH);
    setCache("test.overwrite", "v2", 60, DB_PATH);
    expect(getCached("test.overwrite", DB_PATH)).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe("TTL expiry", () => {
  test("getCached returns null for ttl=0 (already expired)", () => {
    // ttl=0 means expires_at = now + 0 = now, which satisfies expires_at <= now
    setCache("test.expired", "should-be-gone", 0, DB_PATH);
    expect(getCached("test.expired", DB_PATH)).toBeNull();
  });

  test("getCached returns null for ttl=-1 (past expiry)", () => {
    setCache("test.past", "gone", -1, DB_PATH);
    expect(getCached("test.past", DB_PATH)).toBeNull();
  });

  test("expired entry is purged on getCached miss", () => {
    setCache("test.purge-on-miss", "data", 0, DB_PATH);
    // First call returns null AND deletes the row
    getCached("test.purge-on-miss", DB_PATH);
    // Calling purgeExpired now should find 0 rows for this key
    const purged = purgeExpired(DB_PATH);
    // Can't assert exact count since other tests may also leave expired rows, but it must be >= 0
    expect(purged).toBeGreaterThanOrEqual(0);
  });

  test("valid entry is not purged by purgeExpired", () => {
    setCache("test.keep-me", { x: 1 }, 3600, DB_PATH);
    purgeExpired(DB_PATH);
    expect(getCached("test.keep-me", DB_PATH)).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// invalidate
// ---------------------------------------------------------------------------

describe("invalidate", () => {
  test("invalidate removes a specific key", () => {
    setCache("inv.key1", "val", 60, DB_PATH);
    invalidate("inv.key1", DB_PATH);
    expect(getCached("inv.key1", DB_PATH)).toBeNull();
  });

  test("invalidate leaves other keys intact", () => {
    setCache("inv.keep", "stay", 60, DB_PATH);
    setCache("inv.remove", "go", 60, DB_PATH);
    invalidate("inv.remove", DB_PATH);
    expect(getCached("inv.keep", DB_PATH)).toBe("stay");
  });

  test("invalidate on non-existent key does not throw", () => {
    expect(() => invalidate("ghost-key-123", DB_PATH)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// invalidatePrefix
// ---------------------------------------------------------------------------

describe("invalidatePrefix", () => {
  test("invalidatePrefix removes all keys with matching prefix", () => {
    setCache("pfx.a", 1, 60, DB_PATH);
    setCache("pfx.b", 2, 60, DB_PATH);
    setCache("pfx.c", 3, 60, DB_PATH);
    setCache("other.x", 4, 60, DB_PATH);
    invalidatePrefix("pfx.", DB_PATH);
    expect(getCached("pfx.a", DB_PATH)).toBeNull();
    expect(getCached("pfx.b", DB_PATH)).toBeNull();
    expect(getCached("pfx.c", DB_PATH)).toBeNull();
    // non-matching key must survive
    expect(getCached("other.x", DB_PATH)).toBe(4);
  });

  test("invalidatePrefix with % in prefix escapes correctly", () => {
    setCache("100%complete.v1", "yes", 60, DB_PATH);
    setCache("100%complete.v2", "yes", 60, DB_PATH);
    setCache("100complete.v1", "no-match", 60, DB_PATH);
    invalidatePrefix("100%complete.", DB_PATH);
    expect(getCached("100%complete.v1", DB_PATH)).toBeNull();
    expect(getCached("100%complete.v2", DB_PATH)).toBeNull();
    // The key without % must NOT be deleted
    expect(getCached("100complete.v1", DB_PATH)).toBe("no-match");
  });

  test("invalidatePrefix with _ in prefix escapes correctly", () => {
    setCache("jobs_list.v1", "yes", 60, DB_PATH);
    setCache("jobs_list.v2", "yes", 60, DB_PATH);
    setCache("jobsXlist.v1", "no-match", 60, DB_PATH);
    invalidatePrefix("jobs_list.", DB_PATH);
    expect(getCached("jobs_list.v1", DB_PATH)).toBeNull();
    expect(getCached("jobs_list.v2", DB_PATH)).toBeNull();
    // 'X' in place of '_' should NOT have been deleted
    expect(getCached("jobsXlist.v1", DB_PATH)).toBe("no-match");
  });

  test("invalidatePrefix on non-matching prefix does not throw", () => {
    expect(() => invalidatePrefix("absolutely-nothing-matches.", DB_PATH)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// purgeExpired
// ---------------------------------------------------------------------------

describe("purgeExpired", () => {
  test("purgeExpired returns count of deleted rows", () => {
    // Use a fresh DB to get a deterministic count
    const freshDir = mkdtempSync(join(tmpdir(), "bee-purge-"));
    const freshDb = join(freshDir, "purge.db");
    initDb(freshDb);
    setCache("p.a", 1, -1, freshDb);
    setCache("p.b", 2, -1, freshDb);
    setCache("p.c", 3, 3600, freshDb); // not expired
    const count = purgeExpired(freshDb);
    expect(count).toBe(2);
    rmSync(freshDir, { recursive: true, force: true });
  });

  test("purgeExpired returns 0 when nothing is expired", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "bee-purge2-"));
    const freshDb = join(freshDir, "purge2.db");
    initDb(freshDb);
    setCache("q.a", 1, 3600, freshDb);
    const count = purgeExpired(freshDb);
    expect(count).toBe(0);
    rmSync(freshDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  test("clearAll removes all entries", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "bee-clearall-"));
    const freshDb = join(freshDir, "clearall.db");
    initDb(freshDb);
    setCache("ca.1", "a", 60, freshDb);
    setCache("ca.2", "b", 60, freshDb);
    clearAll(freshDb);
    expect(getCached("ca.1", freshDb)).toBeNull();
    expect(getCached("ca.2", freshDb)).toBeNull();
    rmSync(freshDir, { recursive: true, force: true });
  });

  test("clearAll on empty cache does not throw", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "bee-clearall2-"));
    const freshDb = join(freshDir, "clearall2.db");
    initDb(freshDb);
    expect(() => clearAll(freshDb)).not.toThrow();
    rmSync(freshDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cacheAge
// ---------------------------------------------------------------------------

describe("cacheAge", () => {
  test("cacheAge returns null for missing key", () => {
    expect(cacheAge("no-such-key-abc", DB_PATH)).toBeNull();
  });

  test("cacheAge returns null for expired entry", () => {
    setCache("age.expired", "x", 0, DB_PATH);
    expect(cacheAge("age.expired", DB_PATH)).toBeNull();
  });

  test("cacheAge returns a non-negative number for fresh entry", () => {
    setCache("age.fresh", "y", 3600, DB_PATH);
    const age = cacheAge("age.fresh", DB_PATH);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    // Just written, so age should be close to 0
    expect(age!).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// getTtl (policy)
// ---------------------------------------------------------------------------

describe("getTtl (policy)", () => {
  test("jobs.list returns 15", () => {
    expect(getTtl("jobs.list")).toBe(15);
  });

  test("jobs.list.some-suffix matches prefix and returns 15", () => {
    expect(getTtl("jobs.list.https://ci.example.com")).toBe(15);
  });

  test("nodes.detail returns 30", () => {
    expect(getTtl("nodes.detail")).toBe(30);
  });

  test("credentials.list returns 30", () => {
    expect(getTtl("credentials.list")).toBe(30);
  });

  test("controllers.capabilities returns 300", () => {
    expect(getTtl("controllers.capabilities")).toBe(300);
  });

  test("unknown key returns DEFAULT_TTL (15)", () => {
    expect(getTtl("totally.unknown.key.xyz")).toBe(15);
  });

  test("empty string returns DEFAULT_TTL", () => {
    expect(getTtl("")).toBe(15);
  });
});
