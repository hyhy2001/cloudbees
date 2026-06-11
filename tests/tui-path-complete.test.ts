/**
 * Local path completion helper — completePath.
 * Uses a temp dir tree so completion is deterministic without a TTY.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, sep } from "path";
import { tmpdir } from "os";
import { completePath } from "../src/core/tui/data/path-complete";

let DIR: string;

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "bee-path-"));
  mkdirSync(join(DIR, "alpha"));
  mkdirSync(join(DIR, "alpine"));
  mkdirSync(join(DIR, "beta"));
  writeFileSync(join(DIR, "readme.txt"), "x");
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("completePath", () => {
  test("missing directory → no candidates, value unchanged", () => {
    const r = completePath("/no/such/path/xyz");
    expect(r.candidates).toEqual([]);
    expect(r.completed).toBe("/no/such/path/xyz");
  });

  test("unique prefix completes to the full name (file)", () => {
    const r = completePath(join(DIR, "read"));
    expect(r.completed).toBe(join(DIR, "readme.txt"));
    expect(r.candidates).toEqual(["readme.txt"]);
  });

  test("unique directory match gets a trailing separator", () => {
    const r = completePath(join(DIR, "bet"));
    expect(r.completed).toBe(join(DIR, "beta") + sep);
    expect(r.candidates).toEqual(["beta" + sep]);
  });

  test("ambiguous prefix completes to the longest common prefix", () => {
    const r = completePath(join(DIR, "alp"));
    // alpha + alpine → common prefix "alp"
    expect(r.completed).toBe(join(DIR, "alp"));
    expect(r.candidates.sort()).toEqual(["alpha" + sep, "alpine" + sep]);
  });

  test("trailing separator lists the whole directory", () => {
    const r = completePath(DIR + sep);
    expect(r.candidates.sort()).toEqual(
      ["alpha" + sep, "alpine" + sep, "beta" + sep, "readme.txt"].sort(),
    );
  });
});
