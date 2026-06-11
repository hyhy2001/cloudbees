/**
 * Local-filesystem path completion for FormModal `path` fields.
 *
 * The machine running bee browses its OWN filesystem here (the user chose
 * "duyệt path local"). For a remote SSH/JNLP agent the agent's Remote Dir lives
 * on a different host, so this is only literally correct when the agent shares
 * this machine — the field is labelled accordingly. Completion is a convenience,
 * not validation: the typed string is always what gets sent.
 *
 * Pure + sync (readdirSync) so it unit-tests without a TTY. Errors (missing dir,
 * permission denied) degrade to "no candidates" rather than throwing.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, basename, join, sep } from "node:path";

export interface PathCompletion {
  /** The value to put in the field (longest unambiguous prefix, or the value unchanged). */
  completed: string;
  /** Matching entries in the directory (basenames; dirs get a trailing sep). */
  candidates: string[];
}

/** Longest common prefix of a list of strings. */
function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** Append a trailing separator to a name when its full path is a directory. */
function withDirSlash(dir: string, name: string): string {
  try {
    return statSync(join(dir, name)).isDirectory() ? name + sep : name;
  } catch {
    return name;
  }
}

/**
 * Complete a partially-typed local path.
 *
 * - Splits the input into a directory part and a basename fragment.
 * - Lists the directory and keeps entries that start with the fragment.
 * - `completed` becomes <dir>/<longest-common-prefix>; on a single match that is
 *   a directory it gets a trailing separator so the next Tab descends into it.
 * - `candidates` are the matching basenames (dirs suffixed with the separator)
 *   for display as a hint.
 */
export function completePath(input: string): PathCompletion {
  const value = input ?? "";
  // Directory to list, and the fragment we're completing within it.
  const endsWithSep = value.endsWith("/") || value.endsWith(sep);
  const dir = value === "" ? "." : endsWithSep ? value : dirname(value) || ".";
  const frag = value === "" || endsWithSep ? "" : basename(value);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { completed: value, candidates: [] };
  }

  const matches = entries.filter((e) => e.startsWith(frag)).sort();
  if (matches.length === 0) return { completed: value, candidates: [] };

  const candidates = matches.map((m) => withDirSlash(dir, m));

  // Rebuild the directory prefix exactly as the user typed it (so "./" or a
  // trailing slash is preserved), then append the completed fragment.
  const dirPrefix = value === "" ? "" : endsWithSep ? value : value.slice(0, value.length - frag.length);

  if (matches.length === 1) {
    const only = matches[0]!;
    const slash = withDirSlash(dir, only).endsWith(sep) ? sep : "";
    return { completed: dirPrefix + only + slash, candidates };
  }

  const lcp = commonPrefix(matches);
  return { completed: dirPrefix + lcp, candidates };
}
