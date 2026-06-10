/**
 * Unit tests for TUI symbol set (Unicode ↔ ASCII switching).
 * Ports the behaviour contract of legacy/cb/tui/compat.py.
 */

import { describe, test, expect } from "bun:test";
import { makeSymbols } from "../src/core/tui/symbols";

describe("makeSymbols", () => {
  test("unicode mode returns Unicode glyphs", () => {
    const s = makeSymbols(true);
    expect(s.ok).toBe("✓");
    expect(s.fail).toBe("✗");
    expect(s.running).toBe("●");
    expect(s.online).toBe("◉");
    expect(s.bee).toBe("🐝");
  });

  test("ascii mode returns 7-bit-safe fallbacks", () => {
    const s = makeSymbols(false);
    expect(s.ok).toBe("[OK]");
    expect(s.fail).toBe("[!!]");
    expect(s.running).toBe("[>>]");
    expect(s.online).toBe("[O]");
    expect(s.bee).toBe("bee");
  });

  test("unicode spinner has 10 frames, ascii has 4", () => {
    expect(makeSymbols(true).spinnerFrames).toHaveLength(10);
    expect(makeSymbols(false).spinnerFrames).toHaveLength(4);
  });

  test("ascii symbols are pure 7-bit ASCII", () => {
    const ascii = makeSymbols(false);
    for (const value of Object.values(ascii)) {
      const frames = Array.isArray(value) ? value : [value];
      for (const frame of frames) {
        expect(/^[\x00-\x7F]*$/.test(frame)).toBe(true);
      }
    }
  });

  test("the two exported sets have identical keys", () => {
    expect(Object.keys(makeSymbols(true)).sort()).toEqual(Object.keys(makeSymbols(false)).sort());
  });
});
