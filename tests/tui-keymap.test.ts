/**
 * Keymap core tests (no React/TTY) — declarative key system.
 *
 * Covers normalizeKey for modifier/named/plain keys, resolveBinding first-match
 * + `when` gating, bindingsToHints filtering (hidden/disabled/dedup), and
 * findConflicts duplicate detection.
 */

import { describe, test, expect } from "bun:test";
import type { Key } from "ink";
import {
  normalizeKey,
  resolveBinding,
  bindingsToHints,
  findConflicts,
  type KeyBinding,
} from "../src/core/tui/keymap";

// Build an Ink Key with everything false, then override.
function k(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as Key;
}

describe("normalizeKey", () => {
  test("plain chars are case-sensitive verbatim", () => {
    expect(normalizeKey("r", k())).toBe("r");
    expect(normalizeKey("R", k())).toBe("R");
    expect(normalizeKey("F", k())).toBe("F");
  });

  test("ctrl combos lowercased", () => {
    expect(normalizeKey("f", k({ ctrl: true }))).toBe("ctrl+f");
    expect(normalizeKey("B", k({ ctrl: true }))).toBe("ctrl+b");
  });

  test("named keys", () => {
    expect(normalizeKey("", k({ return: true }))).toBe("Enter");
    expect(normalizeKey("", k({ escape: true }))).toBe("Esc");
    expect(normalizeKey("", k({ tab: true }))).toBe("tab");
    expect(normalizeKey("", k({ tab: true, shift: true }))).toBe("shift+tab");
    expect(normalizeKey("", k({ upArrow: true }))).toBe("up");
    expect(normalizeKey("", k({ downArrow: true }))).toBe("down");
    expect(normalizeKey("", k({ leftArrow: true }))).toBe("left");
    expect(normalizeKey("", k({ rightArrow: true }))).toBe("right");
  });

  test("ctrl takes precedence over a bare char", () => {
    // ctrl+f must NOT be read as plain "f"
    expect(normalizeKey("f", k({ ctrl: true }))).toBe("ctrl+f");
  });
});

describe("resolveBinding", () => {
  const calls: string[] = [];
  const bindings: KeyBinding[] = [
    { key: "r", label: "run", run: () => calls.push("run") },
    { key: "F", label: "auto", run: () => calls.push("auto") },
    { key: "d", label: "del", run: () => calls.push("del"), when: () => false },
  ];

  test("matches by exact normalized key", () => {
    expect(resolveBinding(bindings, "r")?.label).toBe("run");
    expect(resolveBinding(bindings, "F")?.label).toBe("auto");
  });

  test("F and ctrl+f do not collide", () => {
    expect(resolveBinding(bindings, "ctrl+f")).toBeNull();
    expect(resolveBinding(bindings, "F")?.label).toBe("auto");
  });

  test("disabled binding (when=false) resolves to null", () => {
    expect(resolveBinding(bindings, "d")).toBeNull();
  });

  test("unknown key resolves to null", () => {
    expect(resolveBinding(bindings, "z")).toBeNull();
  });
});

describe("bindingsToHints", () => {
  test("filters hidden and disabled, dedups, preserves order", () => {
    const bindings: KeyBinding[] = [
      { key: "r", label: "run", run: () => {} },
      { key: "j", label: "down", run: () => {}, hidden: true },
      { key: "d", label: "del", run: () => {}, when: () => false },
      { key: "a", label: "mine/all", run: () => {} },
      { key: "r", label: "dup", run: () => {} }, // duplicate key
    ];
    const hints = bindingsToHints(bindings);
    expect(hints).toEqual([
      { key: "r", label: "run" },
      { key: "a", label: "mine/all" },
    ]);
  });

  test("enabled when-guard is included", () => {
    const hints = bindingsToHints([
      { key: "s", label: "stop", run: () => {}, when: () => true },
    ]);
    expect(hints).toEqual([{ key: "s", label: "stop" }]);
  });
});

describe("findConflicts", () => {
  test("reports keys bound more than once", () => {
    const conflicts = findConflicts([
      { key: "r", label: "run", run: () => {} },
      { key: "r", label: "again", run: () => {} },
      { key: "a", label: "all", run: () => {} },
    ]);
    expect(conflicts).toEqual(["r"]);
  });

  test("clean keymap reports nothing", () => {
    expect(
      findConflicts([
        { key: "r", label: "run", run: () => {} },
        { key: "a", label: "all", run: () => {} },
      ]),
    ).toEqual([]);
  });
});
