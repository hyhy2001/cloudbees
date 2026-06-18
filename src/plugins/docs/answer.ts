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

// ─── Provider contract ──────────────────────────────────────────────────────

/**
 * A configured language-model backend.
 *
 * `generate(prompt)` receives the full assembled prompt string and must return
 * the model's response text. Throw on hard errors (auth, network); return a
 * string on success (even if the model says "I don't know").
 *
 * `name` is displayed in the `--json` output so users can see which backend
 * is active.
 */
export interface LMProvider {
  readonly name: string;
  generate(prompt: string): Promise<string>;
}

// ─── Active provider registry ──────────────────────────────────────────────

let _provider: LMProvider | null = null;

/** Register the active LM provider. Call once during plugin/app startup. */
export function setProvider(p: LMProvider | null): void {
  _provider = p;
}

/** Return the active provider, or null when none is configured. */
export function getProvider(): LMProvider | null {
  return _provider;
}

// ─── Answer result ──────────────────────────────────────────────────────────

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
}

// ─── Orchestration ──────────────────────────────────────────────────────────

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
  const hits = searchDocs(query, corpus, limit, { gate: true, softGate: true });
  const provider = getProvider();

  if (!provider || hits.length === 0) {
    return { source: "raw", text: "", hits };
  }

  const prompt = buildUserPrompt(query, hits);
  try {
    const text = await provider.generate(prompt);
    return { source: "lm", text, hits, provider: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bee ask] LM error (${provider.name}): ${msg}\n`);
    return { source: "raw", text: "", hits };
  }
}
