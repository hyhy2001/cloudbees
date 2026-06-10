/**
 * TUI color theme. Port of legacy/cb/tui/colors.py.
 *
 * The Python version used curses 256-color pair IDs. Ink takes color strings
 * (named or hex) directly on <Text color=...> / <Box>, so we expose semantic
 * colors as hex values matching the original 256-color palette.
 */

/** Semantic colors used across the TUI (hex, matching the curses 256 palette). */
export const THEME = {
  /** default text — xterm 252 (#d0d0d0) */
  normal: "#d0d0d0",
  /** header bar text — white */
  headerFg: "#ffffff",
  /** header bar bg — deep blue, xterm 24 (#005f87) */
  headerBg: "#005f87",
  /** cursor/selected row bg — teal, xterm 31 (#0087af) */
  selectedBg: "#0087af",
  selectedFg: "#ffffff",
  /** success — xterm 82 (#5fff00) */
  success: "#5fff00",
  /** error — xterm 196 (#ff0000) */
  error: "#ff0000",
  /** warning — xterm 220 (#ffd700) */
  warning: "#ffd700",
  /** dimmed text — xterm 244 (#808080) */
  dim: "#808080",
  /** active/amber accent — xterm 214 (#ffaf00) */
  active: "#ffaf00",
  /** key-hint cyan — xterm 39 (#00afff) */
  keyhint: "#00afff",
  /** job-type blue — xterm 39 */
  blue: "#00afff",
  /** job-type yellow / folder — xterm 220 */
  yellow: "#ffd700",
} as const;

export type ThemeColor = keyof typeof THEME;

/** Map a Jenkins job "color" string to a semantic theme color + short label. */
export function jobStatusColor(color: string): { color: string; label: string } {
  const base = color.replace("_anime", "");
  const map: Record<string, { color: string; label: string }> = {
    blue: { color: THEME.success, label: "OK" },
    red: { color: THEME.error, label: "FAIL" },
    yellow: { color: THEME.warning, label: "WARN" },
    aborted: { color: THEME.dim, label: "ABT" },
    notbuilt: { color: THEME.dim, label: "NEW" },
    disabled: { color: THEME.dim, label: "DIS" },
  };
  return map[base] ?? { color: THEME.dim, label: base.slice(0, 4) || "?" };
}
