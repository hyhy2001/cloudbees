/**
 * Declarative keymap for TUI screens.
 *
 *   bindings: KeyBinding[]  ─►  useKeymap(bindings, {isActive})  ─►  dispatch
 *                           └►  bindingsToHints(bindings)        ─►  StatusBar
 *
 * Why this exists: each screen used to hand-roll `useInput` + a `switch(input)`
 * AND hand-type its footer hint string ("r=run · s=stop…"). The two drifted
 * apart, nothing checked for key collisions, and adding a tab meant copying the
 * whole boilerplate. A binding pairs the key, its label (the hint), and its
 * action in one place, so the footer is *generated* from the same source that
 * dispatches — they can't disagree.
 *
 * The matching core (`normalizeKey`, `resolveBinding`) is pure and React-free so
 * it unit-tests without a TTY (same pattern as resolveCursor / nextInterval).
 * `useKeymap` is the thin Ink wrapper.
 */

import { useInput } from "ink";
import type { Key } from "ink";

/** Logical key groups — used to order/section hints in the footer and help. */
export type KeyGroup = "global" | "nav" | "action";

export interface KeyBinding {
  /**
   * Normalized key string this binding fires on. Examples:
   *   "r", "R", "Enter", "Esc", "ctrl+f", "?", "left", "tab", "shift+tab".
   * Must match what `normalizeKey` produces (see that function for the grammar).
   */
  key: string;
  /** Short verb shown in the footer hint (e.g. "run"). */
  label: string;
  /** The action to run when the key is pressed and `when` (if any) is true. */
  run: () => void;
  /**
   * Optional enable predicate. When it returns false the binding is inert AND
   * hidden from the footer (a disabled action shouldn't advertise itself).
   * Defaults to always-enabled.
   */
  when?: () => boolean;
  /** Hide from the footer even when enabled (e.g. nav keys shown elsewhere). */
  hidden?: boolean;
  /** Logical grouping for footer/help ordering. Defaults to "action". */
  group?: KeyGroup;
}

/** A footer hint derived from a binding. */
export interface KeyHint {
  key: string;
  label: string;
}

/**
 * Normalize Ink's (input, key) pair into a single canonical string.
 *
 * Grammar (modifiers prefixed, lowercased, then the base token):
 *   - ctrl:           "ctrl+<char>"      e.g. ctrl+f
 *   - named keys:     "Enter" | "Esc" | "tab" | "shift+tab" |
 *                     "up" | "down" | "left" | "right" |
 *                     "pageup" | "pagedown" | "backspace" | "delete"
 *   - printable char: the char verbatim (case-sensitive: "r" ≠ "R")
 *
 * Case matters for plain chars so we can distinguish `a` from `A`/`F` from `f`.
 * Named keys use fixed casing ("Enter", "Esc") matching how bindings declare them.
 */
export function normalizeKey(input: string, key: Key): string {
  // Modifier combos first (ctrl takes precedence; meta/alt not used here).
  if (key.ctrl && input) return `ctrl+${input.toLowerCase()}`;

  if (key.tab) return key.shift ? "shift+tab" : "tab";
  if (key.return) return "Enter";
  if (key.escape) return "Esc";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";

  // Plain printable character — case-sensitive.
  return input;
}

/**
 * Find the first enabled binding matching `pressed`. Returns null when nothing
 * matches or the matching binding is disabled by its `when` guard.
 *
 * First-match-wins: order your bindings most-specific first if keys overlap
 * (they shouldn't — see assertNoConflicts).
 */
export function resolveBinding(
  bindings: readonly KeyBinding[],
  pressed: string,
): KeyBinding | null {
  for (const b of bindings) {
    if (b.key !== pressed) continue;
    if (b.when && !b.when()) return null; // matched but disabled → swallow nothing
    return b;
  }
  return null;
}

/**
 * Derive footer hints: visible bindings (not hidden, currently enabled),
 * de-duplicated by key, preserving declaration order.
 */
export function bindingsToHints(bindings: readonly KeyBinding[]): KeyHint[] {
  const seen = new Set<string>();
  const hints: KeyHint[] = [];
  for (const b of bindings) {
    if (b.hidden) continue;
    if (b.when && !b.when()) continue;
    if (seen.has(b.key)) continue;
    seen.add(b.key);
    hints.push({ key: b.key, label: b.label });
  }
  return hints;
}

/**
 * Dev-time conflict check: returns the keys bound more than once (ignoring
 * `when`, since two bindings on the same key are a smell even if guarded).
 * Empty array means no conflicts. Tests assert this is empty per screen.
 */
export function findConflicts(bindings: readonly KeyBinding[]): string[] {
  const counts = new Map<string, number>();
  for (const b of bindings) counts.set(b.key, (counts.get(b.key) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

/**
 * React binding: attach a single `useInput` that dispatches through `bindings`.
 * Gated by `isActive` so inactive tabs / suspended shells receive nothing.
 */
export function useKeymap(
  bindings: readonly KeyBinding[],
  opts: { isActive: boolean },
): void {
  useInput(
    (input, key) => {
      const pressed = normalizeKey(input, key);
      const binding = resolveBinding(bindings, pressed);
      if (binding) binding.run();
    },
    { isActive: opts.isActive },
  );
}
