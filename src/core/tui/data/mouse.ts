/**
 * SGR mouse event parser for the TUI.
 *
 * When Ink renders with `experimental: true` and the terminal supports SGR
 * mouse mode (CSI ? 1006 h), mouse clicks arrive as:
 *   ESC [ < Cb ; Cx ; Cy M     (press)
 *   ESC [ < Cb ; Cx ; Cy m     (release)
 *
 * Cb = button code (0 = left, 1 = middle, 2 = right, 32+ = motion)
 * Cx = 1-based column, Cy = 1-based row
 */

export interface MouseClick {
  button: "left" | "middle" | "right";
  col: number; // 1-based
  row: number; // 1-based
}

const SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Try to parse an SGR mouse sequence from the start of a string.
 * Returns the parsed click and the remaining unprocessed text, or null.
 */
export function parseSgrMouse(input: string): { click: MouseClick; rest: string } | null {
  const m = input.match(SGR_RE);
  if (!m) return null;

  const btn = parseInt(m[1]!, 10);
  const cx = parseInt(m[2]!, 10);
  const cy = parseInt(m[3]!, 10);
  const isPress = m[4] === "M";

  if (!isPress) return null; // ignore release events

  // Button code: low 2 bits = 0 left, 1 middle, 2 right
  const button: MouseClick["button"] = (btn & 3) === 0 ? "left" : (btn & 3) === 1 ? "middle" : "right";
  const rawLen = m[0]!.length;

  return { click: { button, col: cx, row: cy }, rest: input.slice(rawLen) };
}
