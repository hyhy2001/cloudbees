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
    .replace(ANSI_RE, "")
    .replace(/\r/g, "");
  if (normalized === "") return prev as string[];
  const incoming = normalized.split("\n");

  // Fast path: when prev is already at capacity and incoming fits in the tail,
  // avoid spreading the entire prev array. Instead slice off what we need to
  // drop and concat only the tail — one allocation instead of two.
  const total = prev.length + incoming.length;
  if (total <= max) {
    return prev.length === 0 ? incoming : (prev as string[]).concat(incoming);
  }
  // Need to trim. Drop from the front: keep the last `max` lines overall.
  const keep = max - incoming.length;
  const base = keep > 0 ? prev.slice(Math.max(0, prev.length - keep)) : [];
  return base.concat(incoming).slice(-max);
}

// Pre-compiled case-insensitive regexes avoid toUpperCase() allocation per line.
const RE_ERROR = /error|failed|failure|exception/i;
const RE_WARN = /warn/i;
const RE_SUCCESS = /success|finished|completed/i;

/**
 * Map a log line to a theme color by keyword scan, mirroring the
 * legacy priority order: error → warn → success → pipeline/shell → default.
 * Returns undefined for unstyled lines.
 */
export function colorForLine(line: string): string | undefined {
  if (RE_ERROR.test(line)) return THEME.error;
  if (RE_WARN.test(line)) return THEME.warning;
  if (RE_SUCCESS.test(line)) return THEME.success;
  if (line.includes("[Pipeline]") || line.startsWith("+")) return THEME.blue;
  return undefined;
}
