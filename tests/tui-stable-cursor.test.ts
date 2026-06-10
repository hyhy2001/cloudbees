/**
 * Phase 3 step C — stable-cursor logic tests.
 *
 * resolveCursor is the pure core of useStableCursor: given a new key list, the
 * previously-selected key, and the previous cursor index, it decides where the
 * cursor lands after a refresh / filter / sort. These tests pin the three rules:
 * follow the key, hold position when the key vanished, reset on empty.
 */

import { describe, test, expect } from "bun:test";
import { resolveCursor } from "../src/core/tui/data/use-stable-cursor";

describe("resolveCursor — follow selected key", () => {
  test("selection follows its key to a new index after reorder", () => {
    const before = ["a", "b", "c"];
    const after = ["c", "a", "b"]; // 'b' moved from index 1 → 2
    // was on 'b' at index 1
    expect(resolveCursor(after, before[1], 1)).toBe(2);
  });

  test("selection stays put when order is unchanged", () => {
    const keys = ["a", "b", "c"];
    expect(resolveCursor(keys, "b", 1)).toBe(1);
  });

  test("selection follows when rows are inserted above it", () => {
    const after = ["new1", "new2", "a", "b"];
    expect(resolveCursor(after, "b", 1)).toBe(3);
  });
});

describe("resolveCursor — selected key gone", () => {
  test("holds the same position, clamped", () => {
    const after = ["a", "b", "c"]; // 'x' was deleted
    expect(resolveCursor(after, "x", 1)).toBe(1);
  });

  test("clamps to last row when position now out of range", () => {
    const after = ["a", "b"]; // list shrank; cursor was at 4
    expect(resolveCursor(after, "gone", 4)).toBe(1);
  });

  test("clamps a negative previous cursor to 0", () => {
    expect(resolveCursor(["a", "b"], "gone", -3)).toBe(0);
  });
});

describe("resolveCursor — empty list", () => {
  test("returns 0 when there are no rows", () => {
    expect(resolveCursor([], "anything", 5)).toBe(0);
  });
});

describe("resolveCursor — no prior selection", () => {
  test("undefined prevKey holds the clamped position", () => {
    expect(resolveCursor(["a", "b", "c"], undefined, 2)).toBe(2);
  });

  test("undefined prevKey with out-of-range cursor clamps", () => {
    expect(resolveCursor(["a", "b"], undefined, 9)).toBe(1);
  });
});
