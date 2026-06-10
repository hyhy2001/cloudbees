/**
 * useStableCursor — keep the cursor on the same logical row across refreshes.
 *
 *   useResource() ─► useView() ─► useStableCursor() ─► DataTable
 *
 * Legacy tracked the cursor by integer index. On every refresh the table was
 * cleared and rebuilt, so the cursor stayed on the same *position* even though
 * the row under it had changed (or vanished) — the "where did my selection go?"
 * problem behind P12. useStableCursor tracks the selected row's stable KEY and
 * re-derives the index whenever the visible key list changes:
 *
 *  - selected key still present  → cursor follows it to its new index
 *  - selected key gone           → cursor stays at the same position, clamped
 *  - list empty                  → cursor 0
 *
 * `resolveCursor` is the pure core (unit-tested directly); `useStableCursor` is
 * the React wrapper that remembers the selected key between renders.
 */

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Pure cursor resolution. Given the new key list, the key that was selected
 * before, and the previous cursor index, return the cursor index to use now.
 */
export function resolveCursor(
  keys: readonly string[],
  prevKey: string | undefined,
  prevCursor: number,
): number {
  if (keys.length === 0) return 0;
  if (prevKey !== undefined) {
    const idx = keys.indexOf(prevKey);
    if (idx >= 0) return idx; // selection followed to its new position
  }
  // Selection gone (or none yet): hold the position, clamped into range.
  return Math.max(0, Math.min(prevCursor, keys.length - 1));
}

export interface StableCursor {
  /** Current cursor index into the key list. */
  cursor: number;
  /** Move the cursor (the screen wires this to DataTable's onCursorChange). */
  setCursor: (index: number) => void;
  /** Key of the currently selected row, or undefined when the list is empty. */
  selectedKey: string | undefined;
}

/**
 * React wrapper. Pass the current ordered key list (derived from the view rows).
 * The cursor index is kept in state; when `keys` changes we re-resolve it from
 * the remembered selected key so the selection survives refreshes and reorders.
 */
export function useStableCursor(keys: readonly string[]): StableCursor {
  const [cursor, setCursorState] = useState(0);
  // The key the cursor pointed at after the last settled render.
  const selectedKeyRef = useRef<string | undefined>(keys[0]);

  // Re-resolve whenever the key list identity changes (refresh / filter / sort).
  useEffect(() => {
    const next = resolveCursor(keys, selectedKeyRef.current, cursor);
    selectedKeyRef.current = keys[next];
    if (next !== cursor) setCursorState(next);
    // Only react to key-list changes, not to every cursor tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  const setCursor = useCallback(
    (index: number) => {
      const clamped = keys.length === 0 ? 0 : Math.max(0, Math.min(index, keys.length - 1));
      selectedKeyRef.current = keys[clamped];
      setCursorState(clamped);
    },
    [keys],
  );

  return { cursor, setCursor, selectedKey: selectedKeyRef.current };
}
