/**
 * log-buffer — pure helpers for the streaming log viewer.
 *
 * Legacy wrote one cross-thread call per log line (P5): a 500-line chunk meant
 * 500 widget writes and 500 redraws. Here the viewer keeps an immutable line
 * array in React state and appends a whole chunk in a single update; these
 * helpers do the chunk-splitting, ring-buffer capping, and per-line coloring as
 * side-effect-free functions so they can be unit-tested without React or a TTY.
 */

import { THEME } from "../theme";

/** Hard cap on retained lines — a long build can stream indefinitely. */
export const DEFAULT_MAX_LINES = 2000;

/**
 * Append a freshly-fetched text chunk to the existing line array, returning a
 * NEW array capped to `max` lines (oldest dropped). Empty/`undefined` chunks
 * return the previous array unchanged (stable reference → no re-render).
 *
 * The chunk is split on "\n"; a trailing newline does not produce a spurious
 * empty last line.
 */
// Jenkins Console Notes: ESC[8m<base64 payload>ESC[0m — strip payload too, not just the codes.
const JENKINS_NOTE_RE = /\x1b\[8m[^\x1b]*\x1b\[0*m/g;
// Matches all standard ANSI/VT100 escape sequences (CSI, OSC, etc.)
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function appendChunk(
  prev: readonly string[],
  chunk: string | undefined,
  max: number = DEFAULT_MAX_LINES,
): string[] {
  if (!chunk) return prev as string[];
  // Drop a single trailing newline so we don't append an empty line each poll.
  const normalized = (chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk)
    .replace(JENKINS_NOTE_RE, "")
    .replace(ANSI_RE, "");
  if (normalized === "") return prev as string[];
  const incoming = normalized.split("\n");
  const merged = prev.length === 0 ? incoming : [...prev, ...incoming];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Map a log line to a theme color by keyword scan (uppercased), mirroring the
 * legacy priority order: error → warn → success → pipeline/shell → default.
 * Returns undefined for unstyled lines.
 */
export function colorForLine(line: string): string | undefined {
  const u = line.toUpperCase();
  if (
    u.includes("ERROR") ||
    u.includes("FAILED") ||
    u.includes("FAILURE") ||
    u.includes("EXCEPTION")
  )
    return THEME.error;
  if (u.includes("WARN")) return THEME.warning;
  if (u.includes("SUCCESS") || u.includes("FINISHED") || u.includes("COMPLETED"))
    return THEME.success;
  if (line.includes("[Pipeline]") || line.startsWith("+")) return THEME.blue;
  return undefined;
}
