/**
 * Answer orchestration for `bee ask`.
 *
 * The layer has two jobs:
 *   1. Define the `LMProvider` interface — the single seam providers plug into.
 *   2. Run `answer()` — build the full-context prompt when an LM is configured,
 *      otherwise fall back to the offline ranked hits so `bee ask` stays useful
 *      with no network or no provider.
 */

import { buildUserPrompt } from "./context";
import { searchDocs, type DocItem } from "./corpus";

// --- Output hardening --------------------------------------------------------

/**
 * Defence-in-depth against fake commands in the LM answer.
 *
 * A small model, asked a broad question, sometimes lists plausible-but-
 * non-existent commands (`bee job start`, `bee list`). The relevance gate and
 * prompt grounding catch most of it, but not all, and this failure mode (a
 * confident wrong command the user will paste and run) is the worst kind.
 * Model-agnostic, so it holds regardless of which model or prompt is in use.
 *
 * Strips any backtick-wrapped `bee ...` span whose command path is not a real
 * command id in the corpus, then cleans up the ", " / "Use:" debris the removal
 * leaves behind. Real commands (including bare group names like `bee job` and
 * sub-commands like `bee job run`) are left untouched. Non-command spans (flags,
 * prose) are never touched.
 */
export function stripInventedCommands(text: string, corpus: DocItem[]): string {
  const valid = new Set<string>();
  for (const item of corpus) {
    if (item.type !== "command") continue;
    valid.add(item.id);
    // A bare group name (`bee job`) is valid when any command lives under it.
    const dot = item.id.indexOf(".");
    if (dot > 0) valid.add(item.id.slice(0, dot));
  }
  if (valid.size === 0) return text;

  const SENT = ""; // Private Use Area sentinel; never appears in model text
  const replaced = text.replace(/`([^`]*)`/g, (full, inner: string) => {
    // Command path: group + optional sub (2 levels is enough; a real 3-level
    // command like "bee job create freestyle" still matches at "job.create").
    const m = inner.match(/^\s*bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?/i);
    if (!m) return full; // not a bee-command span; leave alone
    const group = m[1]!.toLowerCase();
    const sub = m[2]?.toLowerCase();
    if (group === "ask" || group === "help") return full;
    const id = sub ? `${group}.${sub}` : group;
    return valid.has(id) ? full : SENT;
  });

  if (!replaced.includes(SENT)) return text; // nothing invented; return original

  return replaced
    .replace(/\s*,\s*/g, "") // ", <removed>"
    .replace(/\s*,\s*/g, "") // "<removed>, "
    .replace(/\s+and\s+/gi, "") // " and <removed>"
    .replace(/\s+and\s+/gi, "")
    .replace(//g, "") // any lone marker left
    .replace(/,\s*,/g, ",") // collapsed double commas
    .replace(/\s+([.,])/g, "$1") // space before punctuation
    .replace(/\bUse:\s*$/gim, "") // dangling "Use:" with nothing after
    .replace(/[ \t]{2,}/g, " ") // runs of spaces
    .replace(/[ \t]+$/gm, "") // trailing spaces per line
    .trim();
}

// --- Provider contract -------------------------------------------------------

/**
 * A configured language-model backend.
 *
 * `generate(prompt)` receives the full assembled prompt string and must return
 * the model's response text. Throw on hard errors (auth, network); return a
 * string on success (even if the model says "I don't know").
 *
 * `stream(prompt)` is optional — if implemented, the CLI renders the response
 * token-by-token as they arrive from the API. Falls back to `generate()` when
 * not available.
 *
 * `name` is displayed in the `--json` output so users can see which backend
 * is active.
 */
export interface LMProvider {
  readonly name: string;
  generate(prompt: string): Promise<string>;
  stream?(prompt: string): AsyncGenerator<string, void, unknown>;
}

// --- Active provider registry ------------------------------------------------

let _provider: LMProvider | null = null;

/** Register the active LM provider. Call once during plugin/app startup. */
export function setProvider(p: LMProvider | null): void {
  _provider = p;
}

/** Return the active provider, or null when none is configured. */
export function getProvider(): LMProvider | null {
  return _provider;
}

// --- Answer result -----------------------------------------------------------

export type AnswerSource = "lm" | "raw";

export interface AnswerResult {
  /** "lm" when a provider answered, "raw" when falling back to ranked hits */
  source: AnswerSource;
  /** Natural-language answer (lm) or empty string (raw — caller renders hits) */
  text: string;
  /** Ranked hits for fallback rendering / JSON output */
  hits: DocItem[];
  /** Provider name when source="lm", undefined otherwise */
  provider?: string;
  /** If true, use streamOutput() instead of reading text directly */
  stream?: boolean;
  /** Callback for streaming output — receives tokens as they arrive */
  streamOutput?: (write: (chunk: string) => void) => Promise<string>;
}

// --- Orchestration -----------------------------------------------------------

/**
 * Main entry point for `bee ask`.
 *
 * 1. Retrieve hits via BM25/FTS5 with synonym expansion and relevance gate.
 *    Empty result = off-domain query — present a safe no-result message.
 * 2. No provider → raw path (caller renders hits via the presenter).
 * 3. Provider set + non-empty hits → assemble a prompt from the top hits
 *    (not the whole corpus — tight grounding, no leakage) and ask the LM.
 * 4. On provider error, degrade gracefully to the BM25 hits.
 */
export async function answer(
  query: string,
  corpus: DocItem[],
  limit = 5,
): Promise<AnswerResult> {
  const provider = getProvider();
  // softGate rescues ungated hits when the relevance gate empties everything.
  // That is right for the raw fallback (keep `bee ask` useful with no LM), but
  // WRONG on the LM path: there an empty gate is the desired refusal signal —
  // feeding coincidental hits to the model produces confident hallucinations on
  // off-domain queries. So: soft gate only when there is no provider.
  const hits = searchDocs(query, corpus, limit, { gate: true, softGate: !provider });

  if (!provider || hits.length === 0) {
    return { source: "raw", text: "", hits };
  }

  // Estimate token count (conservative: ~3 chars/token for mixed text).
  // If context exceeds ~80% of a conservative 2048-token window, truncate
  // from the bottom (furthest from query).
  const MAX_INPUT_CHARS = 2048 * 3 * 0.8; // ~4915 chars
  let contextHits = hits;
  let prompt = buildUserPrompt(query, contextHits);
  if (prompt.length > MAX_INPUT_CHARS && hits.length > 1) {
    // Drop hits from the end until we fit, but keep at least 1.
    let trimIdx = hits.length - 1;
    while (trimIdx > 0 && prompt.length > MAX_INPUT_CHARS) {
      contextHits = hits.slice(0, trimIdx);
      prompt = buildUserPrompt(query, contextHits);
      trimIdx--;
    }
  }

  // Streaming path — caller (CLI) writes chunks as they arrive.
  const streamFn = provider.stream;
  if (streamFn) {
    return {
      source: "lm",
      text: "",
      hits,
      provider: provider.name,
      stream: true,
      streamOutput: async (write: (chunk: string) => void): Promise<string> => {
        const chunks: string[] = [];
        try {
          for await (const chunk of streamFn.call(provider, prompt)) {
            write(chunk);
            chunks.push(chunk);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[bee ask] LM stream error (${provider.name}): ${msg}\n`);
          write("\n");
        }
        const full = chunks.join("");
        return stripInventedCommands(full, corpus);
      },
    };
  }

  try {
    const raw = await provider.generate(prompt);
    const text = stripInventedCommands(raw, corpus);
    return { source: "lm", text, hits, provider: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bee ask] LM error (${provider.name}): ${msg}\n`);
    return { source: "raw", text: "", hits };
  }
}
