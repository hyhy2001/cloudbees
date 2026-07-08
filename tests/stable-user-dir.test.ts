/**
 * Regression: the data-dir key must NOT depend on $USER.
 *
 * Bug: bee is a Bun binary and os.userInfo().username reads $USER, so an
 * RX AUTO / LSF wrapper that exports USER=<some-account> flipped the session
 * DB to data/<account>/ mid-run -> empty db -> "AUTH ERROR: Not logged in".
 * stableUserDir() keys on the real uid instead, which env cannot spoof.
 */
import { describe, test, expect } from "bun:test";
import { stableUserDir } from "../src/core/db/connection";

describe("stableUserDir", () => {
  test("is identical regardless of $USER", () => {
    const orig = process.env.USER;
    try {
      process.env.USER = "root";
      const a = stableUserDir();
      process.env.USER = "namth_shura_vf"; // the value that used to break it
      const b = stableUserDir();
      expect(b).toBe(a);
    } finally {
      if (orig === undefined) delete process.env.USER;
      else process.env.USER = orig;
    }
  });

  test("is uid-based on platforms with getuid", () => {
    if (typeof process.getuid === "function") {
      expect(stableUserDir()).toBe(`uid-${process.getuid()}`);
    }
  });
});
