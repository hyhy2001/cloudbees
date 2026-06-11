/**
 * Mine/All scope persistence — default-true + round-trip per resource type.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bee-scope-test-"));
const DB_PATH = join(TMP_DIR, "test.db");

import { initDb } from "../src/core/db/connection";
import { getScopeShowAll, setScopeShowAll } from "../src/core/db/repositories/scope-repo";

beforeAll(() => initDb(DB_PATH));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe("scope-repo", () => {
  test("defaults to true (All) when unset", () => {
    expect(getScopeShowAll("job", DB_PATH)).toBe(true);
  });

  test("round-trips false then true", () => {
    setScopeShowAll("node", false, DB_PATH);
    expect(getScopeShowAll("node", DB_PATH)).toBe(false);
    setScopeShowAll("node", true, DB_PATH);
    expect(getScopeShowAll("node", DB_PATH)).toBe(true);
  });

  test("is keyed per resource type", () => {
    setScopeShowAll("credential", false, DB_PATH);
    expect(getScopeShowAll("credential", DB_PATH)).toBe(false);
    // a different type is unaffected (still default/true)
    expect(getScopeShowAll("job", DB_PATH)).toBe(true);
  });
});
